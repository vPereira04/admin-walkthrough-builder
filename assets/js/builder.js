/**
 * Admin Walkthrough Builder: build mode. A floating menu plus the real learner bubble,
 * edited in place on the screen it belongs to. Autosaves to the REST API.
 */
( function () {
	'use strict';

	const cfg = window.awbBuilder;
	if ( ! cfg || ! window.fetch || ! document.body || window.top !== window.self ) {
		return;
	}

	// Both awb scripts strip awb_* params, so whichever runs first keeps the original query for the other.
	if ( typeof window.awbQuery !== 'string' ) {
		window.awbQuery = window.location.search;
	}

	// player.js owns the bubble markup and placement, so what I edit is exactly what learners get.
	const UI = window.awbUI;
	if ( ! UI ) {
		if ( window.console ) {
			window.console.warn( 'Admin Walkthrough Builder: awb-player must load before awb-builder.' );
		}
		return;
	}

	const { h, fmt, clamp, reveal, reducedMotion } = UI;

	const BUILD_KEY = 'awb_build';
	const POS_KEY = 'awb_build_pos';
	const EDGE = 12;
	const SAVE_DELAY = 600;
	const SEARCH_DELAY = 300;
	const WAIT_MS = 4000;
	const TOAST_MS = 6000;
	const DRAG_THRESHOLD = 4;
	const MARKER_STEP = 24; // Sideways offset when several steps share an element.
	const KEEPALIVE_MAX = 60000; // Browsers cap keepalive bodies at 64KB.

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

	// Things people click; hovering their inner spans/icons should pick the whole control.
	const CLICKABLE =
		'a[href], button, input, select, textarea, label, summary, [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"]';

	// Layout wrappers that are never a useful target.
	const SKIP_IDS = [ 'wpwrap', 'wpcontent', 'wpbody', 'wpbody-content', 'wpfooter' ];

	// Classes that describe state rather than identity.
	const STATE_CLASS =
		/^(is-|has-|wp-has-|wp-menu-open|wp-not-current|current|active|selected|focus|hover|open|opensub|closed|hidden|visible|show|hide|toggled|expanded|collapsed|checked|disabled|ui-state-|ui-sortable|hndle-|awb-|lacu-)/i;

	const DATA_ATTRS = [ 'for', 'data-slug', 'data-plugin', 'data-colname', 'data-setting', 'data-name', 'data-tab' ];

	// Same allow-list the server runs content through.
	const ALLOWED_TAGS = [ 'A', 'STRONG', 'B', 'EM', 'I', 'BR', 'P', 'UL', 'OL', 'LI', 'CODE', 'KBD', 'MARK' ];
	const BLOCK_TAGS = [ 'P', 'UL', 'OL' ];
	const SAFE_HREF = /^(https?:|mailto:|tel:|\/|#|\?|[\w.-]+\.php)/i;

	const SIDES = [ 'top', 'right', 'bottom', 'left' ];
	const BEHAVIOUR = [
		[ 'auto_start', 'settingAutoStart', 'Start automatically the first time they open the first screen' ],
		[ 'allow_skip', 'settingAllowSkip', 'Let them skip ahead' ],
		[ 'allow_exit', 'settingAllowExit', 'Let them close it' ],
		[ 'allow_replay', 'settingAllowReplay', 'Allow replays' ],
	];

	const PATHS = {
		grip: [ 'M9 6h.01', 'M15 6h.01', 'M9 12h.01', 'M15 12h.01', 'M9 18h.01', 'M15 18h.01' ],
		plus: [ 'M12 5v14', 'M5 12h14' ],
		play: [ 'M8 5.5v13l10.5-6.5z' ],
		sliders: [ 'M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6' ],
		minimize: [ 'M5 12h14' ],
		close: [ 'M18 6L6 18', 'M6 6l12 12' ],
		chevron: [ 'M6 9l6 6 6-6' ],
		back: [ 'M19 12H5', 'M12 19l-7-7 7-7' ],
		trash: [ 'M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6' ],
		target: [ 'M12 2v4', 'M12 18v4', 'M2 12h4', 'M18 12h4', 'M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10' ],
		layers: [ 'M12 2l10 5-10 5L2 7l10-5', 'M2 17l10 5 10-5', 'M2 12l10 5 10-5' ],
		top: [ 'M12 19V5', 'M5 12l7-7 7 7' ],
		right: [ 'M5 12h14', 'M12 5l7 7-7 7' ],
		bottom: [ 'M12 5v14', 'M19 12l-7 7-7-7' ],
		left: [ 'M19 12H5', 'M12 19l-7-7 7-7' ],
	};

	const i18n = cfg.i18n || {};
	const params = new URLSearchParams( window.awbQuery );
	const wpRoot = cfg.wpRoot || String( cfg.root ).replace( /admin-walkthrough-builder\/v1\/?$/, 'wp/v2/' );

	let nonce = cfg.nonce;

	/* ---------- Helpers ---------- */

	function t( key, fallback ) {
		return typeof i18n[ key ] === 'string' && i18n[ key ] !== '' ? i18n[ key ] : fallback;
	}

	function stepsLabel( n ) {
		return n === 1 ? t( 'oneStep', '1 step' ) : fmt( t( 'nSteps', '%d steps' ), n );
	}

	function toInt( value ) {
		const n = parseInt( value, 10 );
		return isNaN( n ) || n < 0 ? 0 : n;
	}

	function icon( name ) {
		return UI.icon( 'build-' + name, PATHS[ name ] );
	}

	function readStore( key, local ) {
		try {
			const raw = ( local ? window.localStorage : window.sessionStorage ).getItem( key );
			return raw ? JSON.parse( raw ) : null;
		} catch ( e ) {
			return null;
		}
	}

	function writeStore( key, value, local ) {
		try {
			( local ? window.localStorage : window.sessionStorage ).setItem( key, JSON.stringify( value ) );
		} catch ( e ) {}
	}

	function removeStore( key ) {
		try {
			window.sessionStorage.removeItem( key );
		} catch ( e ) {}
	}

	function stripParams() {
		let url;
		try {
			url = new URL( window.location.href );
		} catch ( e ) {
			return;
		}

		const keys = [ ...url.searchParams.keys() ].filter( ( key ) => key.indexOf( 'awb_' ) === 0 );
		if ( keys.length ) {
			keys.forEach( ( key ) => url.searchParams.delete( key ) );
			window.history.replaceState( window.history.state, '', url.pathname + url.search + url.hash );
		}
	}

	function randomId( prefix, taken ) {
		const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
		let id = '';

		do {
			const bytes = new Uint8Array( 8 );
			if ( window.crypto && window.crypto.getRandomValues ) {
				window.crypto.getRandomValues( bytes );
			} else {
				bytes.forEach( ( b, i ) => ( bytes[ i ] = Math.floor( Math.random() * 256 ) ) );
			}
			id = prefix + Array.from( bytes, ( b ) => chars[ b % chars.length ] ).join( '' );
		} while ( taken.has( id ) );

		return id;
	}

	function adminBarBottom() {
		const bar = document.getElementById( 'wpadminbar' );
		return bar ? Math.max( 0, bar.getBoundingClientRect().bottom ) : 0;
	}

	// Admin-relative "file?query" of where I am now, minus params that only describe a notice or a nonce.
	function currentUrl() {
		try {
			const url = new URL( window.location.href );
			const base = new URL( cfg.adminUrl );
			const path =
				url.pathname.indexOf( base.pathname ) === 0
					? url.pathname.slice( base.pathname.length )
					: url.pathname.replace( /^.*\/wp-admin\//, '' );

			[ ...url.searchParams.keys() ].forEach( ( key ) => {
				if ( key.indexOf( 'awb_' ) === 0 || VOLATILE_PARAMS.indexOf( key ) !== -1 ) {
					url.searchParams.delete( key );
				}
			} );

			const qs = url.searchParams.toString();
			return ( path || 'index.php' ) + ( qs ? '?' + qs : '' );
		} catch ( e ) {
			return 'index.php';
		}
	}

	function normalizedUrl( relative ) {
		try {
			const url = new URL( relative || 'index.php', cfg.adminUrl );
			url.searchParams.sort();
			return url.pathname + url.search;
		} catch ( e ) {
			return '';
		}
	}

	function adminHref( relative, extra ) {
		const url = new URL( cfg.adminUrl + ( relative || 'index.php' ), window.location.href );
		Object.keys( extra || {} ).forEach( ( key ) => url.searchParams.set( key, extra[ key ] ) );
		return url.toString();
	}

	/* ---------- REST ---------- */

	function apiUrl( path, query, root ) {
		// Works for both pretty permalinks and ?rest_route= roots.
		const url = new URL( ( root || cfg.root ) + path, window.location.href );
		Object.keys( query || {} ).forEach( ( key ) => url.searchParams.set( key, query[ key ] ) );
		return url.toString();
	}

	async function request( method, url, json, keepalive ) {
		const init = {
			method,
			credentials: 'same-origin',
			keepalive: !! keepalive,
			headers: { 'X-WP-Nonce': nonce },
		};

		if ( json ) {
			init.headers[ 'Content-Type' ] = 'application/json';
			init.body = json;
		}

		let res;
		try {
			res = await window.fetch( url, init );
		} catch ( e ) {
			return { ok: false, network: true, status: 0, data: null };
		}

		let data = null;
		try {
			data = await res.json();
		} catch ( e ) {}

		return { ok: res.ok, network: false, status: res.status, data };
	}

	function errorText( res, action ) {
		if ( res.network ) {
			return t( 'networkError', 'Couldn’t reach the site. Check your connection and try again.' );
		}
		if ( res.status === 404 && action !== 'search' ) {
			return t( 'tourMissing', 'This walkthrough doesn’t exist anymore.' );
		}
		if ( res.status === 401 || res.status === 403 ) {
			return t( 'noPermission', 'You’re not allowed to do that, or your session expired. Reload the page and try again.' );
		}

		const detail = res.data && typeof res.data.message === 'string' ? res.data.message : 'HTTP ' + res.status;
		const formats = {
			load: t( 'loadFailed', 'Couldn’t load the walkthrough: %s' ),
			create: t( 'createFailed', 'Couldn’t create the walkthrough: %s' ),
			search: t( 'searchFailed', 'Couldn’t search people: %s' ),
		};
		return fmt( formats[ action ] || t( 'saveFailed', 'Couldn’t save: %s' ), detail );
	}

	// Heartbeat hands out a fresh REST nonce, so long build sessions keep saving.
	if ( window.jQuery ) {
		window.jQuery( document ).on( 'heartbeat-tick', ( e, data ) => {
			if ( data && data.rest_nonce ) {
				nonce = data.rest_nonce;
			}
		} );
	}

	/* ---------- Toast (outlives build mode) ---------- */

	let toastEl = null;
	let toastTimer = 0;

	function toast( text, action ) {
		if ( ! toastEl ) {
			toastEl = h( 'div', 'awb-build-toast', { role: 'status', 'aria-live': 'polite', hidden: true } );
			document.body.appendChild( toastEl );
		}

		const children = [ h( 'span', 'awb-build-toast__text', { text } ) ];
		if ( action && action.href ) {
			children.push( h( 'a', 'awb-build-toast__action', { href: action.href, text: action.label } ) );
		} else if ( action && action.run ) {
			const btn = h( 'button', 'awb-build-toast__action', { type: 'button', text: action.label } );
			btn.addEventListener( 'click', () => {
				reveal( toastEl, false );
				action.run();
			} );
			children.push( btn );
		}

		toastEl.replaceChildren( ...children );
		reveal( toastEl, true );
		clearTimeout( toastTimer );
		toastTimer = setTimeout( () => reveal( toastEl, false ), TOAST_MS );
	}

	/* ---------- State ---------- */

	let session = null; // sessionStorage awb_build: { tour, chapter, collapsed, open }
	let active = false;
	let controller = null;
	let tourId = 0;
	let tour = null;
	let ui = null;
	let layer = null;
	let bubble = null;
	let timers = [];

	function on( target, type, fn, opts ) {
		const options = typeof opts === 'boolean' ? { capture: opts } : Object.assign( {}, opts );
		options.signal = controller.signal;
		target.addEventListener( type, fn, options );
	}

	function saveSession() {
		writeStore( BUILD_KEY, session );
	}

	function findStep( id ) {
		return tour ? tour.steps.find( ( s ) => s.id === id ) || null : null;
	}

	function chapterIds() {
		return tour.chapters.map( ( c ) => c.id );
	}

	function currentChapter() {
		const ids = chapterIds();
		return ids.indexOf( session.chapter ) !== -1 ? session.chapter : ids[ 0 ] || '';
	}

	function isHere( step ) {
		if ( step.screen && step.screen === cfg.screen ) {
			return true;
		}
		return !! step.url && normalizedUrl( step.url ) === normalizedUrl( currentUrl() );
	}

	function screenName( step ) {
		const target = normalizedUrl( step.url );
		const match = ( Array.isArray( cfg.screens ) ? cfg.screens : [] ).find( ( s ) => normalizedUrl( s.url ) === target );
		return match ? match.label : step.url || 'index.php';
	}

	// Steps stay grouped in chapter order (stable inside a chapter), same as the server keeps them.
	function regroup() {
		const ids = chapterIds();
		const rank = ( s ) => Math.max( 0, ids.indexOf( s.chapter ) );
		tour.steps.forEach( ( s ) => {
			if ( ids.indexOf( s.chapter ) === -1 ) {
				s.chapter = ids[ 0 ] || '';
			}
		} );
		tour.steps = tour.steps
			.map( ( s, i ) => [ s, i ] )
			.sort( ( a, b ) => rank( a[ 0 ] ) - rank( b[ 0 ] ) || a[ 1 ] - b[ 1 ] )
			.map( ( pair ) => pair[ 0 ] );
	}

	function placeInChapter( step, chapterId, atStart ) {
		const from = tour.steps.indexOf( step );
		if ( from !== -1 ) {
			tour.steps.splice( from, 1 );
		}
		step.chapter = chapterId;

		const inChapter = tour.steps.map( ( s, i ) => ( s.chapter === chapterId ? i : -1 ) ).filter( ( i ) => i !== -1 );
		if ( inChapter.length ) {
			tour.steps.splice( atStart ? inChapter[ 0 ] : inChapter[ inChapter.length - 1 ] + 1, 0, step );
			return;
		}

		tour.steps.push( step );
		regroup();
	}

	function normalize( data ) {
		const settings = Object.assign(
			{
				roles: [],
				users: [],
				auto_start: true,
				allow_skip: true,
				allow_exit: true,
				allow_replay: true,
				refresh_days: 0,
				bar_position: 'top',
			},
			data.settings && typeof data.settings === 'object' ? data.settings : {}
		);
		settings.roles = Array.isArray( settings.roles ) ? settings.roles : [];
		settings.users = Array.isArray( settings.users ) ? settings.users.map( toInt ).filter( Boolean ) : [];

		const result = {
			id: toInt( data.id ) || tourId,
			title: data.title || '',
			description: data.description || '',
			status: data.status === 'publish' ? 'publish' : 'draft',
			chapters: Array.isArray( data.chapters ) ? data.chapters.filter( ( c ) => c && c.id ) : [],
			steps: Array.isArray( data.steps ) ? data.steps.filter( ( s ) => s && s.id ) : [],
			settings,
		};

		if ( ! result.chapters.length ) {
			result.chapters.push( { id: randomId( 'c_', new Set() ), title: t( 'gettingStarted', 'Getting started' ), description: '' } );
		}
		return result;
	}

	/* ---------- Saving ---------- */

	let saving = false;
	let dirty = false;
	let saveTimer = 0;
	let savePromise = Promise.resolve( true );
	let safeInFlight = false; // The request in flight survives a page unload.
	let guarding = false;

	function payload() {
		return JSON.stringify( {
			title: tour.title,
			description: tour.description,
			status: tour.status,
			chapters: tour.chapters,
			steps: tour.steps,
			settings: tour.settings,
		} );
	}

	function queueSave() {
		if ( ! tour ) {
			return;
		}
		dirty = true;
		setStatus( 'saving' );
		clearTimeout( saveTimer );
		saveTimer = setTimeout( () => {
			saveTimer = 0;
			if ( ! saving ) {
				savePromise = runSaves();
			}
		}, SAVE_DELAY );
		syncLeaveGuard();
	}

	function flushSave() {
		clearTimeout( saveTimer );
		saveTimer = 0;
		if ( ! saving && dirty && tour ) {
			savePromise = runSaves();
		}
		return savePromise;
	}

	// One request at a time; anything changed meanwhile goes out in the next round. My copy stays the truth.
	async function runSaves() {
		saving = true;

		while ( dirty && tour ) {
			dirty = false;
			const json = payload();
			safeInFlight = json.length < KEEPALIVE_MAX;
			syncLeaveGuard();

			const res = await request( 'POST', apiUrl( 'tours/' + tourId ), json, safeInFlight );

			if ( ! res.ok ) {
				dirty = true;
				saving = false;
				safeInFlight = false;
				if ( active ) {
					setStatus( 'error', errorText( res, 'save' ) );
				}
				syncLeaveGuard();
				return false;
			}
		}

		saving = false;
		safeInFlight = false;
		if ( active ) {
			setStatus( 'saved' );
		}
		syncLeaveGuard();
		return true;
	}

	// Leaving with a save still waiting: I send it with keepalive so it outlives the page, and only ask when I can't.
	function onLeave( e ) {
		if ( dirty && ! saving && tour ) {
			const json = payload();
			if ( json.length < KEEPALIVE_MAX ) {
				clearTimeout( saveTimer );
				dirty = false;
				request( 'POST', apiUrl( 'tours/' + tourId ), json, true );
			}
		}

		if ( e.type === 'beforeunload' && ( dirty || ( saving && ! safeInFlight ) ) ) {
			e.preventDefault();
			e.returnValue = '';
		}
	}

	function syncLeaveGuard() {
		const unsafe = dirty || ( saving && ! safeInFlight );
		if ( unsafe === guarding ) {
			return;
		}
		guarding = unsafe;
		if ( unsafe ) {
			window.addEventListener( 'beforeunload', onLeave );
			window.addEventListener( 'pagehide', onLeave );
		} else {
			window.removeEventListener( 'beforeunload', onLeave );
			window.removeEventListener( 'pagehide', onLeave );
		}
	}

	function setStatus( kind, text ) {
		if ( ! ui ) {
			return;
		}

		const messages = {
			loading: t( 'loadingTour', 'Loading…' ),
			saving: t( 'saving', 'Saving…' ),
			saved: t( 'saved', 'Saved ✓' ),
		};

		ui.status.classList.toggle( 'is-saving', kind === 'saving' || kind === 'loading' );
		ui.status.classList.toggle( 'is-saved', kind === 'saved' );
		ui.status.classList.toggle( 'is-error', kind === 'error' );
		ui.statusText.textContent = text || messages[ kind ] || '';
		ui.retry.hidden = kind !== 'error';
	}

	/* ---------- Menu ---------- */

	// Icon buttons get their label as aria-label/title; buttons with text show it next to the icon.
	function button( className, action, label, iconName, attrs ) {
		const extra = Object.assign( {}, attrs );
		const text = extra.text;
		delete extra.text;

		const btn = h( 'button', className, Object.assign( { type: 'button', 'data-build': action }, extra ) );
		if ( iconName ) {
			btn.appendChild( icon( iconName ) );
		}
		if ( text ) {
			btn.appendChild( h( 'span', 'awb-build__label', { text } ) );
		} else {
			btn.setAttribute( 'aria-label', label );
			btn.title = label;
		}
		return btn;
	}

	function buildMenu() {
		const root = h( 'div', 'awb-build-root' );
		const hover = h( 'div', 'awb-build-hover', { 'aria-hidden': 'true', hidden: true } );
		const hoverLabel = h( 'span', 'awb-build-hover__label' );
		hover.appendChild( hoverLabel );
		const markers = h( 'div', 'awb-build-markers' );

		const menu = h( 'div', 'awb-build', { role: 'region', 'aria-label': t( 'builderLabel', 'Walkthrough builder' ) } );

		// Header.
		const head = h( 'div', 'awb-build__head' );
		const grip = h( 'span', 'awb-build__grip', { 'aria-hidden': 'true' } );
		grip.appendChild( icon( 'grip' ) );
		const title = h( 'input', 'awb-build__title', {
			type: 'text',
			maxlength: '200',
			autocomplete: 'off',
			placeholder: t( 'titlePlaceholder', 'Name this walkthrough' ),
			'aria-label': t( 'tourTitle', 'Walkthrough title' ),
		} );
		const chip = h( 'button', 'awb-build__chip', { type: 'button', 'data-build': 'status', 'aria-pressed': 'false' } );
		head.append(
			grip,
			title,
			chip,
			button( 'awb-build__icon', 'collapse', t( 'collapse', 'Minimize' ), 'minimize' ),
			button( 'awb-build__icon', 'close', t( 'leaveBuild', 'Done: leave build mode' ), 'close' )
		);

		// Actions.
		const actions = h( 'div', 'awb-build__actions' );
		const addBtn = button( 'awb-build__add', 'pick', '', 'plus', { text: t( 'addStep', 'Add step' ), 'aria-pressed': 'false' } );
		const row = h( 'div', 'awb-build__actions-row' );
		const floatBtn = button( 'awb-build__action', 'float', '', 'layers', { text: t( 'bubbleMiddle', 'Bubble in the middle' ) } );
		const previewBtn = button( 'awb-build__action', 'preview', '', 'play', { text: t( 'preview', 'Preview' ) } );
		const settingsBtn = button( 'awb-build__action', 'settings', '', 'sliders', {
			text: t( 'settings', 'Settings' ),
			'aria-expanded': 'false',
			'aria-controls': 'awb-build-settings',
		} );
		row.append( floatBtn, previewBtn, settingsBtn );
		const hint = h( 'p', 'awb-build__hint', {
			text: t( 'pickHint', 'Click anything on the page… (Esc to cancel)' ),
			hidden: true,
		} );

		const gotoSelect = h( 'select', 'awb-build__goto', { 'aria-label': t( 'goToScreen', 'Go to screen…' ) } );
		gotoSelect.appendChild( h( 'option', '', { value: '', text: t( 'goToScreen', 'Go to screen…' ) } ) );
		const groups = new Map();
		( Array.isArray( cfg.screens ) ? cfg.screens : [] ).forEach( ( s ) => {
			const key = s.group || '';
			if ( ! groups.has( key ) ) {
				groups.set( key, key ? h( 'optgroup', '', { label: key } ) : gotoSelect );
				if ( key ) {
					gotoSelect.appendChild( groups.get( key ) );
				}
			}
			groups.get( key ).appendChild( h( 'option', '', { value: s.url, text: s.label } ) );
		} );
		gotoSelect.hidden = gotoSelect.options.length < 2;

		actions.append( addBtn, row, hint, gotoSelect );

		// Views: the outline, with settings sliding over it.
		const views = h( 'div', 'awb-build__views' );
		const outline = h( 'div', 'awb-build__outline' );
		const chapters = h( 'div', 'awb-build__chapters' );
		const addChapterBtn = button( 'awb-build__add-chapter', 'add-chapter', '', 'plus', { text: t( 'addChapter', 'Chapter' ) } );
		outline.append( chapters, addChapterBtn );
		const settings = buildSettings();
		views.append( outline, settings.settingsPanel );

		// Footer.
		const footer = h( 'div', 'awb-build__footer' );
		const status = h( 'div', 'awb-build__status', { role: 'status', 'aria-live': 'polite' } );
		const statusText = h( 'span', 'awb-build__status-text' );
		const retry = h( 'button', 'awb-build__retry', {
			type: 'button',
			'data-build': 'retry',
			text: t( 'retry', 'Retry' ),
			hidden: true,
		} );
		status.append( statusText, retry );
		const count = h( 'span', 'awb-build__count' );
		footer.append( status, count );

		menu.append( head, actions, views, footer );

		const launcher = h( 'button', 'awb-build-launcher', {
			type: 'button',
			'aria-label': t( 'openBuilder', 'Open the walkthrough builder' ),
			title: t( 'openBuilder', 'Open the walkthrough builder' ),
			hidden: true,
		} );
		const launcherCount = h( 'span', 'awb-build-launcher__count' );
		launcher.append( icon( 'layers' ), launcherCount );

		const format = buildFormatBar();

		root.append( hover, markers, format, menu, launcher );
		document.body.appendChild( root );

		return Object.assign(
			{
				root,
				hover,
				hoverLabel,
				markers,
				menu,
				head,
				title,
				chip,
				addBtn,
				floatBtn,
				previewBtn,
				settingsBtn,
				hint,
				gotoSelect,
				outline,
				chapters,
				status,
				statusText,
				retry,
				count,
				launcher,
				launcherCount,
				format,
			},
			settings
		);
	}

	function buildSettings() {
		const panel = h( 'div', 'awb-build-settings', {
			id: 'awb-build-settings',
			role: 'region',
			'aria-label': t( 'settings', 'Settings' ),
			hidden: true,
		} );
		const head = h( 'div', 'awb-build-settings__head' );
		head.append(
			button( 'awb-build__icon', 'settings-back', t( 'backToOutline', 'Back to steps' ), 'back' ),
			h( 'h3', 'awb-build-settings__title', { text: t( 'settings', 'Settings' ) } )
		);

		// Who sees it.
		const who = h( 'fieldset', 'awb-build-settings__group' );
		who.appendChild( h( 'legend', '', { text: t( 'whoSeesIt', 'Who sees it' ) } ) );
		const roles = h( 'div', 'awb-build-settings__roles' );
		( Array.isArray( cfg.roles ) ? cfg.roles : [] ).forEach( ( role ) => {
			roles.appendChild(
				h( 'button', 'awb-build-chip-toggle', {
					type: 'button',
					'data-build': 'role',
					'data-role': role.slug,
					'aria-pressed': 'false',
					text: role.label,
				} )
			);
		} );
		const people = h( 'ul', 'awb-build-settings__chips', { 'aria-label': t( 'specificPeople', 'Specific people' ) } );
		const searchInput = h( 'input', 'awb-build-settings__search', {
			type: 'search',
			autocomplete: 'off',
			placeholder: t( 'searchPeople', 'Add specific people…' ),
			'aria-label': t( 'searchPeople', 'Add specific people…' ),
		} );
		const results = h( 'ul', 'awb-build-settings__results', { hidden: true } );
		const warning = h( 'p', 'awb-build-settings__warning', {
			text: t( 'nobodySelected', 'Nobody will see this walkthrough yet. Pick a role or some people.' ),
			hidden: true,
		} );
		who.append( roles, people, searchInput, results, warning );

		// Behaviour.
		const behaviour = h( 'fieldset', 'awb-build-settings__group' );
		behaviour.appendChild( h( 'legend', '', { text: t( 'behaviour', 'Behaviour' ) } ) );
		const switches = {};
		BEHAVIOUR.forEach( ( [ key, label, fallback ] ) => {
			const wrap = h( 'label', 'awb-switch' );
			const input = h( 'input', 'awb-switch__input', { type: 'checkbox', 'data-setting': key } );
			wrap.append( input, h( 'span', 'awb-switch__label', { text: t( label, fallback ) } ) );
			switches[ key ] = input;
			behaviour.appendChild( wrap );
		} );

		const refreshWrap = h( 'label', 'awb-build-settings__refresh' );
		const refreshInput = h( 'input', 'awb-build-settings__days', {
			type: 'number',
			min: '0',
			max: '365',
			step: '1',
			'data-setting': 'refresh_days',
		} );
		refreshWrap.append(
			h( 'span', '', { text: t( 'refreshLabel', 'Offer a refresher after' ) } ),
			refreshInput,
			h( 'span', '', { text: t( 'refreshUnit', 'days (0 = never)' ) } )
		);

		const barWrap = h( 'div', 'awb-build-settings__bar' );
		const barSeg = h( 'div', 'awb-seg', { role: 'group', 'aria-label': t( 'barPosition', 'Progress bar position' ) } );
		[
			[ 'top', t( 'barTop', 'Top' ) ],
			[ 'bottom', t( 'barBottom', 'Bottom' ) ],
		].forEach( ( [ value, label ] ) => {
			barSeg.appendChild(
				h( 'button', 'awb-seg__btn', {
					type: 'button',
					'data-build': 'bar',
					'data-value': value,
					'aria-pressed': 'false',
					text: label,
				} )
			);
		} );
		barWrap.append( h( 'span', 'awb-build-settings__label', { text: t( 'barPosition', 'Progress bar position' ) } ), barSeg );
		behaviour.append( refreshWrap, barWrap );

		panel.append( head, who, behaviour );

		return {
			settingsPanel: panel,
			roles,
			people,
			search: searchInput,
			results,
			warning,
			switches,
			refreshDays: refreshInput,
			barSeg,
		};
	}

	function buildFormatBar() {
		const bar = h( 'div', 'awb-build-format', {
			role: 'toolbar',
			'aria-label': t( 'formatting', 'Formatting' ),
			hidden: true,
		} );
		[
			[ 'bold', 'B', t( 'bold', 'Bold' ) ],
			[ 'italic', 'I', t( 'italic', 'Italic' ) ],
			[ 'link', t( 'linkShort', 'Link' ), t( 'link', 'Add link' ) ],
		].forEach( ( [ cmd, glyph, label ] ) => {
			const btn = h( 'button', 'awb-build-format__btn awb-build-format__btn--' + cmd, {
				type: 'button',
				'data-format': cmd,
				'aria-label': label,
				'aria-pressed': 'false',
				title: label,
				text: glyph,
			} );
			// Keep the text selection while the button is pressed.
			btn.addEventListener( 'mousedown', ( e ) => e.preventDefault() );
			bar.appendChild( btn );
		} );
		return bar;
	}

	/* ---------- Menu position ---------- */

	let pos = null; // localStorage awb_build_pos: { edge, along }

	function menuBox() {
		return session.collapsed ? ui.launcher : ui.menu;
	}

	function applyPos() {
		const box = menuBox();
		if ( ! box || box.hidden ) {
			return;
		}

		const vw = document.documentElement.clientWidth;
		const vh = window.innerHeight;
		const minTop = adminBarBottom() + EDGE;
		const w = box.offsetWidth;
		const ht = box.offsetHeight;
		const p = pos && SIDES.indexOf( pos.edge ) !== -1 ? pos : { edge: 'right', along: minTop + 8 };
		let left;
		let top;

		if ( p.edge === 'left' || p.edge === 'right' ) {
			left = p.edge === 'left' ? EDGE : vw - w - EDGE;
			top = p.along;
		} else {
			top = p.edge === 'top' ? minTop : vh - ht - EDGE;
			left = p.along;
		}

		box.style.left = Math.round( clamp( left, EDGE, Math.max( EDGE, vw - w - EDGE ) ) ) + 'px';
		box.style.top = Math.round( clamp( top, minTop, Math.max( minTop, vh - ht - EDGE ) ) ) + 'px';
		box.setAttribute( 'data-edge', p.edge );
	}

	// Generic pointer drag with a small threshold, so a press without movement still counts as a click.
	let dragCleanup = null;

	function startDrag( e, handlers ) {
		if ( e.button !== 0 || ! e.isPrimary || dragCleanup ) {
			return;
		}

		const ctx = { x0: e.clientX, y0: e.clientY, moved: false };

		const move = ( ev ) => {
			if ( ! ctx.moved ) {
				if ( Math.abs( ev.clientX - ctx.x0 ) + Math.abs( ev.clientY - ctx.y0 ) < DRAG_THRESHOLD ) {
					return;
				}
				ctx.moved = true;
				if ( handlers.begin ) {
					handlers.begin( ctx, ev );
				}
			}
			ev.preventDefault();
			handlers.move( ctx, ev );
		};

		const cleanup = () => {
			window.removeEventListener( 'pointermove', move );
			window.removeEventListener( 'pointerup', up );
			window.removeEventListener( 'pointercancel', up );
			dragCleanup = null;
		};

		function up( ev ) {
			cleanup();
			if ( ctx.moved ) {
				handlers.end( ctx, ev );
			} else if ( handlers.tap ) {
				handlers.tap( ctx, ev );
			}
		}

		window.addEventListener( 'pointermove', move, { passive: false } );
		window.addEventListener( 'pointerup', up );
		window.addEventListener( 'pointercancel', up );
		dragCleanup = cleanup;
	}

	function dragMenu( e, box, onTap ) {
		startDrag( e, {
			begin( ctx ) {
				const r = box.getBoundingClientRect();
				ctx.dx = ctx.x0 - r.left;
				ctx.dy = ctx.y0 - r.top;
				box.classList.add( 'is-dragging' );
			},
			move( ctx, ev ) {
				const vw = document.documentElement.clientWidth;
				const vh = window.innerHeight;
				box.style.left = Math.round( clamp( ev.clientX - ctx.dx, 0, Math.max( 0, vw - box.offsetWidth ) ) ) + 'px';
				box.style.top = Math.round( clamp( ev.clientY - ctx.dy, 0, Math.max( 0, vh - box.offsetHeight ) ) ) + 'px';
			},
			end() {
				// Snap to whichever screen edge is nearest and remember it for every screen.
				const r = box.getBoundingClientRect();
				const vw = document.documentElement.clientWidth;
				const vh = window.innerHeight;
				const gaps = {
					left: r.left,
					right: vw - r.right,
					top: r.top - adminBarBottom(),
					bottom: vh - r.bottom,
				};
				const edge = SIDES.reduce( ( best, s ) => ( gaps[ s ] < gaps[ best ] ? s : best ), 'right' );
				pos = { edge, along: Math.round( edge === 'left' || edge === 'right' ? r.top : r.left ) };
				writeStore( POS_KEY, pos, true );
				box.classList.remove( 'is-dragging' );
				applyPos();
			},
			tap: onTap,
		} );
	}

	function setCollapsed( collapsed ) {
		session.collapsed = collapsed;
		saveSession();
		if ( collapsed ) {
			stopPick();
			closeBubble();
		}
		ui.menu.hidden = collapsed;
		ui.launcher.hidden = ! collapsed;
		applyPos();
		( collapsed ? ui.launcher : ui.title ).focus( { preventScroll: true } );
	}

	/* ---------- Outline ---------- */

	function renderHead() {
		if ( ui.title.ownerDocument.activeElement !== ui.title ) {
			ui.title.value = tour.title;
		}
		const live = tour.status === 'publish';
		ui.chip.textContent = live ? t( 'live', 'Live' ) : t( 'draft', 'Draft' );
		ui.chip.classList.toggle( 'is-live', live );
		ui.chip.setAttribute( 'aria-pressed', live ? 'true' : 'false' );
		ui.chip.title = live ? t( 'makeDraft', 'Live: click to switch back to draft' ) : t( 'makeLive', 'Draft: click to make it live' );

		const total = tour.steps.length;
		ui.count.textContent = stepsLabel( total ) + ' · ' + chaptersLabel( tour.chapters.length );
		ui.launcherCount.textContent = String( total );
		ui.previewBtn.disabled = ! total;
		ui.previewBtn.title = total ? t( 'previewHint', 'Opens in a new tab' ) : t( 'previewNoSteps', 'Add a step first.' );
	}

	function chaptersLabel( n ) {
		return n === 1 ? t( 'oneChapter', '1 chapter' ) : fmt( t( 'nChapters', '%d chapters' ), n );
	}

	function renderOutline() {
		const scroll = ui.outline.scrollTop;
		const current = currentChapter();
		const onlyOne = tour.chapters.length < 2;

		ui.chapters.replaceChildren(
			...tour.chapters.map( ( chapter, ci ) => {
				const section = h( 'section', 'awb-build__chapter', { 'data-chapter': chapter.id } );
				section.classList.toggle( 'is-current', chapter.id === current );
				section.classList.toggle( 'is-collapsed', collapsedChapters.has( chapter.id ) );

				const head = h( 'div', 'awb-build__chapter-head', { 'data-build': 'current' } );
				const toggle = button( 'awb-build__chapter-toggle', 'toggle-chapter', t( 'toggleChapter', 'Show or hide steps' ), 'chevron', {
					'aria-expanded': collapsedChapters.has( chapter.id ) ? 'false' : 'true',
				} );
				const titleInput = h( 'input', 'awb-build__chapter-title', {
					type: 'text',
					maxlength: '200',
					value: chapter.title,
					'data-field': 'chapter-title',
					placeholder: fmt( t( 'chapterN', 'Chapter %d' ), ci + 1 ),
					'aria-label': fmt( t( 'chapterTitleN', 'Chapter %d title' ), ci + 1 ),
				} );
				const steps = tour.steps.map( ( s, i ) => [ s, i ] ).filter( ( pair ) => pair[ 0 ].chapter === chapter.id );
				head.append( toggle, titleInput, h( 'span', 'awb-build__chapter-count', { text: String( steps.length ) } ) );
				if ( ! steps.length && ! onlyOne ) {
					head.appendChild( button( 'awb-build__icon', 'delete-chapter', t( 'deleteChapter', 'Delete empty chapter' ), 'trash' ) );
				}

				const desc = h( 'textarea', 'awb-build__chapter-desc', {
					rows: '1',
					'data-field': 'chapter-desc',
					placeholder: t( 'chapterDescPlaceholder', 'Short description, shown when people hover this chapter in the progress bar' ),
					'aria-label': fmt( t( 'chapterDescN', 'Chapter %d description' ), ci + 1 ),
				} );
				desc.value = chapter.description || '';

				const list = h( 'ol', 'awb-build__steps', { 'data-chapter': chapter.id } );
				steps.forEach( ( [ step, index ] ) => list.appendChild( outlineItem( step, index ) ) );
				if ( ! steps.length ) {
					list.appendChild( h( 'li', 'awb-build__empty', { text: t( 'emptyChapter', 'No steps yet. Use Add step, or drag one here.' ) } ) );
				}

				section.append( head, desc, list );
				return section;
			} )
		);

		ui.outline.scrollTop = scroll;
	}

	function outlineItem( step, index ) {
		const here = isHere( step );
		const li = h( 'li', 'awb-build__item', { 'data-step': step.id } );
		li.classList.toggle( 'is-here', here );
		li.classList.toggle( 'is-elsewhere', ! here );
		li.classList.toggle( 'is-open', step.id === openId );

		const grip = h( 'button', 'awb-build__grip', {
			type: 'button',
			'data-build': 'grip',
			'aria-label': fmt( t( 'moveStep', 'Move step %d (use the arrow keys)' ), index + 1 ),
			title: t( 'dragToMove', 'Drag to reorder' ),
		} );
		grip.appendChild( icon( 'grip' ) );

		const main = h( 'button', 'awb-build__item-main', { type: 'button', 'data-build': 'open' } );
		main.append(
			h( 'span', 'awb-build__num', { text: String( index + 1 ) } ),
			h( 'span', 'awb-build__name', { text: step.title || t( 'untitledStep', 'Untitled step' ) } )
		);
		if ( here ) {
			main.appendChild(
				h( 'span', 'awb-build__dot', {
					title: t( 'onThisScreen', 'On this screen' ),
					'aria-label': t( 'onThisScreen', 'On this screen' ),
				} )
			);
		} else {
			main.appendChild( h( 'span', 'awb-build__where', { text: '↗ ' + screenName( step ) } ) );
		}
		if ( ! step.selector ) {
			main.appendChild( h( 'span', 'awb-build__badge', { text: t( 'floating', 'Floating' ) } ) );
		}

		li.append( grip, main );
		return li;
	}

	const collapsedChapters = new Set();

	function setCurrentChapter( id ) {
		if ( chapterIds().indexOf( id ) === -1 ) {
			return;
		}
		session.chapter = id;
		saveSession();
		ui.chapters.querySelectorAll( '.awb-build__chapter' ).forEach( ( section ) => {
			section.classList.toggle( 'is-current', section.getAttribute( 'data-chapter' ) === id );
		} );
	}

	function addChapter() {
		const chapter = {
			id: randomId( 'c_', new Set( chapterIds() ) ),
			title: t( 'newChapter', 'New chapter' ),
			description: '',
		};
		tour.chapters.push( chapter );
		session.chapter = chapter.id;
		saveSession();
		refresh();
		queueSave();

		const input = ui.chapters.querySelector( '[data-chapter="' + chapter.id + '"] .awb-build__chapter-title' );
		if ( input ) {
			input.focus();
			input.select();
		}
	}

	function deleteChapter( id ) {
		if ( tour.chapters.length < 2 || tour.steps.some( ( s ) => s.chapter === id ) ) {
			return;
		}
		tour.chapters = tour.chapters.filter( ( c ) => c.id !== id );
		refresh();
		queueSave();
	}

	// Keyboard reorder: swap with the neighbour, or hop into the next chapter at its edge.
	function moveStep( id, dir ) {
		const step = findStep( id );
		const i = tour.steps.indexOf( step );
		const neighbour = tour.steps[ i + dir ];

		if ( neighbour && neighbour.chapter === step.chapter ) {
			tour.steps[ i ] = neighbour;
			tour.steps[ i + dir ] = step;
		} else {
			const ids = chapterIds();
			const target = ids[ ids.indexOf( step.chapter ) + dir ];
			if ( ! target ) {
				return;
			}
			placeInChapter( step, target, dir > 0 );
		}

		refresh();
		queueSave();
		const grip = ui.chapters.querySelector( '[data-step="' + id + '"] .awb-build__grip' );
		if ( grip ) {
			grip.focus();
		}
	}

	function dragStep( e, li ) {
		startDrag( e, {
			begin( ctx ) {
				ctx.offset = ctx.y0 - li.getBoundingClientRect().top;
				li.classList.add( 'is-dragging' );
				ui.outline.classList.add( 'is-sorting' );
			},
			move( ctx, ev ) {
				const y = ev.clientY;
				const sections = Array.from( ui.chapters.querySelectorAll( '.awb-build__chapter' ) );
				const section =
					sections.find( ( s ) => y <= s.getBoundingClientRect().bottom ) || sections[ sections.length - 1 ];

				if ( section ) {
					const list = section.querySelector( '.awb-build__steps' );
					const items = Array.from( list.querySelectorAll( '.awb-build__item' ) ).filter( ( n ) => n !== li );
					const before = items.find( ( n ) => {
						const r = n.getBoundingClientRect();
						return r.height && y < r.top + r.height / 2;
					} );
					const empty = list.querySelector( '.awb-build__empty' );

					if ( before ) {
						if ( li.nextElementSibling !== before ) {
							list.insertBefore( li, before );
						}
					} else if ( li.parentElement !== list || li.nextElementSibling ) {
						list.appendChild( li );
					}
					if ( empty ) {
						empty.hidden = true;
					}
				}

				// The dragged row follows the pointer from wherever the DOM put it.
				li.style.transform = '';
				const natural = li.getBoundingClientRect().top;
				li.style.transform = 'translateY(' + Math.round( y - ctx.offset - natural ) + 'px)';

				const box = ui.outline.getBoundingClientRect();
				if ( y < box.top + 24 ) {
					ui.outline.scrollTop -= 10;
				} else if ( y > box.bottom - 24 ) {
					ui.outline.scrollTop += 10;
				}
			},
			end() {
				li.style.transform = '';
				li.classList.remove( 'is-dragging' );
				ui.outline.classList.remove( 'is-sorting' );

				const order = [];
				ui.chapters.querySelectorAll( '.awb-build__chapter' ).forEach( ( section ) => {
					const cid = section.getAttribute( 'data-chapter' );
					section.querySelectorAll( '.awb-build__item' ).forEach( ( item ) => {
						const step = findStep( item.getAttribute( 'data-step' ) );
						if ( step ) {
							step.chapter = cid;
							order.push( step );
						}
					} );
				} );

				if ( order.length === tour.steps.length ) {
					tour.steps = order;
					queueSave();
				}
				refresh();
			},
		} );
	}

	/* ---------- Settings panel ---------- */

	const userCache = {};
	let searchTimer = 0;
	let searchSeq = 0;

	Object.keys( cfg.users || {} ).forEach( ( id ) => {
		userCache[ id ] = cfg.users[ id ];
	} );

	function toggleSettings( open ) {
		reveal( ui.settingsPanel, open );
		ui.outline.toggleAttribute( 'inert', open );
		ui.settingsBtn.setAttribute( 'aria-expanded', open ? 'true' : 'false' );
		ui.settingsBtn.classList.toggle( 'is-active', open );

		if ( open ) {
			closeBubble();
			stopPick();
			renderSettings();
			resolveUserNames();
			ui.settingsPanel.querySelector( 'button' ).focus( { preventScroll: true } );
		} else {
			ui.settingsBtn.focus( { preventScroll: true } );
		}
	}

	function renderSettings() {
		const s = tour.settings;

		ui.roles.querySelectorAll( '[data-role]' ).forEach( ( btn ) => {
			const pressed = s.roles.indexOf( btn.getAttribute( 'data-role' ) ) !== -1;
			btn.setAttribute( 'aria-pressed', pressed ? 'true' : 'false' );
			btn.classList.toggle( 'is-active', pressed );
		} );

		ui.people.replaceChildren(
			...s.users.map( ( id ) => {
				const user = userCache[ id ] || {};
				const li = h( 'li', 'awb-build-settings__chip' );
				if ( user.avatar ) {
					li.appendChild( h( 'img', 'awb-build-settings__avatar', { src: user.avatar, alt: '' } ) );
				}
				li.appendChild( h( 'span', '', { text: user.name || '#' + id } ) );
				li.appendChild(
					h( 'button', 'awb-build-settings__remove', {
						type: 'button',
						'data-build': 'remove-user',
						'data-user': id,
						'aria-label': fmt( t( 'removePerson', 'Remove %s' ), user.name || '#' + id ),
						text: '×',
					} )
				);
				return li;
			} )
		);

		Object.keys( ui.switches ).forEach( ( key ) => {
			ui.switches[ key ].checked = !! s[ key ];
		} );
		if ( ui.refreshDays.ownerDocument.activeElement !== ui.refreshDays ) {
			ui.refreshDays.value = String( toInt( s.refresh_days ) );
		}
		ui.refreshDays.disabled = ! s.allow_replay;

		ui.barSeg.querySelectorAll( '[data-value]' ).forEach( ( btn ) => {
			const pressed = btn.getAttribute( 'data-value' ) === ( s.bar_position === 'bottom' ? 'bottom' : 'top' );
			btn.setAttribute( 'aria-pressed', pressed ? 'true' : 'false' );
			btn.classList.toggle( 'is-active', pressed );
		} );

		ui.warning.hidden = !! ( s.roles.length || s.users.length );
	}

	function avatarOf( user ) {
		const urls = user.avatar_urls || {};
		return urls[ 48 ] || urls[ 24 ] || urls[ Object.keys( urls )[ 0 ] ] || '';
	}

	async function resolveUserNames() {
		const missing = tour.settings.users.filter( ( id ) => ! userCache[ id ] );
		if ( ! missing.length ) {
			return;
		}

		const res = await request(
			'GET',
			apiUrl( 'users', { include: missing.join( ',' ), per_page: 100, context: 'view', _fields: 'id,name,avatar_urls' }, wpRoot )
		);
		if ( res.ok && Array.isArray( res.data ) ) {
			res.data.forEach( ( user ) => {
				userCache[ user.id ] = { name: user.name, avatar: avatarOf( user ) };
			} );
			if ( tour ) {
				renderSettings();
			}
		}
	}

	function searchPeople() {
		clearTimeout( searchTimer );
		const term = ui.search.value.trim();

		if ( term.length < 2 ) {
			ui.results.hidden = true;
			ui.results.replaceChildren();
			return;
		}

		searchTimer = setTimeout( async () => {
			const seq = ++searchSeq;
			const res = await request(
				'GET',
				apiUrl( 'users', { search: term, per_page: 10, context: 'view', _fields: 'id,name,avatar_urls' }, wpRoot )
			);

			// A slower, older search must not overwrite a newer one.
			if ( seq !== searchSeq || ! active ) {
				return;
			}

			let items;
			if ( ! res.ok || ! Array.isArray( res.data ) ) {
				items = [ h( 'li', 'awb-build-settings__result is-error', { text: errorText( res, 'search' ) } ) ];
			} else if ( ! res.data.length ) {
				items = [ h( 'li', 'awb-build-settings__result is-empty', { text: t( 'noPeopleFound', 'Nobody found.' ) } ) ];
			} else {
				items = res.data.map( ( user ) => {
					userCache[ user.id ] = { name: user.name, avatar: avatarOf( user ) };
					const li = h( 'li', 'awb-build-settings__result' );
					const btn = h( 'button', '', { type: 'button', 'data-build': 'add-user', 'data-user': user.id } );
					if ( avatarOf( user ) ) {
						btn.appendChild( h( 'img', 'awb-build-settings__avatar', { src: avatarOf( user ), alt: '' } ) );
					}
					btn.appendChild( h( 'span', '', { text: user.name } ) );
					btn.disabled = tour.settings.users.indexOf( user.id ) !== -1;
					li.appendChild( btn );
					return li;
				} );
			}

			ui.results.replaceChildren( ...items );
			ui.results.hidden = false;
		}, SEARCH_DELAY );
	}

	/* ---------- Markers ---------- */

	let markerItems = [];

	// The first visible match; a broken selector simply finds nothing.
	function findTarget( selector ) {
		let list;
		try {
			list = document.querySelectorAll( selector );
		} catch ( e ) {
			return null;
		}

		for ( const node of list ) {
			if ( ! isOwn( node ) ) {
				const r = node.getBoundingClientRect();
				if ( r.width >= 1 || r.height >= 1 ) {
					return node;
				}
			}
		}
		return null;
	}

	function renderMarkers() {
		markerItems = [];
		ui.markers.replaceChildren();

		tour.steps.forEach( ( step, index ) => {
			if ( ! step.selector || ! isHere( step ) ) {
				return;
			}
			const node = h( 'button', 'awb-build-marker', {
				type: 'button',
				'data-build': 'marker',
				'data-step': step.id,
				'aria-label': fmt( t( 'editStepN', 'Edit step %1$d: %2$s' ), index + 1, step.title || '' ),
				title: step.title || '',
				text: String( index + 1 ),
				hidden: true,
			} );
			ui.markers.appendChild( node );
			markerItems.push( { step, node, el: null, key: '' } );
		} );

		resolveMarkers();
	}

	function resolveMarkers() {
		markerItems.forEach( ( item ) => {
			if ( ! item.el || ! item.el.isConnected ) {
				item.el = findTarget( item.step.selector );
			}
		} );
	}

	function positionMarkers() {
		const stacked = new Map();

		markerItems.forEach( ( item ) => {
			const r = item.el && item.el.isConnected ? item.el.getBoundingClientRect() : null;

			if ( ! r || ( r.width < 1 && r.height < 1 ) ) {
				item.node.hidden = true;
				return;
			}

			const k = stacked.get( item.el ) || 0;
			stacked.set( item.el, k + 1 );

			// The element's top-left corner; CSS centres the dot on it.
			const left = Math.round( r.left + k * MARKER_STEP );
			const top = Math.round( r.top );
			const key = left + ',' + top;

			item.node.hidden = false;
			item.node.classList.toggle( 'is-active', item.step.id === openId );
			if ( key !== item.key ) {
				item.key = key;
				item.node.style.left = left + 'px';
				item.node.style.top = top + 'px';
			}
		} );
	}

	/* ---------- Layout loop ---------- */

	let layoutRaf = 0;

	function schedule() {
		if ( active && ! layoutRaf ) {
			layoutRaf = window.requestAnimationFrame( layout );
		}
	}

	function layout() {
		layoutRaf = 0;
		if ( ! active ) {
			return;
		}
		if ( picking && pointer ) {
			setHovered( candidateAt( pointer.x, pointer.y, pointer.target ) );
		}
		positionMarkers();
		positionHover();
		positionBubble( false );
		positionFormat();
	}

	/* ---------- Pick mode ---------- */

	let picking = null; // { stepId } when re-pointing an existing step.
	let hovered = null;
	let pointer = null;

	function isOwn( node ) {
		if ( ! node || node.nodeType !== 1 ) {
			return false;
		}
		return (
			( !! ui && ui.root.contains( node ) ) ||
			( !! layer && layer.root.contains( node ) ) ||
			( !! toastEl && toastEl.contains( node ) ) ||
			!! node.closest( '.awb-root' )
		);
	}

	function readable( el ) {
		const tag = el.tagName.toLowerCase();
		let text =
			el.getAttribute( 'aria-label' ) ||
			el.getAttribute( 'title' ) ||
			el.getAttribute( 'alt' ) ||
			el.getAttribute( 'placeholder' ) ||
			'';

		if ( ! text && el.labels && el.labels.length ) {
			text = el.labels[ 0 ].textContent;
		}
		if ( ! text && el.tagName === 'INPUT' && [ 'button', 'submit', 'reset' ].indexOf( el.type ) !== -1 ) {
			text = el.value;
		}
		if ( ! text && [ 'INPUT', 'TEXTAREA', 'SELECT' ].indexOf( el.tagName ) === -1 ) {
			text = el.innerText || el.textContent || '';
		}

		text = String( text ).replace( /\s+/g, ' ' ).trim();
		return { tag, text: text.length > 60 ? text.slice( 0, 59 ) + '…' : text };
	}

	function describe( el ) {
		const { tag, text } = readable( el );
		return text ? tag + ' · “' + text + '”' : tag;
	}

	function candidateAt( x, y, from ) {
		let node = from;

		// The hover box sits on top of the page, so I look through it.
		if ( ! node || ui.hover.contains( node ) || ! node.isConnected ) {
			node = ( document.elementsFromPoint ? document.elementsFromPoint( x, y ) : [] ).find(
				( n ) => ! ui.hover.contains( n )
			);
		}

		if ( ! node || node.nodeType !== 1 || isOwn( node ) ) {
			return null;
		}

		const svg = node.closest( 'svg' );
		if ( svg && svg.parentElement ) {
			node = svg.parentElement;
		}

		const clickable = node.closest( CLICKABLE );
		if ( clickable && ! isOwn( clickable ) ) {
			const r = clickable.getBoundingClientRect();
			if ( r.width * r.height < window.innerWidth * window.innerHeight * 0.4 ) {
				node = clickable;
			}
		}

		if ( node === document.body || node === document.documentElement || SKIP_IDS.indexOf( node.id ) !== -1 ) {
			return null;
		}

		return node;
	}

	function setHovered( el ) {
		if ( el === hovered ) {
			return;
		}
		hovered = el;
		ui.hoverLabel.textContent = el ? describe( el ) : '';
		schedule();
	}

	function positionHover() {
		const el = picking ? hovered : null;
		const r = el && el.isConnected ? el.getBoundingClientRect() : null;

		if ( ! r || ( r.width < 1 && r.height < 1 ) ) {
			ui.hover.hidden = true;
			return;
		}

		const s = ui.hover.style;
		s.left = Math.round( r.left ) + 'px';
		s.top = Math.round( r.top ) + 'px';
		s.width = Math.round( r.width ) + 'px';
		s.height = Math.round( r.height ) + 'px';
		ui.hover.hidden = false;
		// No room for the label above, so CSS tucks it inside/below.
		ui.hover.classList.toggle( 'is-flipped', r.top < adminBarBottom() + 28 );
	}

	const PICK_BLOCKED = [ 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'auxclick' ];

	function letThrough( e ) {
		return isOwn( e.target ) && ! ui.hover.contains( e.target );
	}

	function blockEvent( e ) {
		if ( letThrough( e ) ) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();

		// Touch has no hover, so the press itself says what's being pointed at.
		if ( e.type === 'pointerdown' ) {
			pointer = { x: e.clientX, y: e.clientY, target: e.target };
			setHovered( candidateAt( e.clientX, e.clientY, e.target ) );
		}
	}

	function onPickMove( e ) {
		pointer = { x: e.clientX, y: e.clientY, target: e.target };
		schedule();
	}

	function onPickClick( e ) {
		if ( letThrough( e ) ) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();

		const el = candidateAt( e.clientX, e.clientY, e.target );
		if ( el ) {
			choose( el );
		}
	}

	function startPick( stepId ) {
		if ( ! tour ) {
			return;
		}
		closeBubble();
		if ( isOpenSettings() ) {
			toggleSettings( false );
		}
		if ( picking ) {
			stopPick();
		}

		picking = { stepId: stepId || '' };
		pointer = null;
		ui.menu.classList.add( 'is-picking' );
		document.documentElement.classList.add( 'awb-build-picking' );
		ui.addBtn.setAttribute( 'aria-pressed', 'true' );
		ui.hint.hidden = false;
		ui.hint.textContent = stepId
			? t( 'pickHintChange', 'Click the new element for this step… (Esc to cancel)' )
			: t( 'pickHint', 'Click anything on the page… (Esc to cancel)' );

		// Window capture runs before anything the page registered.
		PICK_BLOCKED.forEach( ( type ) => window.addEventListener( type, blockEvent, true ) );
		window.addEventListener( 'pointermove', onPickMove, { capture: true, passive: true } );
		window.addEventListener( 'click', onPickClick, true );
	}

	function stopPick() {
		if ( ! picking ) {
			return;
		}
		picking = null;
		pointer = null;
		setHovered( null );
		ui.menu.classList.remove( 'is-picking' );
		document.documentElement.classList.remove( 'awb-build-picking' );
		ui.addBtn.setAttribute( 'aria-pressed', 'false' );
		ui.hint.hidden = true;

		PICK_BLOCKED.forEach( ( type ) => window.removeEventListener( type, blockEvent, true ) );
		window.removeEventListener( 'pointermove', onPickMove, { capture: true } );
		window.removeEventListener( 'click', onPickClick, true );
		schedule();
	}

	function choose( el ) {
		const selector = buildSelector( el );
		const stepId = picking ? picking.stepId : '';
		stopPick();

		if ( ! selector ) {
			toast( t( 'noSelector', 'I couldn’t find a reliable way to point at that element. Try one next to it or around it.' ) );
			return;
		}

		const { text, tag } = readable( el );
		const where = { url: currentUrl(), screen: cfg.screen || '', selector, label: ( text || tag ).slice( 0, 80 ) };
		const existing = stepId ? findStep( stepId ) : null;

		if ( existing ) {
			Object.assign( existing, where );
			refresh();
			queueSave();
			openBubble( existing.id, { el } );
			return;
		}

		createStep( where, el );
	}

	function createStep( where, el ) {
		const step = Object.assign(
			{
				id: randomId( 's_', new Set( tour.steps.map( ( s ) => s.id ) ) ),
				chapter: currentChapter(),
				title: '',
				content: '',
				placement: 'auto',
				advance: 'next',
			},
			where
		);

		placeInChapter( step, step.chapter, false );
		freshId = step.id;
		refresh();
		queueSave();
		openBubble( step.id, { el } );
	}

	/* ---------- Selector generator ---------- */

	function stableId( node ) {
		const id = node.id;
		return !! id && id.length <= 80 && ! /\d{4,}/.test( id ) && id.indexOf( ':' ) === -1;
	}

	function quote( value ) {
		return '"' + String( value ).replace( /\\/g, '\\\\' ).replace( /"/g, '\\"' ).replace( /[\n\r\f]/g, ' ' ) + '"';
	}

	function matches( selector ) {
		try {
			return document.querySelectorAll( selector );
		} catch ( e ) {
			return null;
		}
	}

	function isUnique( selector, el ) {
		const list = matches( selector );
		return !! list && list.length === 1 && list[ 0 ] === el;
	}

	function hrefSelector( href ) {
		if ( ! href || href === '#' || /^javascript:/i.test( href ) || /[?&]_wpnonce=/.test( href ) || href.length > 300 ) {
			return '';
		}

		// Same-site absolute URLs change between staging and live, so I only match the end.
		const at = href.indexOf( 'wp-admin/' );
		if ( at > 0 ) {
			return '[href$=' + quote( href.slice( at ) ) + ']';
		}

		try {
			const url = new URL( href, window.location.href );
			if ( /^([a-z][a-z0-9+.-]*:)?\/\//i.test( href ) && url.host === window.location.host ) {
				const tail = url.pathname + url.search + url.hash;
				return tail.length > 1 ? '[href$=' + quote( tail ) + ']' : '';
			}
		} catch ( e ) {
			return '';
		}

		return '[href=' + quote( href ) + ']';
	}

	function attrSelector( node ) {
		const tag = node.tagName;

		if ( tag === 'A' && node.hasAttribute( 'href' ) ) {
			return hrefSelector( node.getAttribute( 'href' ) );
		}

		const name = node.getAttribute( 'name' );
		if ( name && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test( tag ) ) {
			let sel = '[name=' + quote( name ) + ']';
			if ( ( node.type === 'radio' || node.type === 'checkbox' ) && node.hasAttribute( 'value' ) ) {
				sel += '[value=' + quote( node.getAttribute( 'value' ) ) + ']';
			}
			return sel;
		}

		for ( const attr of DATA_ATTRS ) {
			const value = node.getAttribute( attr );
			if ( value && value.length <= 100 ) {
				return '[' + attr + '=' + quote( value ) + ']';
			}
		}

		return '';
	}

	// Identity classes, rarest first; state and generated-looking ones are useless next time.
	function distinctClasses( node ) {
		return Array.from( node.classList )
			.filter( ( c ) => c.length <= 40 && ! STATE_CLASS.test( c ) && ! /\d{3,}/.test( c ) )
			.map( ( c ) => [ c, document.getElementsByClassName( c ).length ] )
			.sort( ( a, b ) => a[ 1 ] - b[ 1 ] )
			.slice( 0, 2 )
			.map( ( pair ) => '.' + window.CSS.escape( pair[ 0 ] ) );
	}

	function nthOfType( node ) {
		let n = 1;
		let sib = node.previousElementSibling;
		while ( sib ) {
			if ( sib.tagName === node.tagName ) {
				n++;
			}
			sib = sib.previousElementSibling;
		}
		return n;
	}

	function segments( node, allowNth ) {
		const raw = node.tagName.toLowerCase();
		const tag = /^[a-z][a-z0-9-]*$/.test( raw ) ? raw : '*';
		const attr = attrSelector( node );
		const classes = distinctClasses( node );
		const out = [];

		if ( stableId( node ) ) {
			out.push( '#' + window.CSS.escape( node.id ) );
		}
		if ( attr ) {
			out.push( tag + attr );
		}
		if ( classes.length ) {
			out.push( tag + classes[ 0 ] );
			if ( classes[ 1 ] ) {
				out.push( tag + classes[ 0 ] + classes[ 1 ] );
			}
			if ( attr ) {
				out.push( tag + classes[ 0 ] + attr );
			}
		}
		out.push( tag );
		if ( allowNth ) {
			out.push( tag + ( classes[ 0 ] || '' ) + ':nth-of-type(' + nthOfType( node ) + ')' );
			out.push( tag + ':nth-of-type(' + nthOfType( node ) + ')' );
		}

		return out;
	}

	function stableAncestor( node ) {
		let cur = node;
		while ( cur && cur.nodeType === 1 && cur !== document.body ) {
			if ( stableId( cur ) ) {
				const sel = '#' + window.CSS.escape( cur.id );
				if ( isUnique( sel, cur ) ) {
					return sel;
				}
			}
			cur = cur.parentElement;
		}
		return '';
	}

	// Walks up from the element, keeping the narrowest segment per level, and stops at the first unique match.
	function search( el, allowNth ) {
		let path = [];
		let node = el;

		for ( let depth = 0; depth < 12 && node && node.nodeType === 1 && node !== document.documentElement; depth++ ) {
			const anchor = stableAncestor( node.parentElement );
			let best = '';
			let bestCount = Infinity;

			for ( const seg of segments( node, allowNth ) ) {
				const sel = [ seg ].concat( path ).join( ' > ' );
				const list = matches( sel );
				const count = list ? list.length : 0;

				if ( count === 1 && list[ 0 ] === el ) {
					return sel;
				}
				if ( anchor && isUnique( anchor + ' ' + sel, el ) ) {
					return anchor + ' ' + sel;
				}
				if ( count > 0 && count < bestCount ) {
					best = seg;
					bestCount = count;
				}
			}

			if ( ! best || node === document.body ) {
				return '';
			}

			path = [ best ].concat( path );
			node = node.parentElement;
		}

		return '';
	}

	function buildSelector( el ) {
		if ( ! window.CSS || ! window.CSS.escape ) {
			return '';
		}

		if ( stableId( el ) ) {
			const own = '#' + window.CSS.escape( el.id );
			if ( isUnique( own, el ) ) {
				return own;
			}
		}

		// nth-of-type only when nothing meaningful is unique, since it breaks as soon as the layout shifts.
		return [ search( el, false ), search( el, true ) ].find( ( sel ) => sel && sel.length <= 500 ) || '';
	}

	/* ---------- Rich text ---------- */

	function parseHtml( html ) {
		// DOMParser documents are inert: nothing in them runs or loads.
		return new window.DOMParser().parseFromString( '<body>' + ( html || '' ) + '</body>', 'text/html' ).body;
	}

	// Rebuilds the markup from the allow-list only, turning editor <div>s into paragraphs.
	function cleanHtml( source ) {
		const out = document.createElement( 'div' );

		const walk = ( from, to ) => {
			from.childNodes.forEach( ( node ) => {
				if ( node.nodeType === 3 ) {
					to.appendChild( document.createTextNode( node.nodeValue ) );
					return;
				}
				if ( node.nodeType !== 1 ) {
					return;
				}

				let tag = node.tagName === 'DIV' ? 'P' : node.tagName;
				if ( tag === 'P' && to.closest && to.closest( 'p, li' ) ) {
					tag = '';
				}
				if ( ALLOWED_TAGS.indexOf( tag ) === -1 ) {
					walk( node, to );
					return;
				}

				const el = document.createElement( tag );
				if ( tag === 'A' ) {
					const href = ( node.getAttribute( 'href' ) || '' ).trim();
					if ( SAFE_HREF.test( href ) ) {
						el.setAttribute( 'href', href );
					}
					if ( node.getAttribute( 'target' ) === '_blank' ) {
						el.setAttribute( 'target', '_blank' );
						el.setAttribute( 'rel', 'noopener' );
					}
				}
				walk( node, el );
				to.appendChild( el );
			} );
		};

		walk( source, out );

		// Loose text next to paragraphs gets its own paragraph, so wpautop has nothing to guess.
		if ( Array.from( out.children ).some( ( n ) => BLOCK_TAGS.indexOf( n.tagName ) !== -1 ) ) {
			let run = null;
			Array.from( out.childNodes ).forEach( ( node ) => {
				const block = node.nodeType === 1 && BLOCK_TAGS.indexOf( node.tagName ) !== -1;
				if ( block ) {
					run = null;
					return;
				}
				if ( ! run ) {
					run = document.createElement( 'p' );
					out.insertBefore( run, node );
				}
				run.appendChild( node );
			} );
		}

		out.querySelectorAll( 'p' ).forEach( ( p ) => {
			if ( ! p.textContent.trim() ) {
				p.remove();
			}
		} );

		if ( ! out.textContent.trim() ) {
			return '';
		}
		return out.innerHTML.trim();
	}

	// Plain-text content becomes paragraphs for editing; HTML content is cleaned before it touches the page.
	function editableHtml( content ) {
		const raw = String( content || '' );
		const html = /<(p|ul|ol)\b/i.test( raw )
			? raw
			: raw
					.split( /\n\s*\n/ )
					.filter( ( para ) => para.trim() )
					.map( ( para ) => '<p>' + para.replace( /\n/g, '<br>' ) + '</p>' )
					.join( '' );
		return cleanHtml( parseHtml( html ) );
	}

	/* ---------- Bubble ---------- */

	let openId = '';
	let openEl = null;
	let freshId = ''; // A step I just created; dropped again if it's closed still empty.
	let cancelWait = null;
	let bubbleKey = '';
	let bubbleDragging = false;
	let swallowUntil = 0;

	function buildBubble() {
		const parts = UI.createPop( 'awb-build-pop' );
		const { pop, title, body, footer } = parts;

		pop.classList.add( 'is-editing' );
		pop.setAttribute( 'aria-label', t( 'editingStep', 'Editing step' ) );
		pop.removeAttribute( 'aria-labelledby' );

		title.removeAttribute( 'tabindex' );
		title.setAttribute( 'contenteditable', 'true' );
		title.setAttribute( 'role', 'textbox' );
		title.setAttribute( 'aria-label', t( 'stepTitle', 'Step title' ) );
		title.setAttribute( 'data-placeholder', t( 'stepTitlePlaceholder', 'Step title' ) );
		title.setAttribute( 'spellcheck', 'true' );

		body.setAttribute( 'contenteditable', 'true' );
		body.setAttribute( 'role', 'textbox' );
		body.setAttribute( 'aria-multiline', 'true' );
		body.setAttribute( 'aria-label', t( 'stepText', 'Step text' ) );
		body.setAttribute( 'data-placeholder', t( 'stepTextPlaceholder', 'Write what this does…' ) );

		// What learners will see, shown but not usable.
		[ parts.prev, parts.skip, parts.next ].forEach( ( btn ) => {
			btn.disabled = true;
			btn.tabIndex = -1;
			btn.removeAttribute( 'data-awb' );
		} );
		parts.goto.remove();
		footer.setAttribute( 'aria-hidden', 'true' );

		const sideLabels = {
			top: t( 'placeTop', 'Show above the element' ),
			right: t( 'placeRight', 'Show on the right' ),
			bottom: t( 'placeBottom', 'Show below the element' ),
			left: t( 'placeLeft', 'Show on the left' ),
		};
		const sides = SIDES.map( ( side ) => {
			const btn = h( 'button', 'awb-pop__side', {
				type: 'button',
				'data-side': side,
				'aria-pressed': 'false',
				'aria-label': sideLabels[ side ],
				title: sideLabels[ side ],
			} );
			btn.appendChild( icon( side ) );
			pop.appendChild( btn );
			return btn;
		} );

		const tools = h( 'div', 'awb-pop__tools' );

		const seg = h( 'div', 'awb-seg awb-pop__advance', { role: 'group', 'aria-label': t( 'movesOn', 'Moves on' ) } );
		seg.appendChild( h( 'span', 'awb-seg__label', { text: t( 'movesOnLabel', 'Moves on:' ) } ) );
		const advance = {};
		[
			[ 'next', t( 'advanceNext', 'Next button' ) ],
			[ 'click', t( 'advanceClick', 'Click on element' ) ],
		].forEach( ( [ value, label ] ) => {
			advance[ value ] = h( 'button', 'awb-seg__btn', {
				type: 'button',
				'data-advance': value,
				'aria-pressed': 'false',
				text: label,
			} );
			seg.appendChild( advance[ value ] );
		} );

		const auto = h( 'button', 'awb-pop__side awb-pop__side--auto', {
			type: 'button',
			'data-side': 'auto',
			'aria-pressed': 'false',
			text: t( 'placementAuto', 'Auto' ),
			title: t( 'placementAutoHint', 'Let the bubble pick the side with the most room' ),
		} );

		const chapter = h( 'select', 'awb-pop__chapter', { 'aria-label': t( 'chapter', 'Chapter' ) } );
		const change = h( 'button', 'awb-pop__tool', { type: 'button', 'data-tool': 'change' } );
		change.append( icon( 'target' ), h( 'span', 'awb-pop__tool-label' ) );
		const del = h( 'button', 'awb-pop__tool awb-pop__tool--danger', { type: 'button', 'data-tool': 'delete' } );
		del.append( icon( 'trash' ), h( 'span', '', { text: t( 'delete', 'Delete' ) } ) );

		tools.append( seg, auto, chapter, change, del );
		pop.insertBefore( tools, footer );
		layer.root.appendChild( pop );

		return Object.assign( parts, { sides, auto, advance, seg, chapter, change, del, tools } );
	}

	function fillBubble( step ) {
		const index = tour.steps.indexOf( step );
		const total = tour.steps.length;
		const chapter = tour.chapters.find( ( c ) => c.id === step.chapter );
		const floating = ! step.selector;

		bubble.eyebrow.textContent = chapter ? chapter.title : '';
		bubble.title.textContent = step.title || '';
		bubble.body.innerHTML = editableHtml( step.content );
		markEmpty();

		bubble.count.textContent = fmt( t( 'popCount', '%1$d / %2$d' ), index + 1, total );
		bubble.prev.hidden = index === 0;
		bubble.next.textContent = index === total - 1 ? t( 'finish', 'Finish' ) : t( 'next', 'Next' );

		const chapters = tour.chapters.map( ( c, i ) =>
			h( 'option', '', { value: c.id, text: c.title || fmt( t( 'chapterN', 'Chapter %d' ), i + 1 ) } )
		);
		bubble.chapter.replaceChildren( ...chapters );
		bubble.chapter.value = step.chapter;

		bubble.change.querySelector( '.awb-pop__tool-label' ).textContent = floating
			? t( 'attachElement', 'Attach to element' )
			: t( 'changeElement', 'Change element' );

		bubble.pop.classList.toggle( 'is-floating', floating );
		bubble.seg.hidden = floating;
		bubble.auto.hidden = floating;
		bubble.sides.forEach( ( btn ) => ( btn.hidden = floating ) );
		syncBubbleControls( step );
	}

	function syncBubbleControls( step ) {
		const click = !! step.selector && step.advance === 'click';
		const placement = SIDES.indexOf( step.placement ) !== -1 ? step.placement : 'auto';

		Object.keys( bubble.advance ).forEach( ( value ) => {
			const pressed = ( click ? 'click' : 'next' ) === value;
			bubble.advance[ value ].setAttribute( 'aria-pressed', pressed ? 'true' : 'false' );
			bubble.advance[ value ].classList.toggle( 'is-active', pressed );
		} );
		bubble.sides.concat( bubble.auto ).forEach( ( btn ) => {
			const pressed = btn.getAttribute( 'data-side' ) === placement;
			btn.setAttribute( 'aria-pressed', pressed ? 'true' : 'false' );
			btn.classList.toggle( 'is-active', pressed );
		} );

		bubble.hint.hidden = ! click;
		bubble.next.hidden = click;
		bubble.pop.classList.toggle( 'is-click', click );
	}

	function markEmpty() {
		bubble.title.classList.toggle( 'is-empty', ! bubble.title.textContent.trim() );
		bubble.body.classList.toggle( 'is-empty', ! bubble.body.textContent.trim() && ! bubble.body.querySelector( 'li' ) );
	}

	function waitForTarget( selector, onDone ) {
		const started = Date.now();
		const timer = setInterval( () => {
			const el = findTarget( selector );
			if ( el || Date.now() - started > WAIT_MS ) {
				clearInterval( timer );
				cancelWait = null;
				onDone( el );
			}
		}, 150 );
		return () => clearInterval( timer );
	}

	function openBubble( id, opts ) {
		const options = opts || {};
		const step = findStep( id );
		if ( ! step ) {
			return;
		}

		if ( openId && openId !== id ) {
			closeBubble();
		}
		stopPick();

		openId = id;
		openEl = null;
		bubbleKey = '';
		fillBubble( step );
		reveal( bubble.pop, true );

		const attach = ( el ) => {
			if ( openId !== id ) {
				return;
			}
			openEl = el;
			if ( el ) {
				const r = el.getBoundingClientRect();
				if ( r.bottom < adminBarBottom() || r.top > window.innerHeight ) {
					el.scrollIntoView( { behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center', inline: 'nearest' } );
				}
			}
			positionBubble( true );
		};

		if ( step.selector ) {
			const el = options.el && options.el.isConnected ? options.el : findTarget( step.selector );
			if ( el ) {
				attach( el );
			} else {
				positionBubble( true );
				cancelWait = waitForTarget( step.selector, attach );
			}
		} else {
			attach( null );
		}

		markOutlineOpen();
		positionMarkers();
		bubble.title.focus( { preventScroll: true } );
	}

	function closeBubble() {
		if ( ! openId ) {
			return;
		}

		const step = findStep( openId );
		const fresh = freshId === openId;

		if ( cancelWait ) {
			cancelWait();
			cancelWait = null;
		}
		openId = '';
		openEl = null;
		freshId = '';
		reveal( bubble.pop, false );
		UI.placeSpotlight( layer.spotlight, null );
		reveal( layer.dim, false );
		hideFormat();

		// A step placed and left empty was a misclick, not content.
		if ( fresh && step && ! step.title.trim() && ! step.content ) {
			tour.steps.splice( tour.steps.indexOf( step ), 1 );
			refresh();
			queueSave();
			return;
		}

		markOutlineOpen();
		positionMarkers();
	}

	function markOutlineOpen() {
		ui.chapters.querySelectorAll( '.awb-build__item' ).forEach( ( li ) => {
			li.classList.toggle( 'is-open', li.getAttribute( 'data-step' ) === openId );
		} );
	}

	function positionBubble( force ) {
		if ( ! openId || bubbleDragging ) {
			return;
		}

		const step = findStep( openId );
		if ( ! step ) {
			closeBubble();
			return;
		}

		if ( openEl && ! openEl.isConnected ) {
			openEl = findTarget( step.selector );
		}

		const r = openEl ? openEl.getBoundingClientRect() : null;
		const rect = r && ( r.width >= 1 || r.height >= 1 ) ? r : null;
		const safe = UI.safeArea();
		const key = [
			rect ? [ rect.top, rect.left, rect.width, rect.height ].map( Math.round ).join( ':' ) : '-',
			safe.vw,
			safe.vh,
			bubble.pop.offsetWidth,
			bubble.pop.offsetHeight,
			step.placement,
		].join( ',' );

		if ( key === bubbleKey && ! force ) {
			return;
		}
		bubbleKey = key;

		const missing = !! step.selector && ! rect;
		bubble.notice.hidden = ! missing;
		bubble.noticeText.textContent = t(
			'elementMissing',
			'I can’t find this element on the page right now. Use Change element to point at it again.'
		);

		UI.placeSpotlight( layer.spotlight, rect );
		reveal( layer.dim, ! step.selector );
		UI.placePop( bubble.pop, rect, { placement: step.placement, safe, lost: missing } );
	}

	function commitBubble() {
		const step = findStep( openId );
		if ( ! step ) {
			return;
		}

		step.title = bubble.title.textContent.replace( /\s+/g, ' ' ).trim().slice( 0, 200 );
		step.content = cleanHtml( bubble.body );
		markEmpty();

		const item = ui.chapters.querySelector( '[data-step="' + step.id + '"] .awb-build__name' );
		if ( item ) {
			item.textContent = step.title || t( 'untitledStep', 'Untitled step' );
		}
		queueSave();
	}

	function setPlacement( side ) {
		const step = findStep( openId );
		if ( ! step || ! step.selector ) {
			return;
		}
		step.placement = SIDES.indexOf( side ) !== -1 ? side : 'auto';
		syncBubbleControls( step );
		positionBubble( true );
		queueSave();
	}

	// Dropped bubble: the side of the element it ended up closest to, measured from the centres.
	function nearestSide( pr, er ) {
		const dx = ( pr.left + pr.width / 2 - ( er.left + er.width / 2 ) ) / Math.max( 1, ( er.width + pr.width ) / 2 );
		const dy = ( pr.top + pr.height / 2 - ( er.top + er.height / 2 ) ) / Math.max( 1, ( er.height + pr.height ) / 2 );
		if ( Math.abs( dx ) > Math.abs( dy ) ) {
			return dx > 0 ? 'right' : 'left';
		}
		return dy > 0 ? 'bottom' : 'top';
	}

	function dragBubble( e ) {
		const step = findStep( openId );
		if ( ! step || ! step.selector || ! openEl ) {
			return;
		}

		e.preventDefault();
		startDrag( e, {
			begin( ctx ) {
				const r = bubble.pop.getBoundingClientRect();
				ctx.dx = ctx.x0 - r.left;
				ctx.dy = ctx.y0 - r.top;
				bubbleDragging = true;
				bubble.pop.classList.add( 'is-dragging' );
				hideFormat();
			},
			move( ctx, ev ) {
				bubble.pop.style.left = Math.round( ev.clientX - ctx.dx ) + 'px';
				bubble.pop.style.top = Math.round( ev.clientY - ctx.dy ) + 'px';
			},
			end() {
				bubbleDragging = false;
				bubble.pop.classList.remove( 'is-dragging' );
				if ( openEl && openEl.isConnected ) {
					setPlacement( nearestSide( bubble.pop.getBoundingClientRect(), openEl.getBoundingClientRect() ) );
				} else {
					positionBubble( true );
				}
			},
		} );
	}

	function deleteOpenStep() {
		const step = findStep( openId );
		if ( ! step ) {
			return;
		}

		const index = tour.steps.indexOf( step );
		freshId = '';
		closeBubble();
		tour.steps.splice( index, 1 );
		refresh();
		queueSave();

		toast( fmt( t( 'stepDeleted', 'Deleted “%s”.' ), step.title || t( 'untitledStep', 'Untitled step' ) ), {
			label: t( 'undo', 'Undo' ),
			run: () => {
				if ( ! active || ! tour || findStep( step.id ) ) {
					return;
				}
				if ( chapterIds().indexOf( step.chapter ) === -1 ) {
					step.chapter = currentChapter();
				}
				tour.steps.splice( Math.min( index, tour.steps.length ), 0, step );
				regroup();
				refresh();
				queueSave();
			},
		} );
	}

	/* ---------- Format bar ---------- */

	function hideFormat() {
		if ( ui && ! ui.format.hidden ) {
			ui.format.hidden = true;
		}
	}

	function positionFormat() {
		const sel = bubble ? bubble.body.ownerDocument.defaultView.getSelection() : null;
		const range = sel && sel.rangeCount ? sel.getRangeAt( 0 ) : null;

		if ( ! openId || bubbleDragging || ! range || range.collapsed || ! bubble.body.contains( range.commonAncestorContainer ) ) {
			hideFormat();
			return;
		}

		const r = range.getBoundingClientRect();
		if ( ! r.width && ! r.height ) {
			hideFormat();
			return;
		}

		ui.format.hidden = false;
		const vw = document.documentElement.clientWidth;
		const w = ui.format.offsetWidth;
		const ht = ui.format.offsetHeight;
		const above = r.top - ht - 8;

		ui.format.classList.toggle( 'is-below', above < adminBarBottom() + 4 );
		ui.format.style.left = Math.round( clamp( r.left + r.width / 2 - w / 2, EDGE, Math.max( EDGE, vw - w - EDGE ) ) ) + 'px';
		ui.format.style.top = Math.round( above < adminBarBottom() + 4 ? r.bottom + 8 : above ) + 'px';

		ui.format.querySelectorAll( '[data-format]' ).forEach( ( btn ) => {
			const cmd = btn.getAttribute( 'data-format' );
			let pressed = false;
			try {
				pressed = cmd !== 'link' && document.queryCommandState( cmd );
			} catch ( e ) {}
			btn.setAttribute( 'aria-pressed', pressed ? 'true' : 'false' );
		} );
	}

	function applyFormat( cmd ) {
		if ( ! openId ) {
			return;
		}

		// execCommand is old but still the only way to toggle inline formatting that respects undo.
		if ( cmd === 'link' ) {
			const sel = bubble.body.ownerDocument.defaultView.getSelection();
			const saved = sel && sel.rangeCount ? sel.getRangeAt( 0 ).cloneRange() : null;
			let url = window.prompt( t( 'linkPrompt', 'Link address (URL)' ), 'https://' );
			if ( ! url || ! url.trim() || url.trim() === 'https://' ) {
				return;
			}
			url = url.trim();
			if ( ! SAFE_HREF.test( url ) ) {
				url = 'https://' + url.replace( /^[a-z]+:\/*/i, '' );
			}
			bubble.body.focus( { preventScroll: true } );
			if ( saved ) {
				sel.removeAllRanges();
				sel.addRange( saved );
			}
			document.execCommand( 'createLink', false, url );
		} else {
			document.execCommand( cmd, false );
		}

		commitBubble();
		positionFormat();
	}

	/* ---------- Dock actions ---------- */

	async function preview() {
		if ( ! tour || ! tour.steps.length ) {
			return;
		}

		// The preview tab reads the server copy, so my latest edits go first.
		commitIfOpen();
		await flushSave();

		const here = tour.steps.findIndex( ( s ) => isHere( s ) );
		const index = here === -1 ? 0 : here;
		const step = tour.steps[ index ];

		// noopener: the new tab starts with its own sessionStorage, so build mode doesn't follow it.
		window.open( adminHref( step.url, { awb_preview: tourId, awb_step: index } ), '_blank', 'noopener' );
	}

	function commitIfOpen() {
		if ( openId ) {
			commitBubble();
		}
	}

	async function goSomewhere( href ) {
		commitIfOpen();
		await flushSave();
		window.location.href = href;
	}

	function openFromOutline( id ) {
		const step = findStep( id );
		if ( ! step ) {
			return;
		}

		if ( isHere( step ) ) {
			if ( openId === id ) {
				closeBubble();
			} else {
				openBubble( id );
			}
			return;
		}

		// Build mode follows me there and opens the bubble on arrival.
		session.open = id;
		saveSession();
		goSomewhere( adminHref( step.url ) );
	}

	async function done() {
		const id = tourId;

		commitIfOpen();
		closeBubble();
		const saved = await flushSave();

		if ( ! saved && dirty && ! window.confirm( t( 'leaveUnsaved', 'Some changes couldn’t be saved. Leave build mode anyway?' ) ) ) {
			return;
		}

		removeStore( BUILD_KEY );
		stop();
		toast( t( 'buildOff', 'Build mode is off.' ), { label: t( 'openOverview', 'Open overview' ), href: cfg.editUrl + id } );
	}

	function toggleStatus() {
		tour.status = tour.status === 'publish' ? 'draft' : 'publish';
		renderHead();
		queueSave();

		if ( tour.status === 'publish' && ! tour.settings.roles.length && ! tour.settings.users.length ) {
			toast( t( 'liveNobody', 'It’s live, but nobody is selected to see it yet. Open Settings to choose who.' ) );
		}
	}

	function isOpenSettings() {
		return !! ui && ui.settingsPanel.classList.contains( 'is-open' );
	}

	/* ---------- Refresh ---------- */

	function refresh() {
		if ( ! tour || ! ui ) {
			return;
		}
		renderHead();
		renderOutline();
		renderMarkers();
		if ( isOpenSettings() ) {
			renderSettings();
		}
		if ( openId ) {
			const step = findStep( openId );
			if ( step ) {
				const index = tour.steps.indexOf( step );
				bubble.count.textContent = fmt( t( 'popCount', '%1$d / %2$d' ), index + 1, tour.steps.length );
				const chapter = tour.chapters.find( ( c ) => c.id === step.chapter );
				bubble.eyebrow.textContent = chapter ? chapter.title : '';
			}
		}
		schedule();
		applyPos();
	}

	/* ---------- Events ---------- */

	function onMenuClick( e ) {
		const btn = e.target.closest( '[data-build]' );
		if ( ! btn || btn.disabled ) {
			return;
		}

		const action = btn.getAttribute( 'data-build' );
		const item = btn.closest( '[data-step]' );
		const section = btn.closest( '[data-chapter]' );

		switch ( action ) {
			case 'status':
				toggleStatus();
				break;
			case 'collapse':
				setCollapsed( true );
				break;
			case 'close':
				done();
				break;
			case 'pick':
				if ( picking && ! picking.stepId ) {
					stopPick();
				} else {
					startPick();
				}
				break;
			case 'float':
				createStep( { url: currentUrl(), screen: cfg.screen || '', selector: '', label: '' }, null );
				break;
			case 'preview':
				preview();
				break;
			case 'settings':
				toggleSettings( ! isOpenSettings() );
				break;
			case 'settings-back':
				toggleSettings( false );
				break;
			case 'retry':
				if ( tour ) {
					dirty = true;
					setStatus( 'saving' );
					flushSave();
				} else {
					load();
				}
				break;
			case 'add-chapter':
				addChapter();
				break;
			case 'delete-chapter':
				deleteChapter( section.getAttribute( 'data-chapter' ) );
				break;
			case 'toggle-chapter': {
				const id = section.getAttribute( 'data-chapter' );
				if ( collapsedChapters.has( id ) ) {
					collapsedChapters.delete( id );
				} else {
					collapsedChapters.add( id );
				}
				section.classList.toggle( 'is-collapsed', collapsedChapters.has( id ) );
				btn.setAttribute( 'aria-expanded', collapsedChapters.has( id ) ? 'false' : 'true' );
				break;
			}
			case 'current':
				if ( ! e.target.closest( 'input, textarea, button' ) ) {
					setCurrentChapter( section.getAttribute( 'data-chapter' ) );
				}
				break;
			case 'open':
				openFromOutline( item.getAttribute( 'data-step' ) );
				break;
			case 'marker':
				if ( openId === btn.getAttribute( 'data-step' ) ) {
					closeBubble();
				} else {
					openBubble( btn.getAttribute( 'data-step' ) );
				}
				break;
			case 'role': {
				const slug = btn.getAttribute( 'data-role' );
				const roles = tour.settings.roles;
				tour.settings.roles = roles.indexOf( slug ) === -1 ? roles.concat( slug ) : roles.filter( ( r ) => r !== slug );
				renderSettings();
				queueSave();
				break;
			}
			case 'add-user': {
				const id = toInt( btn.getAttribute( 'data-user' ) );
				if ( id && tour.settings.users.indexOf( id ) === -1 ) {
					tour.settings.users.push( id );
					queueSave();
				}
				ui.search.value = '';
				ui.results.hidden = true;
				renderSettings();
				ui.search.focus();
				break;
			}
			case 'remove-user': {
				const id = toInt( btn.getAttribute( 'data-user' ) );
				tour.settings.users = tour.settings.users.filter( ( u ) => u !== id );
				renderSettings();
				queueSave();
				ui.search.focus();
				break;
			}
			case 'bar':
				tour.settings.bar_position = btn.getAttribute( 'data-value' ) === 'bottom' ? 'bottom' : 'top';
				renderSettings();
				queueSave();
				break;
		}
	}

	function onMenuInput( e ) {
		const node = e.target;
		if ( ! tour ) {
			return;
		}

		const field = node.getAttribute( 'data-field' );
		const section = node.closest( '[data-chapter]' );

		if ( node === ui.title ) {
			tour.title = node.value.slice( 0, 200 );
			queueSave();
		} else if ( field && section ) {
			const chapter = tour.chapters.find( ( c ) => c.id === section.getAttribute( 'data-chapter' ) );
			if ( chapter ) {
				chapter[ field === 'chapter-title' ? 'title' : 'description' ] = node.value;
				const open = findStep( openId );
				if ( open && open.chapter === chapter.id && field === 'chapter-title' ) {
					bubble.eyebrow.textContent = node.value;
				}
				queueSave();
			}
		} else if ( node === ui.search ) {
			searchPeople();
		} else if ( node.hasAttribute( 'data-setting' ) ) {
			const key = node.getAttribute( 'data-setting' );
			tour.settings[ key ] = key === 'refresh_days' ? clamp( toInt( node.value ), 0, 365 ) : node.checked;
			if ( key === 'allow_replay' ) {
				renderSettings();
			}
			queueSave();
		}
	}

	function onMenuKey( e ) {
		const node = e.target;

		if ( e.key === 'Enter' && ( node === ui.title || node.classList.contains( 'awb-build__chapter-title' ) ) ) {
			e.preventDefault();
			node.blur();
			return;
		}

		if ( ( e.key === 'ArrowUp' || e.key === 'ArrowDown' ) && node.classList.contains( 'awb-build__grip' ) ) {
			e.preventDefault();
			moveStep( node.closest( '[data-step]' ).getAttribute( 'data-step' ), e.key === 'ArrowUp' ? -1 : 1 );
		}
	}

	function onBubbleClick( e ) {
		const step = findStep( openId );
		if ( ! step ) {
			return;
		}

		const side = e.target.closest( '[data-side]' );
		const adv = e.target.closest( '[data-advance]' );
		const tool = e.target.closest( '[data-tool]' );

		if ( side ) {
			setPlacement( side.getAttribute( 'data-side' ) );
		} else if ( adv ) {
			step.advance = adv.getAttribute( 'data-advance' ) === 'click' ? 'click' : 'next';
			syncBubbleControls( step );
			positionBubble( true );
			queueSave();
		} else if ( tool && tool.getAttribute( 'data-tool' ) === 'change' ) {
			commitBubble();
			freshId = '';
			startPick( step.id );
		} else if ( tool && tool.getAttribute( 'data-tool' ) === 'delete' ) {
			deleteOpenStep();
		}
	}

	function onBubbleKey( e ) {
		if ( e.target === bubble.title && e.key === 'Enter' ) {
			e.preventDefault();
			bubble.body.focus();
			return;
		}

		if ( e.target === bubble.body && ( e.ctrlKey || e.metaKey ) && ! e.altKey && ! e.shiftKey ) {
			const cmd = { b: 'bold', i: 'italic', k: 'link' }[ e.key.toLowerCase() ];
			if ( cmd ) {
				e.preventDefault();
				applyFormat( cmd );
			}
		}
	}

	// Paste as plain text: the allow-list would strip most of a rich paste anyway, and badly.
	function onBubblePaste( e ) {
		const inTitle = bubble.title.contains( e.target );
		if ( ! inTitle && ! bubble.body.contains( e.target ) ) {
			return;
		}
		e.preventDefault();
		let text = e.clipboardData ? e.clipboardData.getData( 'text/plain' ) : '';
		if ( inTitle ) {
			text = text.replace( /\s+/g, ' ' );
		}
		document.execCommand( 'insertText', false, text );
	}

	function onOutsidePointer( e ) {
		swallowUntil = 0;
		if ( ! openId || picking || bubbleDragging ) {
			return;
		}

		const node = e.target;
		const inside =
			( node instanceof window.Node && ( ui.root.contains( node ) || bubble.pop.contains( node ) ) ) ||
			( !! toastEl && toastEl.contains( node ) );

		if ( ! inside ) {
			closeBubble();
			// The press that dismisses the bubble shouldn't also follow a link underneath.
			swallowUntil = Date.now() + 1000;
		}
	}

	function onDocClick( e ) {
		if ( Date.now() < swallowUntil ) {
			swallowUntil = 0;
			e.preventDefault();
			e.stopPropagation();
		}
	}

	function onKey( e ) {
		if ( e.key !== 'Escape' || e.defaultPrevented ) {
			return;
		}

		if ( picking ) {
			const stepId = picking.stepId;
			e.preventDefault();
			e.stopPropagation();
			stopPick();
			if ( stepId ) {
				openBubble( stepId );
			} else {
				ui.addBtn.focus();
			}
		} else if ( openId ) {
			e.preventDefault();
			commitBubble();
			closeBubble();
		} else if ( isOpenSettings() && ui.menu.contains( e.target ) ) {
			e.preventDefault();
			toggleSettings( false );
		}
	}

	function bindEvents() {
		on( ui.menu, 'click', onMenuClick );
		on( ui.markers, 'click', onMenuClick );
		on( ui.menu, 'input', onMenuInput );
		on( ui.menu, 'change', onMenuInput );
		on( ui.menu, 'keydown', onMenuKey );
		on( ui.menu, 'focusin', ( e ) => {
			const section = e.target.closest( '[data-chapter]' );
			if ( section && e.target.classList.contains( 'awb-build__chapter-title' ) ) {
				setCurrentChapter( section.getAttribute( 'data-chapter' ) );
			}
		} );
		on( ui.gotoSelect, 'change', () => {
			if ( ui.gotoSelect.value ) {
				goSomewhere( adminHref( ui.gotoSelect.value ) );
			}
		} );

		on( ui.head, 'pointerdown', ( e ) => {
			if ( ! e.target.closest( 'input, button, select, textarea' ) ) {
				e.preventDefault();
				dragMenu( e, ui.menu );
			}
		} );
		on( ui.launcher, 'pointerdown', ( e ) => dragMenu( e, ui.launcher, () => setCollapsed( false ) ) );
		on( ui.launcher, 'keydown', ( e ) => {
			if ( e.key === 'Enter' || e.key === ' ' ) {
				e.preventDefault();
				setCollapsed( false );
			}
		} );
		on( ui.outline, 'pointerdown', ( e ) => {
			const grip = e.target.closest( '.awb-build__grip' );
			if ( grip ) {
				e.preventDefault();
				dragStep( e, grip.closest( '.awb-build__item' ) );
			}
		} );

		on( ui.format, 'click', ( e ) => {
			const btn = e.target.closest( '[data-format]' );
			if ( btn ) {
				applyFormat( btn.getAttribute( 'data-format' ) );
			}
		} );

		on( bubble.pop, 'click', onBubbleClick );
		on( bubble.pop, 'keydown', onBubbleKey );
		on( bubble.pop, 'paste', onBubblePaste );
		on( bubble.pop, 'input', () => {
			commitBubble();
			schedule();
		} );
		on( bubble.chapter, 'change', () => {
			const step = findStep( openId );
			if ( step ) {
				placeInChapter( step, bubble.chapter.value, false );
				refresh();
				queueSave();
			}
		} );
		on( bubble.body, 'focus', () => {
			try {
				document.execCommand( 'defaultParagraphSeparator', false, 'p' );
			} catch ( e ) {}
		} );
		on( bubble.pop, 'pointerdown', ( e ) => {
			if ( ! e.target.closest( '[contenteditable="true"], button, select, input, a, label, .awb-pop__tools' ) ) {
				dragBubble( e );
			}
		} );

		on( document, 'pointerdown', onOutsidePointer, true );
		on( document, 'click', onDocClick, true );
		on( window, 'keydown', onKey, true );
		on( document, 'selectionchange', schedule );
		on( window, 'scroll', schedule, { capture: true, passive: true } );
		on( window, 'resize', () => {
			applyPos();
			schedule();
		} );

		const observer = new window.MutationObserver( ( records ) => {
			if ( records.some( ( r ) => ! isOwn( r.target ) ) ) {
				schedule();
			}
		} );
		observer.observe( document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: [ 'class', 'style', 'hidden', 'open' ],
		} );
		controller.signal.addEventListener( 'abort', () => observer.disconnect() );

		if ( window.ResizeObserver ) {
			const sizes = new window.ResizeObserver( () => applyPos() );
			sizes.observe( ui.menu );
			controller.signal.addEventListener( 'abort', () => sizes.disconnect() );
		}

		// Late elements and CSS-only changes fire nothing I can listen to.
		timers.push(
			setInterval( () => {
				if ( tour && ! document.hidden ) {
					resolveMarkers();
					schedule();
				}
			}, 1000 )
		);
	}

	/* ---------- Lifecycle ---------- */

	function adopt( data, focusTitle ) {
		tour = normalize( data );
		regroup();
		ui.addBtn.disabled = false;
		ui.floatBtn.disabled = false;
		ui.settingsBtn.disabled = false;
		refresh();
		setStatus( 'saved', ' ' );

		if ( focusTitle ) {
			if ( session.collapsed ) {
				setCollapsed( false );
			}
			ui.title.focus();
			ui.title.select();
		}

		const pending = session.open;
		if ( pending ) {
			delete session.open;
			saveSession();
			const step = findStep( pending );
			if ( step && isHere( step ) ) {
				openBubble( step.id );
			}
		}
	}

	async function load( focusTitle ) {
		setStatus( 'loading' );
		ui.addBtn.disabled = true;
		ui.floatBtn.disabled = true;
		ui.settingsBtn.disabled = true;
		ui.previewBtn.disabled = true;

		const res = await request( 'GET', apiUrl( 'tours/' + tourId, { context: 'edit' } ) );
		if ( ! active ) {
			return;
		}

		if ( ! res.ok || ! res.data || ! Array.isArray( res.data.steps ) ) {
			ui.title.value = '';
			ui.title.placeholder = t( 'builderLabel', 'Walkthrough builder' );
			setStatus( 'error', errorText( res, 'load' ) );
			return;
		}

		adopt( res.data, focusTitle );
	}

	function start( opts ) {
		const options = opts || {};

		active = true;
		controller = new window.AbortController();
		tourId = toInt( session.tour );
		pos = readStore( POS_KEY, true );

		layer = UI.createLayer( 'awb-root--build' );
		ui = buildMenu();
		bubble = buildBubble();
		bindEvents();

		ui.menu.hidden = !! session.collapsed;
		ui.launcher.hidden = ! session.collapsed;
		applyPos();

		// The player steps aside if it was running a walkthrough on this page.
		window.dispatchEvent( new window.CustomEvent( 'awb:build', { detail: { tour: tourId } } ) );

		if ( options.data ) {
			adopt( options.data, options.focusTitle );
		} else {
			load( options.focusTitle );
		}
	}

	function stop() {
		stopPick();
		if ( cancelWait ) {
			cancelWait();
			cancelWait = null;
		}
		if ( dragCleanup ) {
			dragCleanup();
		}
		clearTimeout( saveTimer );
		clearTimeout( searchTimer );
		timers.forEach( ( id ) => clearInterval( id ) );
		timers = [];
		if ( layoutRaf ) {
			window.cancelAnimationFrame( layoutRaf );
			layoutRaf = 0;
		}
		controller.abort();

		ui.root.remove();
		layer.root.remove();
		document.documentElement.classList.remove( 'awb-build-picking' );

		active = false;
		dirty = false;
		syncLeaveGuard();
		openId = '';
		openEl = null;
		freshId = '';
		tour = null;
		ui = null;
		layer = null;
		bubble = null;
		markerItems = [];
	}

	/* ---------- New walkthrough from the toolbar ---------- */

	let creating = false;

	async function onNewClick( e ) {
		const link = e.target instanceof window.Element ? e.target.closest( 'a[data-awb-new]' ) : null;
		if ( ! link ) {
			return;
		}

		e.preventDefault();
		e.stopPropagation();
		link.blur();

		if ( creating ) {
			return;
		}
		creating = true;

		if ( active ) {
			commitIfOpen();
			await flushSave();
		}

		const res = await request( 'POST', apiUrl( 'tours' ), JSON.stringify( { title: t( 'newTourTitle', 'New walkthrough' ) } ) );
		creating = false;

		if ( ! res.ok || ! res.data || ! toInt( res.data.id ) ) {
			toast( errorText( res, 'create' ) );
			return;
		}

		if ( active ) {
			stop();
		}

		const chapters = Array.isArray( res.data.chapters ) ? res.data.chapters : [];
		session = { tour: toInt( res.data.id ), chapter: chapters[ 0 ] ? chapters[ 0 ].id : '', collapsed: false };
		saveSession();
		start( { data: res.data, focusTitle: true } );
	}

	document.addEventListener( 'click', onNewClick, true );

	/* ---------- Boot ---------- */

	// A preview tab stays a preview, even if the browser copied this tab's build flag into it.
	if ( params.has( 'awb_preview' ) && ! params.has( 'awb_build' ) ) {
		removeStore( BUILD_KEY );
		return;
	}

	session = readStore( BUILD_KEY );
	const urlTour = toInt( params.get( 'awb_build' ) );

	if ( urlTour ) {
		const same = !! session && toInt( session.tour ) === urlTour;
		session = {
			tour: urlTour,
			chapter: params.get( 'awb_chapter' ) || ( same ? session.chapter : '' ),
			collapsed: same && !! session.collapsed,
		};
		saveSession();
	}

	if ( ! session || typeof session !== 'object' || ! toInt( session.tour ) ) {
		session = null;
		return;
	}

	stripParams();
	start( { focusTitle: !! cfg.newTour } );
} )();
