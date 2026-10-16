/**
 * Admin Walkthrough Builder: the editor hub. One walkthrough's chapters, steps,
 * audience and behaviour, kept in a single state object and saved over REST.
 */
( function () {
	'use strict';

	const cfg = window.awbEditor;
	if ( ! cfg || ! window.fetch ) {
		return;
	}

	const i18n = cfg.i18n || {};
	const screens = Array.isArray( cfg.screens ) ? cfg.screens : [];
	const roles = Array.isArray( cfg.roles ) ? cfg.roles : [];

	const MAX_CHAPTERS = 50;
	const MAX_DAYS = 365;
	const SEARCH_DELAY = 300;
	const ID_PATTERN = /^[cs]_[a-z0-9]{4,12}$/;
	const PLACEMENTS = [ 'auto', 'top', 'bottom', 'left', 'right' ];
	const ADVANCES = [ 'next', 'click' ];
	const BOOL_SETTINGS = [
		'auto_start',
		'allow_skip',
		'allow_exit',
		'allow_replay',
	];
	const DEFAULT_SETTINGS = {
		roles: [],
		users: [],
		auto_start: true,
		allow_skip: true,
		allow_exit: true,
		allow_replay: true,
		refresh_days: 0,
		bar_position: 'top',
	};
	const STEP_DEFAULTS = {
		id: '',
		chapter: '',
		title: '',
		content: '',
		url: 'index.php',
		screen: '',
		selector: '',
		label: '',
		placement: 'auto',
		advance: 'next',
	};

	// Nonces and one-off notices would make the builder land on a stale or odd screen.
	const VOLATILE_PARAMS = [
		'_wpnonce',
		'_wp_http_referer',
		'message',
		'updated',
		'settings-updated',
		'deleted',
		'trashed',
		'untrashed',
		'ids',
		'locked',
	];

	// The wp/v2 routes share the same REST root, just without my namespace.
	const wpRestRoot = String( cfg.root || '' ).replace(
		/admin-walkthrough-builder\/v1\/?$/,
		''
	);

	let root = null;
	let tour = null;
	let dirty = false;
	let revision = 0;
	let saving = null;
	let leaving = false;
	let sortables = null;
	let dialogChapter = '';
	let dialogOpener = null;
	let dialogBusy = false;

	const ui = {};
	const openSteps = new Set();
	const people = new Map();
	const search = {
		timer: 0,
		ticket: 0,
		controller: null,
		results: [],
		active: -1,
	};

	/* ------------------------------------------------------------------ */
	/* Helpers                                                            */
	/* ------------------------------------------------------------------ */

	function t( key, fallback ) {
		return typeof i18n[ key ] === 'string' && i18n[ key ] !== ''
			? i18n[ key ]
			: fallback;
	}

	// Understands %s, %d and positional %1$s, like the PHP side's sprintf.
	function fmt( format, ...args ) {
		let next = 0;
		return String( format ).replace(
			/%(?:(\d+)\$)?[sd]/g,
			( match, position ) => {
				const value = position ? args[ position - 1 ] : args[ next++ ];
				return value === undefined ? '' : String( value );
			}
		);
	}

	function plural( count, key, one, many ) {
		return fmt(
			count === 1 ? t( key + 'One', one ) : t( key + 'Many', many ),
			count
		);
	}

	function str( value ) {
		return value === null || value === undefined ? '' : String( value );
	}

	const PROPS = [ 'value', 'checked', 'disabled', 'hidden', 'selected' ];

	function h( tag, props, children ) {
		const node = document.createElement( tag );

		Object.keys( props || {} ).forEach( ( key ) => {
			const value = props[ key ];
			if ( value === null || value === undefined || value === false ) {
				return;
			}
			if ( key === 'class' ) {
				node.className = value;
			} else if ( key === 'text' ) {
				node.textContent = value;
			} else if ( PROPS.indexOf( key ) >= 0 ) {
				node[ key ] = value;
			} else {
				node.setAttribute( key, value === true ? '' : String( value ) );
			}
		} );

		( children || [] ).forEach( ( child ) => {
			if ( child !== null && child !== undefined && child !== false ) {
				node.append( child );
			}
		} );

		return node;
	}

	function icon( name ) {
		return h( 'span', {
			class: 'dashicons dashicons-' + name,
			'aria-hidden': 'true',
		} );
	}

	function iconButton( action, key, iconName, label, disabled, extra ) {
		return h(
			'button',
			{
				type: 'button',
				class: 'button awb-icon-button' + ( extra ? ' ' + extra : '' ),
				'data-awb-action': action,
				'data-awb-key': key,
				'aria-label': label,
				title: label,
				disabled: !! disabled,
			},
			[ icon( iconName ) ]
		);
	}

	function clampDays( value ) {
		const days = parseInt( value, 10 );
		if ( isNaN( days ) || days < 0 ) {
			return 0;
		}
		return Math.min( days, MAX_DAYS );
	}

	function randomId( prefix ) {
		const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
		const bytes = new Uint8Array( 8 );

		if ( window.crypto && window.crypto.getRandomValues ) {
			window.crypto.getRandomValues( bytes );
		} else {
			for ( let i = 0; i < bytes.length; i++ ) {
				bytes[ i ] = Math.floor( Math.random() * 256 );
			}
		}

		let id = prefix + '_';
		bytes.forEach( ( byte ) => {
			id += chars[ byte % chars.length ];
		} );

		const taken =
			tour &&
			( tour.chapters.some( ( c ) => c.id === id ) ||
				tour.steps.some( ( s ) => s.id === id ) );

		return taken ? randomId( prefix ) : id;
	}

	function withParams( url, params ) {
		const hashAt = url.indexOf( '#' );
		const hash = hashAt >= 0 ? url.slice( hashAt ) : '';
		let base = hashAt >= 0 ? url.slice( 0, hashAt ) : url;

		const query = Object.keys( params )
			.map(
				( key ) =>
					encodeURIComponent( key ) +
					'=' +
					encodeURIComponent( params[ key ] )
			)
			.join( '&' );

		if ( ! query ) {
			return url;
		}

		if ( base.indexOf( '?' ) < 0 ) {
			base += '?';
		} else if ( ! /[?&]$/.test( base ) ) {
			base += '&';
		}

		return base + query + hash;
	}

	function post( path, body ) {
		return window.fetch( cfg.root + path, {
			method: 'POST',
			credentials: 'same-origin',
			headers: {
				'Content-Type': 'application/json',
				'X-WP-Nonce': cfg.nonce,
			},
			body: JSON.stringify( body || {} ),
		} );
	}

	async function readJson( response ) {
		try {
			return await response.json();
		} catch ( err ) {
			return null;
		}
	}

	function noticeNode( type, message ) {
		const dismiss = h(
			'button',
			{ type: 'button', class: 'notice-dismiss awb-notice__dismiss' },
			[
				h( 'span', {
					class: 'screen-reader-text',
					text: t( 'dismissNotice', 'Dismiss this notice.' ),
				} ),
			]
		);
		const node = h(
			'div',
			{
				class: `awb-notice awb-notice--${ type } notice notice-${ type } inline is-dismissible`,
				role: type === 'error' ? 'alert' : 'status',
			},
			[ h( 'p', { text: message } ), dismiss ]
		);

		dismiss.addEventListener( 'click', () => node.remove() );
		return node;
	}

	/* ------------------------------------------------------------------ */
	/* People tab: reset buttons                                          */
	/* ------------------------------------------------------------------ */

	function wireResets() {
		document.addEventListener( 'click', ( event ) => {
			const button =
				event.target.closest && event.target.closest( '[data-awb-reset]' );
			if ( ! button ) {
				return;
			}
			event.preventDefault();
			resetProgress( button );
		} );
	}

	async function resetProgress( button ) {
		if ( button.disabled || button.getAttribute( 'aria-busy' ) === 'true' ) {
			return;
		}

		const user = parseInt( button.getAttribute( 'data-awb-reset' ), 10 ) || 0;
		const id =
			parseInt( button.getAttribute( 'data-awb-tour' ), 10 ) ||
			( cfg.tour ? parseInt( cfg.tour.id, 10 ) : 0 );

		if ( ! id ) {
			return;
		}

		const question = user
			? t(
					'resetPersonConfirm',
					"Reset this person's progress? They'll start this walkthrough from the beginning next time."
			  )
			: t(
					'resetEveryoneConfirm',
					"Reset everyone's progress? Everybody will start this walkthrough from the beginning next time."
			  );

		if ( ! window.confirm( question ) ) {
			return;
		}

		button.disabled = true;
		button.setAttribute( 'aria-busy', 'true' );

		let response;
		try {
			response = await post( 'tours/' + id + '/reset', { user } );
		} catch ( err ) {
			resetFailed(
				button,
				t(
					'resetOffline',
					"Couldn't reach the server, so nothing was reset. Check your connection and try again."
				)
			);
			return;
		}

		if ( response.ok ) {
			window.location.reload();
			return;
		}

		const data = await readJson( response );
		resetFailed(
			button,
			fmt(
				t( 'resetFailed', "Couldn't reset progress: %s" ),
				data && data.message
					? data.message
					: fmt( t( 'errorStatus', 'error %d' ), response.status )
			)
		);
	}

	function resetFailed( button, message ) {
		button.disabled = false;
		button.removeAttribute( 'aria-busy' );

		const wrap = button.closest( '.awb-wrap, .wrap' ) || document.body;
		const old = wrap.querySelector( '.awb-notice--reset' );
		if ( old ) {
			old.remove();
		}

		const notice = noticeNode( 'error', message );
		notice.classList.add( 'awb-notice--reset' );

		const tabs = wrap.querySelector( '.nav-tab-wrapper' );
		if ( tabs ) {
			tabs.after( notice );
		} else {
			wrap.prepend( notice );
		}
	}

	/* ------------------------------------------------------------------ */
	/* State                                                              */
	/* ------------------------------------------------------------------ */

	function normalize( raw ) {
		const src = raw || {};
		const settings = Object.assign( {}, DEFAULT_SETTINGS, src.settings || {} );

		BOOL_SETTINGS.forEach( ( key ) => {
			settings[ key ] = !! settings[ key ];
		} );
		settings.roles = Array.isArray( settings.roles )
			? settings.roles.map( String )
			: [];
		settings.users = Array.isArray( settings.users )
			? settings.users
					.map( ( id ) => parseInt( id, 10 ) )
					.filter( ( id, i, all ) => id > 0 && all.indexOf( id ) === i )
			: [];
		settings.refresh_days = clampDays( settings.refresh_days );
		settings.bar_position =
			settings.bar_position === 'bottom' ? 'bottom' : 'top';

		const chapters = ( Array.isArray( src.chapters ) ? src.chapters : [] ).map(
			( chapter ) => ( {
				id: ID_PATTERN.test( chapter.id ) ? chapter.id : randomId( 'c' ),
				title: str( chapter.title ),
				description: str( chapter.description ),
			} )
		);

		if ( ! chapters.length ) {
			chapters.push( {
				id: randomId( 'c' ),
				title: t( 'defaultChapterTitle', 'Getting started' ),
				description: '',
			} );
		}

		const steps = ( Array.isArray( src.steps ) ? src.steps : [] ).map(
			( item ) => {
				const step = Object.assign( {}, STEP_DEFAULTS, item );
				[ 'id', 'chapter', 'title', 'content', 'url', 'screen', 'selector', 'label' ].forEach(
					( key ) => {
						step[ key ] = str( step[ key ] );
					}
				);
				if ( ! ID_PATTERN.test( step.id ) ) {
					step.id = randomId( 's' );
				}
				if ( PLACEMENTS.indexOf( step.placement ) < 0 ) {
					step.placement = 'auto';
				}
				if ( ADVANCES.indexOf( step.advance ) < 0 ) {
					step.advance = 'next';
				}
				return step;
			}
		);

		return {
			id: parseInt( src.id, 10 ) || 0,
			title: str( src.title ),
			description: str( src.description ),
			status: src.status === 'publish' ? 'publish' : 'draft',
			chapters,
			steps,
			settings,
			modified: src.modified || 0,
		};
	}

	// Steps stay grouped by chapter in chapter order (stable inside a chapter), same as the server.
	function regroup() {
		const order = new Map( tour.chapters.map( ( c, i ) => [ c.id, i ] ) );
		const first = tour.chapters[ 0 ].id;

		tour.steps.forEach( ( step ) => {
			if ( ! order.has( step.chapter ) ) {
				step.chapter = first;
			}
		} );

		tour.steps = tour.steps
			.map( ( step, index ) => ( { step, index } ) )
			.sort(
				( a, b ) =>
					order.get( a.step.chapter ) - order.get( b.step.chapter ) ||
					a.index - b.index
			)
			.map( ( item ) => item.step );
	}

	function payload() {
		return {
			title: tour.title,
			description: tour.description,
			status: tour.status,
			chapters: tour.chapters,
			steps: tour.steps,
			settings: tour.settings,
		};
	}

	function markDirty() {
		revision++;
		dirty = true;
		updateMeta();
	}

	function chapterById( id ) {
		return tour.chapters.find( ( c ) => c.id === id ) || null;
	}

	function stepById( id ) {
		return tour.steps.find( ( s ) => s.id === id ) || null;
	}

	function chapterOf( node ) {
		const card = node.closest( '.awb-chapter' );
		return card ? chapterById( card.getAttribute( 'data-chapter' ) ) : null;
	}

	function stepOf( node ) {
		const item = node.closest( '.awb-step' );
		return item ? stepById( item.getAttribute( 'data-step' ) ) : null;
	}

	function chapterName( chapter ) {
		return chapter && chapter.title.trim()
			? chapter.title.trim()
			: t( 'untitledChapter', 'Untitled chapter' );
	}

	function stepName( step ) {
		return step.title.trim() || t( 'untitledStep', 'Untitled step' );
	}

	function whereLabel( url ) {
		const match = screens.find( ( screen ) => screen.url === url );
		if ( ! match ) {
			return url || 'index.php';
		}
		return match.group && match.group !== match.label
			? match.group + ' › ' + match.label
			: match.label;
	}

	function buildModeUrl( path, chapterId ) {
		const chapter = chapterById( chapterId ) ? chapterId : tour.chapters[ 0 ].id;
		return withParams( cfg.adminUrl + path, {
			awb_build: tour.id,
			awb_chapter: chapter,
		} );
	}

	function previewUrl() {
		return tour.steps.length
			? withParams( cfg.adminUrl + tour.steps[ 0 ].url, {
					awb_preview: tour.id,
			  } )
			: '';
	}

	/* ------------------------------------------------------------------ */
	/* Pasted URLs                                                        */
	/* ------------------------------------------------------------------ */

	// Returns { url } with the admin-relative part, or { error }.
	function toAdminPath( raw ) {
		let value = str( raw ).trim();
		const notHere = {
			error: t( 'urlOtherSite', "That URL isn't in this site's wp-admin." ),
		};

		if ( ! value ) {
			return { error: t( 'urlEmpty', 'Paste a wp-admin URL first.' ) };
		}

		let absolute =
			/^[a-z][a-z0-9+.-]*:/i.test( value ) || value.indexOf( '//' ) === 0;

		// "example.com/wp-admin/…" without a scheme is still somebody's host.
		if (
			! absolute &&
			! /^wp-admin\//i.test( value ) &&
			( /^[^/?#]+\.[a-z]{2,}(:\d+)?\//i.test( value ) ||
				/^[^/?#][^?#]*?\/wp-admin\//i.test( value ) )
		) {
			value = '//' + value;
			absolute = true;
		}

		if ( absolute ) {
			let parsed;
			let admin;
			try {
				parsed = new URL( value, cfg.adminUrl );
				admin = new URL( cfg.adminUrl );
			} catch ( err ) {
				return {
					error: t( 'urlInvalid', "That doesn't look like a valid URL." ),
				};
			}

			if (
				( parsed.protocol !== 'http:' && parsed.protocol !== 'https:' ) ||
				parsed.host !== admin.host
			) {
				return notHere;
			}

			let path = parsed.pathname;
			if ( path + '/' === admin.pathname ) {
				path = admin.pathname;
			}
			if ( path.indexOf( admin.pathname ) !== 0 ) {
				return notHere;
			}

			value = path.slice( admin.pathname.length ) + parsed.search;
		}

		value = value.split( '#' )[ 0 ];

		const queryAt = value.indexOf( '?' );
		let path = queryAt >= 0 ? value.slice( 0, queryAt ) : value;
		let query = queryAt >= 0 ? value.slice( queryAt + 1 ) : '';

		path = path.replace( /^\/+/, '' ).replace( /^.*wp-admin\//i, '' );

		if ( query ) {
			const params = new URLSearchParams( query );
			const drop = [];
			params.forEach( ( v, key ) => {
				if (
					VOLATILE_PARAMS.indexOf( key ) >= 0 ||
					key.indexOf( 'awb_' ) === 0
				) {
					drop.push( key );
				}
			} );
			if ( drop.length ) {
				drop.forEach( ( key ) => params.delete( key ) );
				query = params.toString();
			}
		}

		path = path || 'index.php';
		return { url: query ? path + '?' + query : path };
	}

	/* ------------------------------------------------------------------ */
	/* Shell (built once)                                                 */
	/* ------------------------------------------------------------------ */

	function box( modifier, title, body ) {
		const titleId = 'awb-box-' + modifier;
		return h(
			'section',
			{ class: 'awb-box awb-box--' + modifier, 'aria-labelledby': titleId },
			[
				h( 'h2', { class: 'awb-box__title', id: titleId, text: title } ),
				h( 'div', { class: 'awb-box__body' }, body ),
			]
		);
	}

	function checkbox( props, label ) {
		return h( 'label', { class: 'awb-check' }, [
			h( 'input', Object.assign( { type: 'checkbox' }, props ) ),
			h( 'span', { class: 'awb-check__label', text: label } ),
		] );
	}

	function buildShell() {
		ui.notices = h( 'div', { class: 'awb-editor__notices' } );
		ui.live = h( 'div', {
			class: 'screen-reader-text awb-editor__live',
			'aria-live': 'polite',
		} );

		ui.title = h( 'input', {
			type: 'text',
			class: 'awb-editor__title',
			'data-awb-field': 'title',
			'data-awb-key': 'title',
			maxlength: 200,
			autocomplete: 'off',
			placeholder: t( 'titlePlaceholder', 'Walkthrough title' ),
			'aria-label': t( 'titleLabel', 'Walkthrough title' ),
		} );

		ui.desc = h( 'textarea', {
			class: 'awb-editor__desc',
			id: 'awb-editor-desc',
			rows: 2,
			'data-awb-field': 'description',
			'data-awb-key': 'description',
			placeholder: t(
				'descriptionPlaceholder',
				'A short description: what will people learn?'
			),
			'aria-label': t( 'descriptionLabel', 'Description' ),
			'aria-describedby': 'awb-editor-desc-hint',
		} );

		ui.chapters = h( 'div', { class: 'awb-chapters' } );

		ui.addChapter = h(
			'button',
			{
				type: 'button',
				class: 'button awb-editor__add-chapter',
				'data-awb-action': 'add-chapter',
				'data-awb-key': 'add-chapter',
			},
			[ icon( 'plus-alt2' ), ' ', t( 'addChapter', 'Add chapter' ) ]
		);

		const main = h( 'div', { class: 'awb-editor__main' }, [
			ui.title,
			ui.desc,
			h( 'p', {
				class: 'awb-editor__hint',
				id: 'awb-editor-desc-hint',
				text: t(
					'descriptionHint',
					'Shown in the Guides menu and when the walkthrough starts. Keep it short.'
				),
			} ),
			ui.chapters,
			ui.addChapter,
		] );

		const side = h( 'div', { class: 'awb-editor__side' }, [
			buildPublishBox(),
			buildAudienceBox(),
			buildBehaviourBox(),
		] );

		root.textContent = '';
		root.append( ui.notices, main, side, buildDialog(), ui.live );
	}

	function buildPublishBox() {
		ui.status = {
			draft: h( 'input', {
				type: 'radio',
				class: 'awb-toggle__input',
				name: 'awb-status',
				value: 'draft',
				'data-awb-field': 'status',
			} ),
			publish: h( 'input', {
				type: 'radio',
				class: 'awb-toggle__input',
				name: 'awb-status',
				value: 'publish',
				'data-awb-field': 'status',
			} ),
		};

		const toggle = h( 'fieldset', { class: 'awb-toggle' }, [
			h( 'legend', {
				class: 'screen-reader-text',
				text: t( 'statusLabel', 'Status' ),
			} ),
			h( 'label', { class: 'awb-toggle__option awb-toggle__option--draft' }, [
				ui.status.draft,
				h( 'span', {
					class: 'awb-toggle__label',
					text: t( 'statusDraft', 'Draft' ),
				} ),
			] ),
			h( 'label', { class: 'awb-toggle__option awb-toggle__option--live' }, [
				ui.status.publish,
				h( 'span', {
					class: 'awb-toggle__label',
					text: t( 'statusLive', 'Live' ),
				} ),
			] ),
		] );

		ui.preview = h( 'a', {
			class: 'button awb-publish__preview',
			target: '_blank',
			rel: 'noopener',
			'data-awb-action': 'preview',
			text: t( 'preview', 'Preview' ),
		} );

		ui.save = h( 'button', {
			type: 'button',
			class: 'button button-primary awb-publish__save',
			'data-awb-action': 'save',
			text: t( 'save', 'Save' ),
		} );

		ui.state = h( 'p', { class: 'awb-publish__state', 'aria-live': 'polite' } );
		ui.count = h( 'p', { class: 'awb-publish__count' } );

		return box( 'publish', t( 'publishBox', 'Publish' ), [
			toggle,
			h( 'div', { class: 'awb-publish__actions' }, [ ui.preview, ui.save ] ),
			ui.state,
			ui.count,
		] );
	}

	function buildAudienceBox() {
		ui.roles = roles.map( ( role ) =>
			checkbox(
				{ value: role.slug, 'data-awb-field': 'role' },
				role.label || role.slug
			)
		);

		const roleSet = h( 'fieldset', { class: 'awb-roles' }, [
			h( 'legend', {
				class: 'awb-box__label',
				text: t( 'rolesLabel', 'Roles' ),
			} ),
			...ui.roles,
		] );

		ui.nobody = h(
			'div',
			{
				class: 'awb-notice awb-notice--warning notice notice-warning inline',
				hidden: true,
			},
			[
				h( 'p', {
					text: t( 'nobodyWarning', 'Nobody will see this walkthrough yet.' ),
				} ),
			]
		);

		return box( 'audience', t( 'audienceBox', 'Who sees it' ), [
			roleSet,
			buildPeople(),
			ui.nobody,
		] );
	}

	function buildPeople() {
		ui.peopleInput = h( 'input', {
			type: 'search',
			id: 'awb-people-search',
			class: 'awb-people__search',
			role: 'combobox',
			autocomplete: 'off',
			'aria-autocomplete': 'list',
			'aria-expanded': 'false',
			'aria-controls': 'awb-people-results',
			placeholder: t( 'peopleSearchPlaceholder', 'Search by name or email…' ),
		} );

		ui.peopleResults = h( 'ul', {
			class: 'awb-people__results',
			id: 'awb-people-results',
			role: 'listbox',
			'aria-label': t( 'peopleResultsLabel', 'Matching people' ),
			hidden: true,
		} );

		ui.peopleStatus = h( 'p', {
			class: 'awb-people__status',
			'aria-live': 'polite',
			hidden: true,
		} );

		ui.chips = h( 'ul', {
			class: 'awb-chips',
			'aria-label': t( 'selectedPeopleLabel', 'Selected people' ),
		} );

		ui.peopleInput.addEventListener( 'input', queueSearch );
		ui.peopleInput.addEventListener( 'keydown', onPeopleKey );
		ui.peopleInput.addEventListener( 'blur', closeResults );

		// I keep focus in the search box so blur doesn't close the list mid-click.
		ui.peopleResults.addEventListener( 'mousedown', ( event ) =>
			event.preventDefault()
		);
		ui.peopleResults.addEventListener( 'click', ( event ) => {
			const option = event.target.closest( '.awb-people__result' );
			if ( option ) {
				pickPerson(
					search.results[ parseInt( option.getAttribute( 'data-index' ), 10 ) ]
				);
			}
		} );

		return h( 'div', { class: 'awb-people' }, [
			h( 'label', {
				class: 'awb-box__label',
				for: 'awb-people-search',
				text: t( 'peopleLabel', 'Specific people' ),
			} ),
			h( 'div', { class: 'awb-people__field' }, [
				ui.peopleInput,
				ui.peopleResults,
			] ),
			ui.peopleStatus,
			ui.chips,
		] );
	}

	function buildBehaviourBox() {
		const labels = {
			auto_start: t(
				'behaviourAutoStart',
				'Start automatically the first time they open the first screen'
			),
			allow_skip: t( 'behaviourAllowSkip', 'Let them skip ahead' ),
			allow_exit: t( 'behaviourAllowExit', 'Let them close it' ),
			allow_replay: t( 'behaviourAllowReplay', 'Allow replays' ),
		};

		ui.behaviour = {};
		const items = BOOL_SETTINGS.map( ( key ) => {
			const item = checkbox(
				{ 'data-awb-field': 'setting', 'data-setting': key },
				labels[ key ]
			);
			ui.behaviour[ key ] = item.querySelector( 'input' );
			return item;
		} );

		ui.refresh = h( 'input', {
			type: 'number',
			id: 'awb-refresh-days',
			class: 'small-text awb-refresh__input',
			min: 0,
			max: MAX_DAYS,
			step: 1,
			'data-awb-field': 'refresh_days',
			'aria-describedby': 'awb-refresh-hint',
		} );

		const refresh = h( 'div', { class: 'awb-refresh' }, [
			h( 'label', {
				class: 'awb-refresh__label',
				for: 'awb-refresh-days',
				text: t( 'refreshLabel', 'Offer a refresher after' ),
			} ),
			' ',
			ui.refresh,
			' ',
			h( 'span', { class: 'awb-refresh__unit', text: t( 'refreshUnit', 'days' ) } ),
			h( 'p', {
				class: 'awb-box__hint',
				id: 'awb-refresh-hint',
				text: t( 'refreshHint', '0 = never. Needs replays turned on.' ),
			} ),
		] );

		ui.bar = {
			top: h( 'input', {
				type: 'radio',
				name: 'awb-bar-position',
				value: 'top',
				'data-awb-field': 'bar_position',
			} ),
			bottom: h( 'input', {
				type: 'radio',
				name: 'awb-bar-position',
				value: 'bottom',
				'data-awb-field': 'bar_position',
			} ),
		};

		const position = h( 'fieldset', { class: 'awb-radios' }, [
			h( 'legend', {
				class: 'awb-box__label',
				text: t( 'barPositionLabel', 'Progress bar position' ),
			} ),
			h( 'label', { class: 'awb-check' }, [
				ui.bar.top,
				h( 'span', { class: 'awb-check__label', text: t( 'barTop', 'Top' ) } ),
			] ),
			h( 'label', { class: 'awb-check' }, [
				ui.bar.bottom,
				h( 'span', {
					class: 'awb-check__label',
					text: t( 'barBottom', 'Bottom' ),
				} ),
			] ),
		] );

		// The refresher only makes sense under "Allow replays", so it sits right after it.
		return box( 'behaviour', t( 'behaviourBox', 'Behaviour' ), [
			...items,
			refresh,
			position,
		] );
	}

	function buildDialog() {
		ui.dialogIntro = h( 'p', { class: 'awb-dialog__intro', id: 'awb-dialog-intro' } );

		ui.dialogSearch = h( 'input', {
			type: 'search',
			id: 'awb-dialog-search',
			class: 'awb-dialog__search',
			autocomplete: 'off',
			placeholder: t( 'searchScreensPlaceholder', 'Search screens…' ),
			'aria-controls': 'awb-dialog-list',
			hidden: ! screens.length,
		} );

		ui.dialogItems = [];
		const groups = new Map();
		screens.forEach( ( screen ) => {
			const name = screen.group || t( 'otherScreens', 'Other' );
			if ( ! groups.has( name ) ) {
				groups.set( name, [] );
			}
			groups.get( name ).push( screen );
		} );

		ui.dialogGroups = [];
		let groupIndex = 0;
		groups.forEach( ( list, name ) => {
			const headingId = 'awb-dialog-group-' + groupIndex++;
			const items = list.map( ( screen ) => {
				const item = h( 'li', { class: 'awb-dialog__entry' }, [
					h(
						'button',
						{
							type: 'button',
							class: 'awb-dialog__item',
							'data-awb-action': 'screen-pick',
							'data-url': screen.url,
						},
						[
							h( 'span', { class: 'awb-dialog__label', text: screen.label } ),
							h( 'span', { class: 'awb-dialog__item-url', text: screen.url } ),
						]
					),
				] );
				ui.dialogItems.push( {
					item,
					text: ( name + ' ' + screen.label + ' ' + screen.url ).toLowerCase(),
				} );
				return item;
			} );

			const group = h(
				'section',
				{ class: 'awb-dialog__group', 'aria-labelledby': headingId },
				[
					h( 'h3', {
						class: 'awb-dialog__group-title',
						id: headingId,
						text: name,
					} ),
					h( 'ul', { class: 'awb-dialog__items' }, items ),
				]
			);
			ui.dialogGroups.push( { group, items } );
		} );

		ui.dialogList = h(
			'div',
			{ class: 'awb-dialog__list', id: 'awb-dialog-list' },
			ui.dialogGroups.map( ( g ) => g.group )
		);

		ui.dialogEmpty = h( 'p', {
			class: 'awb-dialog__empty',
			hidden: true,
			text: t( 'noScreensMatch', 'No screens match your search.' ),
		} );

		ui.dialogUrl = h( 'input', {
			type: 'text',
			id: 'awb-dialog-url',
			class: 'regular-text awb-dialog__url-input',
			autocomplete: 'off',
			spellcheck: 'false',
			placeholder: 'edit.php?post_type=page',
			'aria-describedby': 'awb-dialog-url-error',
		} );

		ui.dialogError = h( 'p', {
			class: 'awb-dialog__url-error',
			id: 'awb-dialog-url-error',
			role: 'alert',
			hidden: true,
		} );

		const paste = h( 'form', { class: 'awb-dialog__url', novalidate: true }, [
			h( 'label', {
				class: 'awb-dialog__url-label',
				for: 'awb-dialog-url',
				text: t( 'pasteUrlLabel', 'or paste a wp-admin URL' ),
			} ),
			h( 'div', { class: 'awb-dialog__url-row' }, [
				ui.dialogUrl,
				h( 'button', {
					type: 'submit',
					class: 'button',
					text: t( 'openUrl', 'Open' ),
				} ),
			] ),
			ui.dialogError,
		] );

		// Clicks on the backdrop land on <dialog> itself; everything else sits in __inner.
		ui.dialog = h(
			'dialog',
			{
				class: 'awb-dialog',
				'aria-labelledby': 'awb-dialog-title',
				'aria-describedby': 'awb-dialog-intro',
			},
			[
				h( 'div', { class: 'awb-dialog__inner' }, [
					h( 'div', { class: 'awb-dialog__header' }, [
						h( 'h2', {
							class: 'awb-dialog__title',
							id: 'awb-dialog-title',
							text: t( 'dialogTitle', 'Add steps on a screen' ),
						} ),
						iconButton(
							'dialog-close',
							'dialog-close',
							'no-alt',
							t( 'close', 'Close' ),
							false,
							'awb-dialog__close'
						),
					] ),
					ui.dialogIntro,
					h( 'label', {
						class: 'screen-reader-text',
						for: 'awb-dialog-search',
						text: t( 'searchScreensLabel', 'Search screens' ),
					} ),
					ui.dialogSearch,
					ui.dialogList,
					ui.dialogEmpty,
					paste,
				] ),
			]
		);

		paste.addEventListener( 'submit', onPasteSubmit );
		ui.dialogSearch.addEventListener( 'input', filterScreens );
		ui.dialogSearch.addEventListener( 'keydown', onDialogSearchKey );
		ui.dialogList.addEventListener( 'keydown', onDialogListKey );
		ui.dialog.addEventListener( 'click', ( event ) => {
			if ( event.target === ui.dialog ) {
				closeDialog();
			}
		} );
		ui.dialog.addEventListener( 'close', onDialogClosed );

		return ui.dialog;
	}

	/* ------------------------------------------------------------------ */
	/* Rendering                                                          */
	/* ------------------------------------------------------------------ */

	function findKey( key ) {
		return root.querySelector(
			'[data-awb-key="' + window.CSS.escape( key ) + '"]'
		);
	}

	function focusKey( key, start, end ) {
		let node = findKey( key );

		// A move button that just became disabled hands focus to its sibling.
		if ( node && node.disabled ) {
			node =
				findKey(
					key.replace( /:(up|down)$/, ( m, dir ) =>
						dir === 'up' ? ':down' : ':up'
					)
				) || node;
		}

		if ( ! node || node.disabled ) {
			return;
		}

		node.focus();

		if ( typeof start === 'number' && typeof node.setSelectionRange === 'function' ) {
			try {
				node.setSelectionRange( start, end );
			} catch ( err ) {
				// Some input types don't do selections.
			}
		}
	}

	function keepFocus( render ) {
		const active = root.ownerDocument.activeElement;
		const key =
			active && root.contains( active )
				? active.getAttribute( 'data-awb-key' )
				: null;
		let start = null;
		let end = null;

		if ( key ) {
			try {
				start = active.selectionStart;
				end = active.selectionEnd;
			} catch ( err ) {
				start = null;
			}
		}

		render();

		if ( key ) {
			focusKey( key, start, end );
		}
	}

	function announce( message ) {
		ui.live.textContent = message;
	}

	function renderChapters() {
		keepFocus( () => {
			destroySortables();
			ui.chapters.textContent = '';

			let number = 0;
			const last = tour.chapters.length - 1;

			tour.chapters.forEach( ( chapter, index ) => {
				const steps = tour.steps.filter( ( s ) => s.chapter === chapter.id );
				const items = steps.map( ( step, i ) =>
					buildStep( step, ++number, {
						canUp: index > 0 || i > 0,
						canDown: index < last || i < steps.length - 1,
					} )
				);
				ui.chapters.append( buildChapter( chapter, index, items ) );
			} );

			initSortables();
		} );
	}

	function buildChapter( chapter, index, stepNodes ) {
		const n = index + 1;
		const key = 'chapter:' + chapter.id;
		const base = 'awb-chapter-' + chapter.id;
		const only = tour.chapters.length === 1;

		const head = h( 'div', { class: 'awb-chapter__head' }, [
			h( 'span', {
				class: 'awb-chapter__num',
				text: fmt( t( 'chapterNumber', 'Chapter %d' ), n ),
			} ),
			h( 'input', {
				type: 'text',
				id: base + '-title',
				class: 'awb-chapter__title',
				value: chapter.title,
				maxlength: 200,
				autocomplete: 'off',
				placeholder: t( 'chapterTitlePlaceholder', 'Chapter title' ),
				'aria-label': fmt( t( 'chapterTitleLabel', 'Chapter %d title' ), n ),
				'data-awb-field': 'chapter-title',
				'data-awb-key': key + ':title',
			} ),
			h( 'div', { class: 'awb-chapter__actions' }, [
				iconButton(
					'chapter-up',
					key + ':up',
					'arrow-up-alt2',
					fmt( t( 'moveChapterUp', 'Move chapter %d up' ), n ),
					index === 0
				),
				iconButton(
					'chapter-down',
					key + ':down',
					'arrow-down-alt2',
					fmt( t( 'moveChapterDown', 'Move chapter %d down' ), n ),
					index === tour.chapters.length - 1
				),
				iconButton(
					'chapter-delete',
					key + ':delete',
					'trash',
					only
						? t( 'lastChapter', 'A walkthrough needs at least one chapter' )
						: fmt( t( 'deleteChapter', 'Delete chapter %d' ), n ),
					only,
					'awb-icon-button--delete'
				),
			] ),
		] );

		const desc = h( 'textarea', {
			id: base + '-desc',
			class: 'awb-chapter__desc',
			rows: 2,
			value: chapter.description,
			placeholder: t(
				'chapterDescriptionPlaceholder',
				'What this chapter covers (optional)'
			),
			'aria-label': fmt(
				t( 'chapterDescriptionLabel', 'Chapter %d description' ),
				n
			),
			'aria-describedby': base + '-hint',
			'data-awb-field': 'chapter-description',
			'data-awb-key': key + ':desc',
		} );

		const hint = h( 'p', {
			class: 'awb-chapter__hint',
			id: base + '-hint',
			text: t(
				'chapterDescriptionHint',
				'Shown when people hover this chapter in the progress bar'
			),
		} );

		// The empty row stays inside the list so it's still a drop target with some height.
		const list = h(
			'ol',
			{
				class: 'awb-chapter__steps',
				'aria-label': fmt( t( 'chapterStepsLabel', 'Chapter %d steps' ), n ),
			},
			stepNodes.length
				? stepNodes
				: [
						h( 'li', {
							class: 'awb-chapter__empty',
							text: t(
								'chapterEmpty',
								'No steps yet — add some on a screen'
							),
						} ),
				  ]
		);

		const add = h(
			'button',
			{
				type: 'button',
				class: 'button awb-chapter__add',
				'data-awb-action': 'chapter-add-steps',
				'data-awb-key': key + ':add',
			},
			[ icon( 'plus-alt2' ), ' ', t( 'addStepsOnScreen', 'Add steps on a screen…' ) ]
		);

		return h(
			'section',
			{
				class: 'awb-chapter' + ( stepNodes.length ? '' : ' is-empty' ),
				'data-chapter': chapter.id,
				'aria-label': fmt( t( 'chapterNumber', 'Chapter %d' ), n ),
			},
			[ head, desc, hint, list, add ]
		);
	}

	function buildStep( step, number, moves ) {
		const key = 'step:' + step.id;
		const open = openSteps.has( step.id );
		const formId = 'awb-step-' + step.id + '-form';

		const item = h(
			'li',
			{ class: 'awb-step' + ( open ? ' is-open' : '' ), 'data-step': step.id },
			[
				h( 'div', { class: 'awb-step__row' }, [
					h(
						'span',
						{
							class: 'awb-step__handle',
							title: t( 'dragToReorder', 'Drag to reorder' ),
							'aria-hidden': 'true',
						},
						[ icon( 'menu' ) ]
					),
					h( 'span', { class: 'awb-step__num', text: String( number ) } ),
					h( 'div', { class: 'awb-step__info' }, [
						h( 'span', { class: 'awb-step__title' } ),
						h( 'span', { class: 'awb-step__where' } ),
					] ),
					h( 'span', { class: 'awb-step__badges' } ),
					h( 'div', { class: 'awb-step__actions' }, [
						iconButton(
							'step-up',
							key + ':up',
							'arrow-up-alt2',
							fmt( t( 'moveStepUp', 'Move step %d up' ), number ),
							! moves.canUp
						),
						iconButton(
							'step-down',
							key + ':down',
							'arrow-down-alt2',
							fmt( t( 'moveStepDown', 'Move step %d down' ), number ),
							! moves.canDown
						),
						h( 'button', {
							type: 'button',
							class: 'button button-small awb-step__edit',
							'data-awb-action': 'step-edit',
							'data-awb-key': key + ':edit',
							'aria-expanded': open ? 'true' : 'false',
							'aria-controls': formId,
							'aria-label': fmt( t( 'editStep', 'Edit step %d' ), number ),
							text: t( 'edit', 'Edit' ),
						} ),
						h( 'a', {
							class: 'button button-small awb-step__show',
							href: buildModeUrl( step.url, step.chapter ),
							'data-awb-action': 'step-show',
							'data-awb-key': key + ':show',
							'aria-label': fmt(
								t( 'showStepOnScreen', 'Show on screen: step %d' ),
								number
							),
							text: t( 'showOnScreen', 'Show on screen' ),
						} ),
						h( 'button', {
							type: 'button',
							class: 'button-link button-link-delete awb-step__delete',
							'data-awb-action': 'step-delete',
							'data-awb-key': key + ':delete',
							'aria-label': fmt( t( 'deleteStep', 'Delete step %d' ), number ),
							text: t( 'delete', 'Delete' ),
						} ),
					] ),
				] ),
				buildStepForm( step, formId, open ),
			]
		);

		fillStepSummary( item, step );
		return item;
	}

	function fillStepSummary( item, step ) {
		const title = item.querySelector( '.awb-step__title' );
		title.textContent = stepName( step );
		title.classList.toggle( 'is-untitled', ! step.title.trim() );

		const where = item.querySelector( '.awb-step__where' );
		const place = whereLabel( step.url );
		where.textContent = step.label
			? fmt( t( 'whereWithElement', '%1$s · “%2$s”' ), place, step.label )
			: place;
		where.title = step.url;

		const badges = item.querySelector( '.awb-step__badges' );
		badges.textContent = '';
		badges.append(
			h( 'span', {
				class:
					'awb-step__badge awb-step__badge--' +
					( step.selector ? 'element' : 'floating' ),
				title: step.selector || null,
				text: step.selector
					? t( 'badgeElement', 'Element' )
					: t( 'badgeFloating', 'Floating' ),
			} )
		);

		if ( step.selector && step.advance === 'click' ) {
			badges.append(
				h( 'span', {
					class: 'awb-step__badge awb-step__badge--click',
					text: t( 'badgeClick', 'Click to continue' ),
				} )
			);
		}
	}

	function buildStepForm( step, formId, open ) {
		const base = 'awb-step-' + step.id;
		const key = 'step:' + step.id;
		const floating = ! step.selector;

		const formatButton = ( format, label, content ) =>
			h(
				'button',
				{
					type: 'button',
					class: 'button button-small awb-step__format-btn',
					'data-awb-action': 'step-format',
					'data-format': format,
					'data-awb-key': key + ':format-' + format,
					'aria-label': label,
					title: label,
				},
				[ content ]
			);

		const placementLabels = {
			auto: t( 'placementAuto', 'Auto' ),
			top: t( 'placementTop', 'Top' ),
			bottom: t( 'placementBottom', 'Bottom' ),
			left: t( 'placementLeft', 'Left' ),
			right: t( 'placementRight', 'Right' ),
		};

		const advanceLabels = {
			next: t( 'advanceNext', 'They press Next' ),
			click: t( 'advanceClick', 'They click the highlighted element' ),
		};

		return h( 'div', { class: 'awb-step__form', id: formId, hidden: ! open }, [
			h( 'div', { class: 'awb-step__field' }, [
				h( 'label', { for: base + '-title', text: t( 'stepTitleLabel', 'Title' ) } ),
				h( 'input', {
					type: 'text',
					id: base + '-title',
					class: 'widefat',
					value: step.title,
					maxlength: 200,
					autocomplete: 'off',
					'data-awb-field': 'step-title',
					'data-awb-key': key + ':title',
				} ),
			] ),
			h( 'div', { class: 'awb-step__field' }, [
				h( 'label', { for: base + '-text', text: t( 'stepTextLabel', 'Text' ) } ),
				h(
					'div',
					{
						class: 'awb-step__format',
						role: 'group',
						'aria-label': t( 'formatting', 'Formatting' ),
					},
					[
						formatButton( 'bold', t( 'bold', 'Bold' ), h( 'strong', { text: 'B' } ) ),
						formatButton( 'italic', t( 'italic', 'Italic' ), h( 'em', { text: 'I' } ) ),
						formatButton( 'link', t( 'link', 'Link' ), icon( 'admin-links' ) ),
					]
				),
				h( 'textarea', {
					id: base + '-text',
					class: 'widefat',
					rows: 4,
					value: step.content,
					'data-awb-field': 'step-content',
					'data-awb-key': key + ':text',
				} ),
			] ),
			h( 'div', { class: 'awb-step__field', hidden: floating }, [
				h( 'label', {
					for: base + '-placement',
					text: t( 'placementLabel', 'Where the popup appears' ),
				} ),
				h(
					'select',
					{
						id: base + '-placement',
						'data-awb-field': 'step-placement',
						'data-awb-key': key + ':placement',
					},
					PLACEMENTS.map( ( value ) =>
						h( 'option', {
							value,
							text: placementLabels[ value ],
							selected: step.placement === value,
						} )
					)
				),
			] ),
			h( 'div', { class: 'awb-step__field', hidden: floating }, [
				h( 'label', {
					for: base + '-advance',
					text: t( 'advanceLabel', 'Moves on when' ),
				} ),
				h(
					'select',
					{
						id: base + '-advance',
						'data-awb-field': 'step-advance',
						'data-awb-key': key + ':advance',
					},
					ADVANCES.map( ( value ) =>
						h( 'option', {
							value,
							text: advanceLabels[ value ],
							selected: step.advance === value,
						} )
					)
				),
			] ),
			floating
				? h( 'p', {
						class: 'awb-step__note',
						text: t(
							'floatingNote',
							'Floating step: it shows in the middle of the screen with a Next button.'
						),
				  } )
				: null,
			h( 'div', { class: 'awb-step__form-actions' }, [
				h( 'button', {
					type: 'button',
					class: 'button button-small awb-step__done',
					'data-awb-action': 'step-edit',
					'data-awb-key': key + ':done',
					text: t( 'done', 'Done' ),
				} ),
			] ),
		] );
	}

	function syncValue( input, value ) {
		// Writing the same value would still jump the caret to the end.
		if ( input.value !== value ) {
			input.value = value;
		}
	}

	function syncFields() {
		const s = tour.settings;

		syncValue( ui.title, tour.title );
		syncValue( ui.desc, tour.description );

		ui.status.draft.checked = tour.status !== 'publish';
		ui.status.publish.checked = tour.status === 'publish';

		ui.roles.forEach( ( label ) => {
			const input = label.querySelector( 'input' );
			input.checked = s.roles.indexOf( input.value ) >= 0;
		} );

		BOOL_SETTINGS.forEach( ( key ) => {
			ui.behaviour[ key ].checked = !! s[ key ];
		} );

		if ( clampDays( ui.refresh.value ) !== s.refresh_days || ui.refresh.value === '' ) {
			ui.refresh.value = String( s.refresh_days );
		}

		ui.bar.top.checked = s.bar_position !== 'bottom';
		ui.bar.bottom.checked = s.bar_position === 'bottom';

		renderChips();
	}

	function updateMeta() {
		const stepCount = tour.steps.length;
		const chapterCount = tour.chapters.length;

		ui.count.textContent =
			plural( stepCount, 'stepCount', '%d step', '%d steps' ) +
			' · ' +
			plural( chapterCount, 'chapterCount', '%d chapter', '%d chapters' );

		if ( stepCount ) {
			ui.preview.href = previewUrl();
			ui.preview.classList.remove( 'disabled' );
			ui.preview.removeAttribute( 'aria-disabled' );
			ui.preview.removeAttribute( 'role' );
			ui.preview.removeAttribute( 'title' );
		} else {
			ui.preview.removeAttribute( 'href' );
			ui.preview.classList.add( 'disabled' );
			ui.preview.setAttribute( 'role', 'link' );
			ui.preview.setAttribute( 'aria-disabled', 'true' );
			ui.preview.title = t( 'previewNeedsSteps', 'Add a step to preview it' );
		}

		let state = 'saved';
		if ( saving ) {
			state = 'saving';
		} else if ( dirty ) {
			state = 'dirty';
		}

		// Only touching the live region when the state really changes, not per keystroke.
		if ( ui.state.getAttribute( 'data-state' ) !== state ) {
			ui.state.setAttribute( 'data-state', state );
			ui.state.className = 'awb-publish__state is-' + state;
			ui.state.textContent = {
				saving: t( 'saving', 'Saving…' ),
				dirty: t( 'unsavedChanges', 'Unsaved changes' ),
				saved: t( 'saved', 'Saved ✓' ),
			}[ state ];
		}

		root.classList.toggle( 'is-dirty', dirty );
		root.classList.toggle( 'is-saving', !! saving );
		ui.save.disabled = !! saving;

		ui.nobody.hidden =
			tour.settings.roles.length > 0 || tour.settings.users.length > 0;
		ui.refresh.disabled = ! tour.settings.allow_replay;
		ui.addChapter.disabled = chapterCount >= MAX_CHAPTERS;
	}

	/* ------------------------------------------------------------------ */
	/* Sorting                                                            */
	/* ------------------------------------------------------------------ */

	function initSortables() {
		const jq = window.jQuery;
		if ( ! jq || ! jq.fn || ! jq.fn.sortable ) {
			return;
		}

		sortables = jq( ui.chapters )
			.find( '.awb-chapter__steps' )
			.sortable( {
				items: '> .awb-step',
				handle: '.awb-step__handle',
				connectWith: '.awb-editor .awb-chapter__steps',
				placeholder: 'awb-step-placeholder',
				forcePlaceholderSize: true,
				tolerance: 'pointer',
				axis: 'y',
				start: () => root.classList.add( 'is-dragging' ),
				stop: () => {
					root.classList.remove( 'is-dragging' );
					onDrop();
				},
			} );
	}

	function destroySortables() {
		if ( sortables ) {
			sortables.sortable( 'destroy' );
			sortables = null;
		}
	}

	function orderSignature() {
		return tour.steps.map( ( s ) => s.chapter + ':' + s.id ).join( ',' );
	}

	function onDrop() {
		const before = orderSignature();
		const byId = new Map( tour.steps.map( ( s ) => [ s.id, s ] ) );
		const steps = [];

		ui.chapters.querySelectorAll( '.awb-chapter' ).forEach( ( card ) => {
			const chapterId = card.getAttribute( 'data-chapter' );
			card.querySelectorAll( '.awb-step' ).forEach( ( item ) => {
				const step = byId.get( item.getAttribute( 'data-step' ) );
				if ( step ) {
					step.chapter = chapterId;
					steps.push( step );
					byId.delete( step.id );
				}
			} );
		} );

		// Anything the DOM somehow lost keeps its place at the end rather than vanishing.
		byId.forEach( ( step ) => steps.push( step ) );
		tour.steps = steps;
		regroup();

		if ( orderSignature() === before ) {
			return;
		}

		markDirty();

		// jQuery UI is still unwinding its stop handler, so I rebuild on the next tick.
		setTimeout( renderChapters, 0 );
	}

	/* ------------------------------------------------------------------ */
	/* Field edits                                                        */
	/* ------------------------------------------------------------------ */

	function set( obj, key, value ) {
		if ( obj[ key ] === value ) {
			return false;
		}
		obj[ key ] = value;
		markDirty();
		return true;
	}

	function onField( event ) {
		const target = event.target;
		const field = target.getAttribute && target.getAttribute( 'data-awb-field' );
		if ( ! field ) {
			return;
		}

		// Checkboxes, radios and selects fire both events; I only want change for them.
		const choice =
			target.type === 'checkbox' ||
			target.type === 'radio' ||
			target.tagName === 'SELECT';
		if ( choice && event.type === 'input' ) {
			return;
		}

		const settings = tour.settings;
		const chapter = chapterOf( target );
		const step = stepOf( target );
		const item = target.closest( '.awb-step' );

		switch ( field ) {
			case 'title':
				set( tour, 'title', target.value );
				break;
			case 'description':
				set( tour, 'description', target.value );
				break;
			case 'chapter-title':
				if ( chapter ) {
					set( chapter, 'title', target.value );
				}
				break;
			case 'chapter-description':
				if ( chapter ) {
					set( chapter, 'description', target.value );
				}
				break;
			case 'step-title':
			case 'step-content':
			case 'step-placement':
			case 'step-advance':
				if ( step ) {
					set( step, field.slice( 5 ), target.value );
					fillStepSummary( item, step );
				}
				break;
			case 'status':
				if ( target.checked ) {
					set( tour, 'status', target.value === 'publish' ? 'publish' : 'draft' );
				}
				break;
			case 'role':
				settings.roles = ui.roles
					.map( ( label ) => label.querySelector( 'input' ) )
					.filter( ( input ) => input.checked )
					.map( ( input ) => input.value );
				markDirty();
				break;
			case 'setting':
				set( settings, target.getAttribute( 'data-setting' ), target.checked );
				break;
			case 'refresh_days': {
				const days = clampDays( target.value );
				if ( event.type === 'change' ) {
					target.value = String( days );
				}
				set( settings, 'refresh_days', days );
				break;
			}
			case 'bar_position':
				if ( target.checked ) {
					set( settings, 'bar_position', target.value === 'bottom' ? 'bottom' : 'top' );
				}
				break;
		}
	}

	function wrapSelection( area, before, after, fallback ) {
		const start = area.selectionStart;
		const end = area.selectionEnd;
		const value = area.value;
		const selected = value.slice( start, end ) || fallback || '';

		area.value = value.slice( 0, start ) + before + selected + after + value.slice( end );
		area.focus();
		area.setSelectionRange( start + before.length, start + before.length + selected.length );
		area.dispatchEvent( new Event( 'input', { bubbles: true } ) );
	}

	function formatText( button ) {
		const form = button.closest( '.awb-step__form' );
		const area = form && form.querySelector( '[data-awb-field="step-content"]' );
		if ( ! area ) {
			return;
		}

		const format = button.getAttribute( 'data-format' );

		if ( format === 'bold' ) {
			wrapSelection( area, '<strong>', '</strong>' );
		} else if ( format === 'italic' ) {
			wrapSelection( area, '<em>', '</em>' );
		} else if ( format === 'link' ) {
			const url = window.prompt( t( 'linkPrompt', 'Link address (URL)' ), 'https://' );
			if ( ! url || ! url.trim() || url.trim() === 'https://' ) {
				area.focus();
				return;
			}
			const href = url.trim().replace( /&/g, '&amp;' ).replace( /"/g, '&quot;' ).replace( /</g, '&lt;' );
			wrapSelection( area, '<a href="' + href + '">', '</a>', url.trim() );
		}
	}

	/* ------------------------------------------------------------------ */
	/* Structural actions                                                 */
	/* ------------------------------------------------------------------ */

	function addChapter() {
		if ( tour.chapters.length >= MAX_CHAPTERS ) {
			return;
		}

		const chapter = {
			id: randomId( 'c' ),
			title: fmt( t( 'newChapterTitle', 'Chapter %d' ), tour.chapters.length + 1 ),
			description: '',
		};

		tour.chapters.push( chapter );
		markDirty();
		renderChapters();

		const input = findKey( 'chapter:' + chapter.id + ':title' );
		if ( input ) {
			input.focus();
			input.select();
		}
		announce( t( 'chapterAdded', 'Chapter added.' ) );
	}

	function moveChapter( button, dir ) {
		const chapter = chapterOf( button );
		const index = tour.chapters.indexOf( chapter );
		const target = index + dir;

		if ( ! chapter || target < 0 || target >= tour.chapters.length ) {
			return;
		}

		tour.chapters[ index ] = tour.chapters[ target ];
		tour.chapters[ target ] = chapter;
		regroup();
		markDirty();
		renderChapters();
		announce( fmt( t( 'chapterMoved', 'Chapter moved to position %d.' ), target + 1 ) );
	}

	function deleteChapter( button ) {
		const chapter = chapterOf( button );
		if ( ! chapter || tour.chapters.length < 2 ) {
			return;
		}

		const index = tour.chapters.indexOf( chapter );
		const heir = tour.chapters[ index > 0 ? index - 1 : 1 ];
		const hasSteps = tour.steps.some( ( s ) => s.chapter === chapter.id );

		const question = hasSteps
			? fmt(
					t(
						'deleteChapterMoveConfirm',
						'Delete the chapter “%1$s”? Its steps will move to “%2$s”.'
					),
					chapterName( chapter ),
					chapterName( heir )
			  )
			: fmt( t( 'deleteChapterConfirm', 'Delete the chapter “%s”?' ), chapterName( chapter ) );

		if ( ! window.confirm( question ) ) {
			return;
		}

		tour.steps.forEach( ( step ) => {
			if ( step.chapter === chapter.id ) {
				step.chapter = heir.id;
			}
		} );
		tour.chapters.splice( index, 1 );
		regroup();
		markDirty();
		renderChapters();
		focusKey( 'chapter:' + heir.id + ':title' );
		announce( t( 'chapterDeleted', 'Chapter deleted.' ) );
	}

	function moveStep( button, dir ) {
		const step = stepOf( button );
		if ( ! step ) {
			return;
		}

		const index = tour.steps.indexOf( step );
		const neighbour = tour.steps[ index + dir ];

		if ( neighbour && neighbour.chapter === step.chapter ) {
			tour.steps[ index ] = neighbour;
			tour.steps[ index + dir ] = step;
		} else {
			// At a chapter edge I hop into the next/previous chapter; regroup puts it at the near end.
			const chapterIndex = tour.chapters.findIndex( ( c ) => c.id === step.chapter );
			const next = tour.chapters[ chapterIndex + dir ];
			if ( ! next ) {
				return;
			}
			step.chapter = next.id;
			regroup();
		}

		markDirty();
		renderChapters();

		const inChapter = tour.steps.filter( ( s ) => s.chapter === step.chapter );
		announce(
			fmt(
				t( 'stepMoved', 'Step moved to position %1$d in “%2$s”.' ),
				inChapter.indexOf( step ) + 1,
				chapterName( chapterById( step.chapter ) )
			)
		);
	}

	function deleteStep( button ) {
		const step = stepOf( button );
		if ( ! step ) {
			return;
		}

		const question = fmt( t( 'deleteStepConfirm', 'Delete the step “%s”?' ), stepName( step ) );
		if ( ! window.confirm( question ) ) {
			return;
		}

		tour.steps.splice( tour.steps.indexOf( step ), 1 );
		openSteps.delete( step.id );
		markDirty();
		renderChapters();
		focusKey( 'chapter:' + step.chapter + ':add' );
		announce( t( 'stepDeleted', 'Step deleted.' ) );
	}

	function toggleStep( button ) {
		const item = button.closest( '.awb-step' );
		if ( ! item ) {
			return;
		}

		const id = item.getAttribute( 'data-step' );
		const open = ! openSteps.has( id );
		const edit = item.querySelector( '.awb-step__edit' );

		if ( open ) {
			openSteps.add( id );
		} else {
			openSteps.delete( id );
		}

		item.classList.toggle( 'is-open', open );
		item.querySelector( '.awb-step__form' ).hidden = ! open;
		edit.setAttribute( 'aria-expanded', open ? 'true' : 'false' );

		if ( open ) {
			item.querySelector( '[data-awb-field="step-title"]' ).focus();
		} else {
			edit.focus();
		}
	}

	/* ------------------------------------------------------------------ */
	/* Saving & leaving                                                   */
	/* ------------------------------------------------------------------ */

	function showNotice( type, message ) {
		ui.notices.textContent = '';
		ui.notices.append( noticeNode( type, message ) );
	}

	function clearNotice() {
		ui.notices.textContent = '';
	}

	async function doSave() {
		const sent = revision;
		let response;

		try {
			response = await post( 'tours/' + tour.id, payload() );
		} catch ( err ) {
			showNotice(
				'error',
				t(
					'saveOffline',
					"Couldn't reach the server, so nothing was saved. Check your connection and try again."
				)
			);
			return false;
		}

		const data = await readJson( response );

		if ( ! response.ok || ! data || ! Array.isArray( data.chapters ) ) {
			showNotice(
				'error',
				fmt(
					t( 'saveFailed', "Couldn't save the walkthrough: %s" ),
					data && data.message
						? data.message
						: fmt( t( 'errorStatus', 'error %d' ), response.status )
				)
			);
			return false;
		}

		clearNotice();

		// If they kept typing while this was in flight, their newer edits win and stay unsaved.
		if ( revision === sent ) {
			tour = normalize( data );
			dirty = false;
			syncFields();
			renderChapters();
		}

		return true;
	}

	function save() {
		if ( saving ) {
			return saving.then( ( ok ) => ( ok && dirty ? save() : ok ) );
		}

		saving = doSave().finally( () => {
			saving = null;
			updateMeta();
		} );
		updateMeta();

		return saving;
	}

	// Before leaving the page, everything has to be on the server.
	async function saveFully() {
		for ( let attempt = 0; attempt < 3; attempt++ ) {
			if ( ! dirty && ! saving ) {
				return true;
			}
			const ok = await save();
			if ( ! ok ) {
				return false;
			}
		}
		return ! dirty;
	}

	async function go( makeUrl ) {
		if ( ! ( await saveFully() ) ) {
			return false;
		}
		leaving = true;
		window.location.href = makeUrl();
		return true;
	}

	function onShowStep( link, event ) {
		if ( ! dirty && ! saving ) {
			return;
		}
		event.preventDefault();

		const step = stepOf( link );
		if ( step ) {
			go( () => buildModeUrl( step.url, step.chapter ) );
		}
	}

	function onPreview( link, event ) {
		if ( ! tour.steps.length ) {
			event.preventDefault();
			return;
		}
		if ( ! dirty && ! saving ) {
			return;
		}

		// The preview tab reads the saved tour, so I save first and open it after.
		event.preventDefault();
		saveFully().then( ( ok ) => {
			if ( ok && tour.steps.length ) {
				window.open( previewUrl(), '_blank', 'noopener' );
			}
		} );
	}

	function onShortcut( event ) {
		if (
			( event.ctrlKey || event.metaKey ) &&
			! event.altKey &&
			! event.shiftKey &&
			( event.key === 's' || event.key === 'S' )
		) {
			event.preventDefault();
			save();
		}
	}

	function onBeforeUnload( event ) {
		if ( ! dirty || leaving ) {
			return;
		}
		event.preventDefault();
		event.returnValue = '';
	}

	/* ------------------------------------------------------------------ */
	/* Specific people                                                    */
	/* ------------------------------------------------------------------ */

	function safeAvatar( url ) {
		return /^(https?:)?\/\//i.test( str( url ) ) ? url : '';
	}

	function setPeopleStatus( message ) {
		ui.peopleStatus.textContent = message;
		ui.peopleStatus.hidden = ! message;
	}

	function cancelSearch() {
		clearTimeout( search.timer );
		search.ticket++;
		if ( search.controller ) {
			search.controller.abort();
			search.controller = null;
		}
	}

	function queueSearch() {
		const query = ui.peopleInput.value.trim();
		cancelSearch();

		if ( ! query ) {
			closeResults();
			setPeopleStatus( '' );
			return;
		}

		search.timer = setTimeout( () => runSearch( query ), SEARCH_DELAY );
	}

	async function runSearch( query ) {
		const ticket = ++search.ticket;
		search.controller = window.AbortController ? new window.AbortController() : null;

		const url = withParams( wpRestRoot + 'wp/v2/users', {
			search: query,
			per_page: 10,
			_fields: 'id,name,avatar_urls',
		} );

		setPeopleStatus( t( 'searching', 'Searching…' ) );

		let response;
		try {
			response = await window.fetch( url, {
				credentials: 'same-origin',
				headers: { 'X-WP-Nonce': cfg.nonce },
				signal: search.controller ? search.controller.signal : undefined,
			} );
		} catch ( err ) {
			if ( ticket === search.ticket && err.name !== 'AbortError' ) {
				closeResults();
				setPeopleStatus( t( 'peopleSearchOffline', "Couldn't reach the server to search." ) );
			}
			return;
		}

		const list = await readJson( response );

		if ( ticket !== search.ticket ) {
			return;
		}

		if ( ! response.ok || ! Array.isArray( list ) ) {
			closeResults();
			setPeopleStatus(
				fmt(
					t( 'peopleSearchFailed', 'Search failed: %s' ),
					list && list.message
						? list.message
						: fmt( t( 'errorStatus', 'error %d' ), response.status )
				)
			);
			return;
		}

		search.results = list
			.map( ( user ) => {
				const avatars = user.avatar_urls || {};
				return {
					id: parseInt( user.id, 10 ),
					name: str( user.name ) || fmt( t( 'userFallback', 'User #%d' ), user.id ),
					avatar: safeAvatar( avatars[ 48 ] || avatars[ 24 ] || avatars[ 96 ] ),
				};
			} )
			.filter( ( user ) => user.id > 0 && tour.settings.users.indexOf( user.id ) < 0 );

		renderResults();
	}

	function renderResults() {
		ui.peopleResults.textContent = '';
		search.active = -1;
		ui.peopleInput.removeAttribute( 'aria-activedescendant' );

		search.results.forEach( ( person, index ) => {
			ui.peopleResults.append(
				h(
					'li',
					{
						class: 'awb-people__result',
						id: 'awb-person-' + person.id,
						role: 'option',
						'aria-selected': 'false',
						'data-index': index,
					},
					[
						person.avatar
							? h( 'img', {
									class: 'awb-people__avatar',
									src: person.avatar,
									alt: '',
									width: 24,
									height: 24,
									loading: 'lazy',
							  } )
							: null,
						h( 'span', { class: 'awb-people__name', text: person.name } ),
					]
				)
			);
		} );

		const open = search.results.length > 0;
		ui.peopleResults.hidden = ! open;
		ui.peopleInput.setAttribute( 'aria-expanded', open ? 'true' : 'false' );

		setPeopleStatus(
			open
				? plural( search.results.length, 'peopleFound', '%d person found', '%d people found' )
				: t( 'noPeopleFound', 'No people found.' )
		);
	}

	function closeResults() {
		ui.peopleResults.hidden = true;
		ui.peopleInput.setAttribute( 'aria-expanded', 'false' );
		ui.peopleInput.removeAttribute( 'aria-activedescendant' );
		search.active = -1;
	}

	function setActive( index ) {
		const options = ui.peopleResults.querySelectorAll( '.awb-people__result' );
		if ( ! options.length ) {
			return;
		}

		search.active = ( index + options.length ) % options.length;

		options.forEach( ( option, i ) => {
			const on = i === search.active;
			option.classList.toggle( 'is-active', on );
			option.setAttribute( 'aria-selected', on ? 'true' : 'false' );
			if ( on ) {
				ui.peopleInput.setAttribute( 'aria-activedescendant', option.id );
				option.scrollIntoView( { block: 'nearest' } );
			}
		} );
	}

	function onPeopleKey( event ) {
		const open = ! ui.peopleResults.hidden;

		if ( event.key === 'ArrowDown' || event.key === 'ArrowUp' ) {
			if ( ! open && search.results.length ) {
				renderResults();
			}
			event.preventDefault();
			setActive( search.active + ( event.key === 'ArrowDown' ? 1 : -1 ) );
		} else if ( event.key === 'Enter' ) {
			event.preventDefault();
			if ( open && search.active >= 0 ) {
				pickPerson( search.results[ search.active ] );
			}
		} else if ( event.key === 'Escape' && open ) {
			event.preventDefault();
			closeResults();
		}
	}

	function pickPerson( person ) {
		if ( ! person ) {
			return;
		}

		people.set( person.id, person );
		if ( tour.settings.users.indexOf( person.id ) < 0 ) {
			tour.settings.users.push( person.id );
			markDirty();
		}

		cancelSearch();
		search.results = [];
		ui.peopleInput.value = '';
		closeResults();
		renderChips();
		setPeopleStatus( fmt( t( 'personAdded', '%s added.' ), person.name ) );
		ui.peopleInput.focus();
	}

	function removePerson( button ) {
		const id = parseInt( button.getAttribute( 'data-user' ), 10 );
		const index = tour.settings.users.indexOf( id );
		if ( index < 0 ) {
			return;
		}

		const person = people.get( id );
		tour.settings.users.splice( index, 1 );
		markDirty();
		renderChips();
		setPeopleStatus(
			fmt(
				t( 'personRemoved', '%s removed.' ),
				person ? person.name : fmt( t( 'userFallback', 'User #%d' ), id )
			)
		);
		ui.peopleInput.focus();
	}

	function renderChips() {
		ui.chips.textContent = '';

		tour.settings.users.forEach( ( id ) => {
			const person = people.get( id ) || {
				name: fmt( t( 'userFallback', 'User #%d' ), id ),
				avatar: '',
			};
			const label = fmt( t( 'removePerson', 'Remove %s' ), person.name );

			ui.chips.append(
				h( 'li', { class: 'awb-chip' }, [
					person.avatar
						? h( 'img', {
								class: 'awb-chip__avatar',
								src: person.avatar,
								alt: '',
								width: 20,
								height: 20,
						  } )
						: null,
					h( 'span', { class: 'awb-chip__name', text: person.name } ),
					h(
						'button',
						{
							type: 'button',
							class: 'awb-chip__remove',
							'data-awb-action': 'remove-person',
							'data-user': id,
							'aria-label': label,
							title: label,
						},
						[ h( 'span', { 'aria-hidden': 'true', text: '×' } ) ]
					),
				] )
			);
		} );

		ui.chips.hidden = ! tour.settings.users.length;
	}

	/* ------------------------------------------------------------------ */
	/* "Add steps on a screen" dialog                                     */
	/* ------------------------------------------------------------------ */

	function openDialog( button ) {
		const chapter = chapterOf( button ) || tour.chapters[ 0 ];

		dialogChapter = chapter.id;
		dialogOpener = button;

		ui.dialogIntro.textContent = fmt(
			t(
				'dialogIntro',
				'Pick the screen where these steps happen. It opens in build mode, and the steps you add there go into “%s”.'
			),
			chapterName( chapter )
		);
		ui.dialogSearch.value = '';
		ui.dialogUrl.value = '';
		filterScreens();
		setUrlError( '' );
		setDialogBusy( false );

		if ( typeof ui.dialog.showModal === 'function' ) {
			ui.dialog.showModal();
		} else {
			ui.dialog.setAttribute( 'open', '' );
		}

		( screens.length ? ui.dialogSearch : ui.dialogUrl ).focus();
	}

	function closeDialog() {
		if ( ! ui.dialog.open ) {
			return;
		}
		if ( typeof ui.dialog.close === 'function' ) {
			ui.dialog.close();
		} else {
			ui.dialog.removeAttribute( 'open' );
			onDialogClosed();
		}
	}

	function onDialogClosed() {
		if ( dialogOpener && document.contains( dialogOpener ) ) {
			dialogOpener.focus();
		}
		dialogOpener = null;
	}

	function setDialogBusy( busy ) {
		dialogBusy = busy;
		ui.dialog.classList.toggle( 'is-busy', busy );
		ui.dialog.setAttribute( 'aria-busy', busy ? 'true' : 'false' );
	}

	function setUrlError( message ) {
		ui.dialogError.textContent = message;
		ui.dialogError.hidden = ! message;
		if ( message ) {
			ui.dialogUrl.setAttribute( 'aria-invalid', 'true' );
		} else {
			ui.dialogUrl.removeAttribute( 'aria-invalid' );
		}
	}

	function filterScreens() {
		const words = ui.dialogSearch.value.toLowerCase().split( /\s+/ ).filter( Boolean );
		let shown = 0;

		ui.dialogItems.forEach( ( entry ) => {
			const match = words.every( ( word ) => entry.text.indexOf( word ) >= 0 );
			entry.item.hidden = ! match;
			if ( match ) {
				shown++;
			}
		} );

		ui.dialogGroups.forEach( ( g ) => {
			g.group.hidden = g.items.every( ( item ) => item.hidden );
		} );

		ui.dialogEmpty.hidden = ! screens.length || shown > 0;
	}

	function visibleItems() {
		return Array.from( ui.dialogList.querySelectorAll( '.awb-dialog__item' ) ).filter(
			( button ) => ! button.closest( '[hidden]' )
		);
	}

	function onDialogSearchKey( event ) {
		const items = visibleItems();

		if ( event.key === 'Enter' ) {
			event.preventDefault();
			if ( items.length ) {
				pickScreen( items[ 0 ] );
			}
		} else if ( event.key === 'ArrowDown' && items.length ) {
			event.preventDefault();
			items[ 0 ].focus();
		}
	}

	function onDialogListKey( event ) {
		if ( event.key !== 'ArrowDown' && event.key !== 'ArrowUp' ) {
			return;
		}

		const items = visibleItems();
		const index = items.indexOf( ui.dialog.ownerDocument.activeElement );
		if ( index < 0 ) {
			return;
		}

		event.preventDefault();
		const next = index + ( event.key === 'ArrowDown' ? 1 : -1 );

		if ( next < 0 ) {
			ui.dialogSearch.focus();
		} else if ( items[ next ] ) {
			items[ next ].focus();
		}
	}

	function onPasteSubmit( event ) {
		event.preventDefault();

		const result = toAdminPath( ui.dialogUrl.value );
		if ( result.error ) {
			setUrlError( result.error );
			ui.dialogUrl.focus();
			return;
		}

		setUrlError( '' );
		openInBuildMode( result.url );
	}

	function pickScreen( button ) {
		openInBuildMode( button.getAttribute( 'data-url' ) );
	}

	async function openInBuildMode( path ) {
		if ( dialogBusy ) {
			return;
		}

		setDialogBusy( true );
		const chapterId = dialogChapter;
		const ok = await go( () => buildModeUrl( path, chapterId ) );

		// Saving failed: the error notice is behind the modal, so I get out of its way.
		if ( ! ok ) {
			setDialogBusy( false );
			closeDialog();
		}
	}

	/* ------------------------------------------------------------------ */
	/* Wiring                                                             */
	/* ------------------------------------------------------------------ */

	const ACTIONS = {
		'add-chapter': addChapter,
		'chapter-up': ( button ) => moveChapter( button, -1 ),
		'chapter-down': ( button ) => moveChapter( button, 1 ),
		'chapter-delete': deleteChapter,
		'chapter-add-steps': openDialog,
		'step-up': ( button ) => moveStep( button, -1 ),
		'step-down': ( button ) => moveStep( button, 1 ),
		'step-edit': toggleStep,
		'step-delete': deleteStep,
		'step-show': onShowStep,
		'step-format': formatText,
		save: () => save(),
		preview: onPreview,
		'remove-person': removePerson,
		'dialog-close': closeDialog,
		'screen-pick': pickScreen,
	};

	function onClick( event ) {
		const button = event.target.closest( '[data-awb-action]' );
		if ( ! button || ! root.contains( button ) ) {
			return;
		}

		const action = ACTIONS[ button.getAttribute( 'data-awb-action' ) ];
		if ( action ) {
			action( button, event );
		}
	}

	function init() {
		tour = normalize( cfg.tour );
		regroup();

		Object.keys( cfg.users || {} ).forEach( ( key ) => {
			const id = parseInt( key, 10 );
			const user = cfg.users[ key ] || {};
			if ( id > 0 ) {
				people.set( id, {
					id,
					name: str( user.name ) || fmt( t( 'userFallback', 'User #%d' ), id ),
					avatar: safeAvatar( user.avatar ),
				} );
			}
		} );

		buildShell();
		syncFields();
		renderChapters();
		updateMeta();

		root.addEventListener( 'input', onField );
		root.addEventListener( 'change', onField );
		root.addEventListener( 'click', onClick );
		document.addEventListener( 'keydown', onShortcut );
		window.addEventListener( 'beforeunload', onBeforeUnload );
	}

	wireResets();

	root = document.getElementById( 'awb-editor' );
	if ( root && cfg.tour ) {
		init();
	}
} )();
