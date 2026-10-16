/**
 * Admin Walkthrough Builder player: walks people through wp-admin with a popover,
 * a spotlight on the element and a YouTube-style chapter bar.
 */
( function () {
	'use strict';

	if ( ! document.body || window.top !== window.self ) {
		return;
	}

	// Both awb scripts strip awb_* params, so whichever runs first keeps the original query for the other.
	if ( typeof window.awbQuery !== 'string' ) {
		window.awbQuery = window.location.search;
	}

	// Everything up to window.awbUI must work without a player config: the builder reuses it in build mode.
	const cfg = window.awbPlayer || {};

	const RUN_KEY = 'awb_run';
	const BUILD_KEY = 'awb_build';

	const WAIT_MS = 4000; // How long a late element gets to show up.
	const CLICK_NAV_MS = 400; // How long a click-to-continue gets to start a navigation.
	const STUCK_MS = 3000;
	const HIDE_MS = 200; // Matches the CSS exit transitions.
	const SETTLE_MS = 350;
	const TOAST_MS = 4500;
	const CARD_HIDE_MS = 220;
	const SAFETY_MS = 500;

	const PAD = 8; // Spotlight padding around the element.
	const GAP = 14; // Spotlight edge to popover, room for the arrow.
	const EDGE = 12;
	const CARD_GAP = 10;
	const ARROW_INSET = 18;
	const MOBILE = 782;

	const SIDES = [ 'bottom', 'top', 'right', 'left' ];
	const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
	const REMIND_DAYS = [ 3, 7, 14, 30 ];

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

	// Widgets that use the arrow keys themselves.
	const KEY_WIDGETS =
		'[role="slider"],[role="listbox"],[role="menu"],[role="menubar"],[role="tablist"],[role="grid"],[role="tree"],[role="combobox"],[role="spinbutton"]';

	const ICONS = {
		prev: [ 'M15 18l-6-6 6-6' ],
		skip: [ 'M6 5l9 7-9 7z', 'M18 5v14' ],
		'skip-chapter': [ 'M3 6l8 6-8 6z', 'M12 6l8 6-8 6z' ],
		list: [ 'M9 6h11', 'M9 12h11', 'M9 18h11', 'M4.5 6h.01', 'M4.5 12h.01', 'M4.5 18h.01' ],
		minimize: [ 'M5 12h14' ],
		exit: [ 'M18 6L6 18', 'M6 6l12 12' ],
		restore: [ 'M8 5.5v13l10.5-6.5z' ],
		check: [ 'M20 6L9 17l-5-5' ],
	};

	const i18n = cfg.i18n || {};

	/* ---------- Helpers ---------- */

	function t( key, fallback ) {
		return typeof i18n[ key ] === 'string' && i18n[ key ] !== '' ? i18n[ key ] : fallback;
	}

	// sprintf-lite for the translated strings: %s, %d and numbered %1$s.
	function fmt( str, ...args ) {
		let i = 0;
		return String( str ).replace( /%(?:(\d+)\$)?([sd%])/g, ( match, pos, type ) => {
			if ( type === '%' ) {
				return '%';
			}
			const value = args[ pos ? parseInt( pos, 10 ) - 1 : i++ ];
			return value === undefined || value === null ? '' : String( value );
		} );
	}

	function stepsLabel( n ) {
		return n === 1 ? t( 'oneStep', '1 step' ) : fmt( t( 'nSteps', '%d steps' ), n );
	}

	function clamp( n, min, max ) {
		return Math.min( max, Math.max( min, n ) );
	}

	function toInt( value ) {
		const n = parseInt( value, 10 );
		return isNaN( n ) || n < 0 ? 0 : n;
	}

	function reducedMotion() {
		return !! ( window.matchMedia && window.matchMedia( '(prefers-reduced-motion: reduce)' ).matches );
	}

	function readStore( key ) {
		try {
			const raw = window.sessionStorage.getItem( key );
			return raw ? JSON.parse( raw ) : null;
		} catch ( e ) {
			return null;
		}
	}

	function writeStore( key, value ) {
		try {
			window.sessionStorage.setItem( key, JSON.stringify( value ) );
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
		if ( ! keys.length ) {
			return;
		}

		keys.forEach( ( key ) => url.searchParams.delete( key ) );
		window.history.replaceState( window.history.state, '', url.pathname + url.search + url.hash );
	}

	// Admin-relative "file?query" with the noise removed, so two URLs for the same screen compare equal.
	function adminPath( href ) {
		try {
			const url = new URL( href, cfg.adminUrl );
			const base = new URL( cfg.adminUrl );
			const path =
				url.pathname.indexOf( base.pathname ) === 0
					? url.pathname.slice( base.pathname.length )
					: url.pathname.replace( /^.*\/wp-admin\//, '' );
			const query = new URLSearchParams( url.search );

			[ ...query.keys() ].forEach( ( key ) => {
				if ( key.indexOf( 'awb_' ) === 0 || VOLATILE_PARAMS.indexOf( key ) !== -1 ) {
					query.delete( key );
				}
			} );
			query.sort();

			const qs = query.toString();
			return ( path || 'index.php' ) + ( qs ? '?' + qs : '' );
		} catch ( e ) {
			return '';
		}
	}

	function stepHref( step, extra ) {
		const url = new URL( cfg.adminUrl + ( step.url || 'index.php' ), window.location.href );
		Object.keys( extra || {} ).forEach( ( key ) => url.searchParams.set( key, extra[ key ] ) );
		return url.toString();
	}

	function isTyping( node ) {
		if ( ! node || node.nodeType !== 1 ) {
			return false;
		}
		if ( node.isContentEditable || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT' ) {
			return true;
		}
		if ( node.tagName === 'INPUT' ) {
			return [ 'button', 'submit', 'reset', 'checkbox', 'radio', 'image' ].indexOf( node.type ) === -1;
		}
		return !! node.closest( KEY_WIDGETS );
	}

	function h( tag, className, attrs ) {
		const node = document.createElement( tag );
		if ( className ) {
			node.className = className;
		}
		Object.keys( attrs || {} ).forEach( ( key ) => {
			const value = attrs[ key ];
			if ( value === null || value === undefined || value === false ) {
				return;
			}
			if ( key === 'text' ) {
				node.textContent = value;
			} else if ( key === 'hidden' ) {
				node.hidden = true;
			} else {
				node.setAttribute( key, value === true ? '' : String( value ) );
			}
		} );
		return node;
	}

	function icon( name, paths ) {
		const ns = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS( ns, 'svg' );
		svg.setAttribute( 'class', 'awb-icon awb-icon--' + name );
		svg.setAttribute( 'viewBox', '0 0 24 24' );
		svg.setAttribute( 'width', '20' );
		svg.setAttribute( 'height', '20' );
		svg.setAttribute( 'aria-hidden', 'true' );
		svg.setAttribute( 'focusable', 'false' );
		svg.setAttribute( 'fill', 'none' );
		svg.setAttribute( 'stroke', 'currentColor' );
		svg.setAttribute( 'stroke-width', '2' );
		svg.setAttribute( 'stroke-linecap', 'round' );
		svg.setAttribute( 'stroke-linejoin', 'round' );

		( ICONS[ name ] || paths || [] ).forEach( ( d ) => {
			const path = document.createElementNS( ns, 'path' );
			path.setAttribute( 'd', d );
			if ( /z$/.test( d ) ) {
				path.setAttribute( 'fill', 'currentColor' );
			}
			svg.appendChild( path );
		} );
		return svg;
	}

	// Show/hide with the hidden attribute, plus an is-open class a frame later so CSS can transition both ways.
	function reveal( node, on ) {
		const open = node.classList.contains( 'is-open' );

		if ( on ) {
			clearTimeout( node.awbTimer );
			if ( open && ! node.hidden ) {
				return;
			}
			if ( node.hidden ) {
				node.hidden = false;
				void node.offsetWidth;
			}
			node.classList.add( 'is-open' );
			return;
		}

		if ( ! open ) {
			return;
		}

		node.classList.remove( 'is-open' );
		clearTimeout( node.awbTimer );
		node.awbTimer = setTimeout(
			() => {
				node.hidden = true;
			},
			reducedMotion() ? 0 : HIDE_MS
		);
	}

	function isOpen( node ) {
		return node.classList.contains( 'is-open' );
	}

	/* ---------- Shared bubble (window.awbUI) ---------- */

	// The learner bubble's DOM. The builder renders the same markup so what it edits is what learners see.
	function createPop( prefix ) {
		const pop = h( 'div', 'awb-pop', {
			role: 'dialog',
			'aria-modal': 'false',
			'aria-labelledby': prefix + '-title',
			'aria-describedby': prefix + '-body',
			'data-placement': 'center',
			hidden: true,
		} );
		const arrow = h( 'span', 'awb-pop__arrow', { 'aria-hidden': 'true' } );
		const eyebrow = h( 'div', 'awb-pop__eyebrow' );
		const title = h( 'h2', 'awb-pop__title', { id: prefix + '-title', tabindex: '-1' } );
		const body = h( 'div', 'awb-pop__body', { id: prefix + '-body' } );
		const notice = h( 'div', 'awb-pop__notice', { hidden: true } );
		const noticeText = h( 'p', 'awb-pop__notice-text' );
		const gotoBtn = h( 'button', 'awb-btn awb-btn--primary', {
			type: 'button',
			'data-awb': 'goto',
			text: t( 'takeMeThere', 'Take me there' ),
			hidden: true,
		} );
		notice.append( noticeText, gotoBtn );
		const hint = h( 'p', 'awb-pop__hint', {
			text: t( 'clickHint', 'Click the highlighted item to continue' ),
			hidden: true,
		} );
		const footer = h( 'div', 'awb-pop__footer' );
		const count = h( 'span', 'awb-pop__count' );
		const buttons = h( 'div', 'awb-pop__buttons' );
		const prevBtn = h( 'button', 'awb-btn awb-btn--ghost', { type: 'button', 'data-awb': 'prev', text: t( 'back', 'Back' ) } );
		const skipBtn = h( 'button', 'awb-btn awb-btn--ghost', {
			type: 'button',
			'data-awb': 'skip',
			text: t( 'skip', 'Skip' ),
			hidden: true,
		} );
		const nextBtn = h( 'button', 'awb-btn awb-btn--primary', { type: 'button', 'data-awb': 'next', text: t( 'next', 'Next' ) } );
		buttons.append( prevBtn, skipBtn, nextBtn );
		footer.append( count, buttons );
		pop.append( arrow, eyebrow, title, body, notice, hint, footer );

		return {
			pop,
			arrow,
			eyebrow,
			title,
			body,
			notice,
			noticeText,
			goto: gotoBtn,
			hint,
			footer,
			count,
			buttons,
			prev: prevBtn,
			skip: skipBtn,
			next: nextBtn,
		};
	}

	// A fixed layer with the spotlight and dim, styled by player.css like the learner's.
	function createLayer( className ) {
		const root = h( 'div', 'awb-root' + ( className ? ' ' + className : '' ), { 'data-position': 'top' } );
		const spotlight = h( 'div', 'awb-spotlight', { 'aria-hidden': 'true', hidden: true } );
		const dim = h( 'div', 'awb-dim', { 'aria-hidden': 'true', hidden: true } );
		root.append( spotlight, dim );
		document.body.appendChild( root );
		return { root, spotlight, dim };
	}

	// The viewport minus the admin bar and, when given, a fixed bar at the top or bottom.
	function safeArea( bar, bottomBar ) {
		const vw = document.documentElement.clientWidth;
		const vh = window.innerHeight;
		const adminBar = document.getElementById( 'wpadminbar' );
		let top = 0;
		let bottom = vh;

		// On small screens the admin bar scrolls away, and its rect says so.
		if ( adminBar ) {
			top = Math.max( top, adminBar.getBoundingClientRect().bottom );
		}

		if ( bar && isOpen( bar ) ) {
			const r = bar.getBoundingClientRect();
			if ( bottomBar ) {
				bottom = Math.min( bottom, r.top );
			} else {
				top = Math.max( top, r.bottom );
			}
		}

		return { top: top + EDGE, bottom: bottom - EDGE, left: EDGE, right: vw - EDGE, vw, vh };
	}

	function placeSpotlight( spotlight, rect ) {
		if ( ! rect ) {
			reveal( spotlight, false );
			return;
		}

		const s = spotlight.style;
		s.left = Math.round( rect.left - PAD ) + 'px';
		s.top = Math.round( rect.top - PAD ) + 'px';
		s.width = Math.round( rect.width + PAD * 2 ) + 'px';
		s.height = Math.round( rect.height + PAD * 2 ) + 'px';
		reveal( spotlight, true );
	}

	/*
	 * Puts a bubble beside rect: the preferred side, flipped when it doesn't fit, else
	 * whichever side comes closest, then clamped to the viewport with the arrow aimed
	 * at the element. No rect = centred. Returns the side used.
	 */
	function placePop( pop, rect, opts ) {
		const options = opts || {};
		const safe = options.safe || safeArea();
		const pw = pop.offsetWidth;
		const ph = pop.offsetHeight;

		pop.classList.toggle( 'is-sheet', !! options.sheet );

		if ( options.sheet ) {
			// CSS docks it to the bottom edge.
			pop.setAttribute( 'data-placement', 'center' );
			pop.style.left = '';
			pop.style.top = '';
			pop.classList.toggle( 'is-detached', ! rect );
			return 'center';
		}

		if ( ! rect ) {
			const cl = clamp( safe.left + ( safe.right - safe.left - pw ) / 2, safe.left, Math.max( safe.left, safe.right - pw ) );
			const ct = clamp( safe.top + ( safe.bottom - safe.top - ph ) / 2, safe.top, Math.max( safe.top, safe.bottom - ph ) );
			pop.setAttribute( 'data-placement', 'center' );
			pop.classList.toggle( 'is-detached', !! options.lost );
			pop.style.left = Math.round( cl ) + 'px';
			pop.style.top = Math.round( ct ) + 'px';
			return 'center';
		}

		const box = {
			top: rect.top - PAD,
			bottom: rect.bottom + PAD,
			left: rect.left - PAD,
			right: rect.right + PAD,
		};
		const room = {
			top: box.top - GAP - safe.top,
			bottom: safe.bottom - box.bottom - GAP,
			left: box.left - GAP - safe.left,
			right: safe.right - box.right - GAP,
		};
		const need = { top: ph, bottom: ph, left: pw, right: pw };
		const pref = options.placement;
		const order =
			SIDES.indexOf( pref ) !== -1
				? [ pref, OPPOSITE[ pref ] ].concat( SIDES.filter( ( s ) => s !== pref && s !== OPPOSITE[ pref ] ) )
				: SIDES;

		let side = order.find( ( s ) => room[ s ] >= need[ s ] );
		if ( ! side ) {
			side = order.reduce( ( best, s ) => ( room[ s ] - need[ s ] > room[ best ] - need[ best ] ? s : best ), order[ 0 ] );
		}

		const vertical = side === 'top' || side === 'bottom';
		const cx = ( box.left + box.right ) / 2;
		const cy = ( box.top + box.bottom ) / 2;
		let left;
		let top;

		if ( vertical ) {
			top = side === 'bottom' ? box.bottom + GAP : box.top - GAP - ph;
			left = cx - pw / 2;
		} else {
			left = side === 'right' ? box.right + GAP : box.left - GAP - pw;
			top = cy - ph / 2;
		}

		const idealTop = top;
		const idealLeft = left;
		left = clamp( left, safe.left, Math.max( safe.left, safe.right - pw ) );
		top = clamp( top, safe.top, Math.max( safe.top, safe.bottom - ph ) );

		const rawArrow = vertical ? cx - left : cy - top;
		const span = vertical ? pw : ph;
		const arrow = clamp( rawArrow, ARROW_INSET, Math.max( ARROW_INSET, span - ARROW_INSET ) );
		const pushed = vertical ? Math.abs( top - idealTop ) > 1 : Math.abs( left - idealLeft ) > 1;
		const offscreen = rect.bottom < safe.top || rect.top > safe.bottom || rect.right < 0 || rect.left > safe.vw;

		pop.setAttribute( 'data-placement', side );
		// Without a true line to the element the arrow would lie, so CSS hides it.
		pop.classList.toggle( 'is-detached', pushed || offscreen || Math.abs( arrow - rawArrow ) > ARROW_INSET );
		pop.style.left = Math.round( left ) + 'px';
		pop.style.top = Math.round( top ) + 'px';
		pop.style.setProperty( '--awb-arrow-offset', Math.round( arrow ) + 'px' );
		return side;
	}

	window.awbUI = {
		version: 1,
		PAD,
		GAP,
		EDGE,
		h,
		icon,
		fmt,
		clamp,
		reveal,
		isOpen,
		reducedMotion,
		createPop,
		createLayer,
		safeArea,
		placeSpotlight,
		placePop,
	};

	/* ---------- Player from here on ---------- */

	if ( ! window.awbPlayer || ! window.fetch ) {
		return;
	}

	const params = new URLSearchParams( window.awbQuery );
	const tours = Array.isArray( cfg.tours ) ? cfg.tours : [];

	let nonce = cfg.nonce;

	/* ---------- REST ---------- */

	function apiUrl( path, query ) {
		// Works for both pretty permalinks and ?rest_route= roots.
		const url = new URL( cfg.root + path, window.location.href );
		Object.keys( query || {} ).forEach( ( key ) => url.searchParams.set( key, query[ key ] ) );
		return url.toString();
	}

	async function api( method, path, body, opts ) {
		const options = opts || {};
		const request = {
			method,
			credentials: 'same-origin',
			keepalive: !! options.keepalive,
			headers: { 'X-WP-Nonce': nonce },
		};

		if ( body ) {
			request.headers[ 'Content-Type' ] = 'application/json';
			request.body = JSON.stringify( body );
		}

		let res;
		try {
			res = await window.fetch( apiUrl( path, options.query ), request );
		} catch ( e ) {
			return { ok: false, network: true, status: 0, data: null };
		}

		let data = null;
		try {
			data = await res.json();
		} catch ( e ) {}

		return { ok: res.ok, network: false, status: res.status, data };
	}

	function sendProgress( tourId, action, extra, keepalive ) {
		const body = Object.assign( { tour: tourId, action }, extra || {} );

		return api( 'POST', 'progress', body, { keepalive } ).then( ( res ) => {
			const tour = findTour( tourId );
			if ( res.ok && res.data && res.data.progress && tour ) {
				tour.progress = res.data.progress;
			}
			return res;
		} );
	}

	// Preview runs never touch anyone's progress.
	function runProgress( action, extra, keepalive ) {
		if ( ! run || run.preview ) {
			return Promise.resolve( null );
		}
		return sendProgress( run.tour, action, extra, keepalive );
	}

	function failMessage( res ) {
		return res && res.network
			? t( 'networkError', 'Couldn’t reach the site. Check your connection and try again.' )
			: t( 'saveError', 'That didn’t save. Please try again.' );
	}

	// Heartbeat hands out a fresh REST nonce, so long sessions keep working.
	if ( window.jQuery ) {
		window.jQuery( document ).on( 'heartbeat-tick', ( e, data ) => {
			if ( data && data.rest_nonce ) {
				nonce = data.rest_nonce;
			}
		} );
	}

	/* ---------- Tours & run state ---------- */

	function findTour( id ) {
		return tours.find( ( tour ) => Number( tour.id ) === Number( id ) ) || null;
	}

	function buildModel( tour ) {
		const steps = ( Array.isArray( tour.steps ) ? tour.steps : [] ).filter( ( s ) => s && s.id );
		const settings = Object.assign(
			{ auto_start: false, allow_skip: true, allow_exit: true, allow_replay: true, bar_position: 'top' },
			tour.settings || {}
		);
		const all = [];
		const byId = new Map();

		( Array.isArray( tour.chapters ) ? tour.chapters : [] ).forEach( ( c ) => {
			const chapter = { id: c.id, title: c.title || '', description: c.description || '', steps: [] };
			byId.set( c.id, chapter );
			all.push( chapter );
		} );

		steps.forEach( ( step, i ) => {
			let chapter = byId.get( step.chapter ) || all[ 0 ];
			if ( ! chapter ) {
				chapter = { id: '', title: '', description: '', steps: [] };
				all.push( chapter );
			}
			chapter.steps.push( i );
		} );

		const chapters = all.filter( ( c ) => c.steps.length );
		const chapterOf = [];
		chapters.forEach( ( c, ci ) => c.steps.forEach( ( i ) => ( chapterOf[ i ] = ci ) ) );

		return {
			id: Number( tour.id ),
			title: tour.title || '',
			steps,
			settings,
			chapters,
			chapterOf,
			bottom: settings.bar_position === 'bottom',
		};
	}

	let model = null;
	let run = null; // { tour, index, preview, nav, navStep, max, min, ended }
	let landedStep = '';
	let offerTour = null;
	let endPreview = false;

	function saveRun() {
		if ( run ) {
			writeStore( RUN_KEY, run );
		}
	}

	function currentStep() {
		return model && run ? model.steps[ run.index ] || null : null;
	}

	function isHere( step ) {
		if ( step.screen && step.screen === cfg.screen ) {
			return true;
		}
		return !! step.url && adminPath( cfg.adminUrl + step.url ) === adminPath( window.location.href );
	}

	function canReach( index ) {
		return !! run && ( index <= run.max || !! model.settings.allow_skip );
	}

	/* ---------- UI ---------- */

	let ui = null;

	function buildUI() {
		if ( ui ) {
			return ui;
		}

		const root = h( 'div', 'awb-root', { 'data-position': 'top' } );
		const spotlight = h( 'div', 'awb-spotlight', { 'aria-hidden': 'true', hidden: true } );
		const dim = h( 'div', 'awb-dim', { 'aria-hidden': 'true', hidden: true } );

		// Bar.
		const bar = h( 'div', 'awb-bar', { role: 'region', hidden: true } );
		const info = h( 'div', 'awb-bar__info' );
		const barTour = h( 'span', 'awb-bar__tour' );
		const barBadge = h( 'span', 'awb-bar__badge', { text: t( 'previewBadge', 'Preview' ), hidden: true } );
		const barChapter = h( 'span', 'awb-bar__chapter' );
		info.append( barTour, barBadge, barChapter );

		const progress = h( 'div', 'awb-bar__progress' );
		// role=group rather than list: the segments are buttons, which can't be list items.
		const track = h( 'div', 'awb-track', { role: 'group', 'aria-label': t( 'chaptersLabel', 'Chapters' ) } );
		const meta = h( 'div', 'awb-bar__meta', { 'aria-live': 'polite' } );
		progress.append( track, meta );

		const actions = h( 'div', 'awb-bar__actions' );
		const barButtons = {};
		[
			[ 'prev', t( 'back', 'Back' ) ],
			[ 'skip', t( 'skipStep', 'Skip step' ) ],
			[ 'skip-chapter', t( 'skipChapter', 'Skip chapter' ) ],
			[ 'list', t( 'allSteps', 'All steps' ) ],
			[ 'minimize', t( 'minimize', 'Minimize' ) ],
			[ 'exit', t( 'exit', 'Close walkthrough' ) ],
		].forEach( ( [ action, label ] ) => {
			const btn = h( 'button', 'awb-btn awb-btn--icon', {
				type: 'button',
				'data-awb': action,
				'aria-label': label,
				title: label,
			} );
			btn.appendChild( icon( action ) );
			barButtons[ action ] = btn;
			actions.appendChild( btn );
		} );
		barButtons.list.setAttribute( 'aria-expanded', 'false' );
		barButtons.list.setAttribute( 'aria-controls', 'awb-steps-panel' );
		bar.append( info, progress, actions );

		// Chapter hover card.
		const card = h( 'div', 'awb-chapter-card', { id: 'awb-chapter-card', hidden: true } );
		const cardEyebrow = h( 'div', 'awb-chapter-card__eyebrow' );
		const cardTitle = h( 'div', 'awb-chapter-card__title' );
		const cardDesc = h( 'p', 'awb-chapter-card__desc' );
		const cardSteps = h( 'ol', 'awb-chapter-card__steps' );
		card.append( cardEyebrow, cardTitle, cardDesc, cardSteps );

		// Full steps list.
		const panel = h( 'div', 'awb-steps-panel', {
			id: 'awb-steps-panel',
			role: 'region',
			'aria-label': t( 'allSteps', 'All steps' ),
			hidden: true,
		} );

		const {
			pop,
			eyebrow: popEyebrow,
			title: popTitle,
			body: popBody,
			notice: popNotice,
			noticeText: popNoticeText,
			goto: popGoto,
			hint: popHint,
			count: popCount,
			prev: popPrev,
			skip: popSkip,
			next: popNext,
		} = createPop( 'awb-pop' );

		// Minimized pill.
		const pill = h( 'div', 'awb-pill', { hidden: true } );
		const pillButton = h( 'button', 'awb-pill__button', { type: 'button', 'data-awb': 'restore' } );
		const pillText = h( 'span', 'awb-pill__text' );
		const pillProgress = h( 'span', 'awb-pill__progress', { 'aria-hidden': 'true' } );
		const pillFill = h( 'span', 'awb-pill__progress-fill' );
		pillProgress.appendChild( pillFill );
		pillButton.append( icon( 'restore' ), pillText, pillProgress );
		pill.appendChild( pillButton );

		// End card.
		const end = h( 'div', 'awb-end', {
			role: 'dialog',
			'aria-modal': 'true',
			'aria-labelledby': 'awb-end-title',
			hidden: true,
		} );
		const endBadge = h( 'div', 'awb-end__badge', { 'aria-hidden': 'true' } );
		endBadge.appendChild( icon( 'check' ) );
		const endTitle = h( 'h2', 'awb-end__title', { id: 'awb-end-title', tabindex: '-1' } );
		const endText = h( 'p', 'awb-end__text' );
		const endChapters = h( 'ul', 'awb-end__chapters' );
		const endRemind = h( 'div', 'awb-end__remind', { hidden: true } );
		const remindLabel = h( 'label', 'awb-end__remind-label', {
			for: 'awb-end-remind-days',
			text: t( 'remindLabel', 'Remind me to go over this again in' ),
		} );
		const remindSelect = h( 'select', 'awb-end__remind-select', { id: 'awb-end-remind-days' } );
		REMIND_DAYS.forEach( ( days ) => {
			remindSelect.appendChild( h( 'option', '', { value: days, text: fmt( t( 'nDays', '%d days' ), days ) } ) );
		} );
		remindSelect.value = '7';
		const remindButton = h( 'button', 'awb-btn awb-btn--ghost', {
			type: 'button',
			'data-awb': 'remind',
			text: t( 'remindButton', 'Remind me' ),
		} );
		endRemind.append( remindLabel, remindSelect, remindButton );
		const endActions = h( 'div', 'awb-end__actions' );
		const endReplay = h( 'button', 'awb-btn awb-btn--ghost', {
			type: 'button',
			'data-awb': 'replay',
			text: t( 'replay', 'Start again' ),
		} );
		const endClose = h( 'button', 'awb-btn awb-btn--primary', {
			type: 'button',
			'data-awb': 'close',
			text: t( 'close', 'Close' ),
		} );
		endActions.append( endReplay, endClose );
		end.append( endBadge, endTitle, endText, endChapters, endRemind, endActions );

		// Refresher offer.
		const offer = h( 'div', 'awb-offer', {
			role: 'dialog',
			'aria-modal': 'false',
			'aria-labelledby': 'awb-offer-title',
			hidden: true,
		} );
		const offerTitle = h( 'div', 'awb-offer__title', {
			id: 'awb-offer-title',
			text: t( 'offerTitle', 'Time for a quick refresher?' ),
		} );
		const offerText = h( 'p', 'awb-offer__text' );
		const offerActions = h( 'div', 'awb-offer__actions' );
		offerActions.append(
			h( 'button', 'awb-btn awb-btn--primary', {
				type: 'button',
				'data-awb': 'offer-replay',
				text: t( 'offerReplay', 'Replay it' ),
			} ),
			h( 'button', 'awb-btn awb-btn--ghost', {
				type: 'button',
				'data-awb': 'offer-later',
				text: t( 'offerLater', 'Later' ),
			} ),
			h( 'button', 'awb-btn awb-btn--ghost', {
				type: 'button',
				'data-awb': 'offer-never',
				text: t( 'offerNever', 'Don’t ask again' ),
			} )
		);
		offer.append( offerTitle, offerText, offerActions );

		const toastEl = h( 'div', 'awb-toast', { role: 'status', 'aria-live': 'polite', hidden: true } );

		root.append( spotlight, dim, bar, card, panel, pop, pill, end, offer, toastEl );
		document.body.appendChild( root );

		ui = {
			root,
			spotlight,
			dim,
			bar,
			barTour,
			barBadge,
			barChapter,
			track,
			meta,
			barButtons,
			card,
			cardEyebrow,
			cardTitle,
			cardDesc,
			cardSteps,
			panel,
			pop,
			popEyebrow,
			popTitle,
			popBody,
			popNotice,
			popNoticeText,
			popGoto,
			popHint,
			popCount,
			popPrev,
			popSkip,
			popNext,
			pill,
			pillButton,
			pillText,
			pillFill,
			end,
			endTitle,
			endText,
			endChapters,
			endRemind,
			remindSelect,
			remindButton,
			endReplay,
			offer,
			offerText,
			toast: toastEl,
		};

		root.addEventListener( 'click', onRootClick );
		root.addEventListener( 'focusout', onRootFocusOut );
		card.addEventListener( 'pointerenter', () => clearTimeout( cardHideTimer ) );
		card.addEventListener( 'pointerleave', ( e ) => {
			if ( e.pointerType !== 'touch' ) {
				scheduleCardHide();
			}
		} );
		document.addEventListener( 'pointerdown', onOutsidePointer, true );
		document.addEventListener( 'keydown', onKey );

		if ( window.ResizeObserver ) {
			new window.ResizeObserver( measureBar ).observe( bar );
		} else {
			window.addEventListener( 'resize', measureBar );
		}

		return ui;
	}

	/* ---------- Bar ---------- */

	let trackModel = null;

	function setBar( on ) {
		const cl = document.documentElement.classList;
		const bottom = !! ( model && model.bottom );

		reveal( ui.bar, on );
		cl.toggle( 'awb-has-bar', on );
		cl.toggle( 'awb-has-bar--top', on && ! bottom );
		cl.toggle( 'awb-has-bar--bottom', on && bottom );

		if ( on ) {
			measureBar();
		} else {
			document.documentElement.style.removeProperty( '--awb-bar-h' );
			closeCard();
			togglePanel( false );
		}
	}

	function measureBar() {
		if ( ! ui || ui.bar.hidden || ! isOpen( ui.bar ) ) {
			return;
		}
		const height = Math.ceil( ui.bar.getBoundingClientRect().height );
		document.documentElement.style.setProperty( '--awb-bar-h', height + 'px' );
		nudge();
	}

	function applyTour() {
		buildUI();
		ui.root.setAttribute( 'data-position', model.bottom ? 'bottom' : 'top' );
		ui.root.classList.toggle( 'is-preview', !! ( run && run.preview ) );
		ui.bar.setAttribute( 'aria-label', fmt( t( 'barLabel', 'Walkthrough: %s' ), model.title ) );
		ui.barTour.textContent = model.title;
		ui.barBadge.hidden = ! ( run && run.preview );

		if ( trackModel !== model ) {
			trackModel = model;
			buildTrack();
		}
	}

	function buildTrack() {
		ui.track.replaceChildren();

		model.chapters.forEach( ( chapter, ci ) => {
			const btn = h( 'button', 'awb-track__chapter', {
				type: 'button',
				'data-awb': 'chapter',
				'data-chapter': ci,
				'aria-label': fmt( t( 'chapterLabel', 'Chapter %1$d: %2$s' ), ci + 1, chapter.title ),
				'aria-controls': 'awb-chapter-card',
			} );
			btn.style.flexGrow = String( chapter.steps.length );

			const ticks = h( 'span', 'awb-track__ticks', { 'aria-hidden': 'true' } );
			chapter.steps.forEach( () => ticks.appendChild( h( 'span', 'awb-track__tick' ) ) );
			btn.append( h( 'span', 'awb-track__fill', { 'aria-hidden': 'true' } ), ticks );

			btn.addEventListener( 'pointerenter', ( e ) => {
				if ( e.pointerType !== 'touch' ) {
					openCard( ci, btn );
				}
			} );
			btn.addEventListener( 'pointerleave', ( e ) => {
				if ( e.pointerType !== 'touch' ) {
					scheduleCardHide();
				}
			} );
			btn.addEventListener( 'pointerdown', ( e ) => {
				// On touch the first tap only previews the chapter; a second tap jumps.
				touchTap = e.pointerType === 'touch' && ! ( isOpen( ui.card ) && cardChapter === ci ) ? ci : -1;
			} );
			btn.addEventListener( 'focus', () => openCard( ci, btn ) );

			ui.track.appendChild( btn );
		} );
	}

	function updateBar() {
		const index = run.index;
		const step = model.steps[ index ];
		const ci = model.chapterOf[ index ];
		const chapter = model.chapters[ ci ];
		const total = model.steps.length;

		ui.barChapter.textContent = chapter ? chapter.title : '';
		ui.meta.textContent = fmt( t( 'barMeta', 'Step %1$d of %2$d · %3$s' ), index + 1, total, step.title || '' );

		const canSkip = !! model.settings.allow_skip;
		ui.barButtons.prev.disabled = index === 0;
		ui.barButtons.skip.hidden = ! canSkip;
		ui.barButtons[ 'skip-chapter' ].hidden = ! canSkip;
		ui.barButtons[ 'skip-chapter' ].disabled = ci >= model.chapters.length - 1;
		ui.barButtons.exit.hidden = ! model.settings.allow_exit && ! run.preview;

		ui.track.querySelectorAll( '.awb-track__chapter' ).forEach( ( btn, i ) => {
			const steps = model.chapters[ i ].steps;
			const done = steps.filter( ( s ) => s < index ).length;
			const current = i === ci;

			btn.classList.toggle( 'is-done', steps[ steps.length - 1 ] < index );
			btn.classList.toggle( 'is-current', current );
			btn.classList.toggle( 'is-locked', ! canReach( steps[ 0 ] ) );
			if ( current ) {
				btn.setAttribute( 'aria-current', 'step' );
			} else {
				btn.removeAttribute( 'aria-current' );
			}

			btn.querySelector( '.awb-track__fill' ).style.width = ( ( done / steps.length ) * 100 ).toFixed( 2 ) + '%';
			btn.querySelectorAll( '.awb-track__tick' ).forEach( ( tick, k ) => {
				tick.classList.toggle( 'is-done', steps[ k ] < index );
				tick.classList.toggle( 'is-current', steps[ k ] === index );
			} );
		} );

		closeCard();
		if ( isOpen( ui.panel ) ) {
			fillPanel();
		}
	}

	/* ---------- Chapter card ---------- */

	let cardChapter = -1;
	let cardHideTimer = 0;
	let touchTap = -1;

	function stepButton( i, className ) {
		const step = model.steps[ i ];
		const li = h( 'li', className || '' );
		const btn = h( 'button', '', {
			type: 'button',
			'data-awb': 'jump',
			'data-index': i,
			text: step.title || fmt( t( 'stepN', 'Step %d' ), i + 1 ),
		} );

		li.classList.toggle( 'is-done', i < run.index );
		li.classList.toggle( 'is-current', i === run.index );
		if ( i === run.index ) {
			btn.setAttribute( 'aria-current', 'step' );
		}
		if ( ! canReach( i ) ) {
			btn.disabled = true;
		}

		li.appendChild( btn );
		return li;
	}

	function openCard( ci, anchor ) {
		clearTimeout( cardHideTimer );
		if ( ! run || ! model.chapters[ ci ] ) {
			return;
		}

		if ( cardChapter !== ci || ! isOpen( ui.card ) ) {
			const chapter = model.chapters[ ci ];
			cardChapter = ci;
			ui.cardEyebrow.textContent =
				fmt( t( 'chapterOf', 'Chapter %1$d of %2$d' ), ci + 1, model.chapters.length ) +
				' · ' +
				stepsLabel( chapter.steps.length );
			ui.cardTitle.textContent = chapter.title;
			ui.cardDesc.textContent = chapter.description;
			ui.cardDesc.hidden = ! chapter.description;
			ui.cardSteps.replaceChildren( ...chapter.steps.map( ( i ) => stepButton( i ) ) );
		}

		reveal( ui.card, true );
		positionCard( anchor );
	}

	// Under the hovered segment for a top bar, above it for a bottom bar, nudged inside the viewport.
	function positionCard( anchor ) {
		const a = anchor.getBoundingClientRect();
		const vw = document.documentElement.clientWidth;
		const width = ui.card.offsetWidth;
		const height = ui.card.offsetHeight;
		const center = a.left + a.width / 2;
		const left = clamp( center - width / 2, EDGE, Math.max( EDGE, vw - EDGE - width ) );
		const top = model.bottom ? a.top - CARD_GAP - height : a.bottom + CARD_GAP;

		ui.card.setAttribute( 'data-side', model.bottom ? 'top' : 'bottom' );
		ui.card.style.left = Math.round( left ) + 'px';
		ui.card.style.top = Math.round( top ) + 'px';
		ui.card.style.setProperty( '--awb-arrow-offset', Math.round( clamp( center - left, 16, width - 16 ) ) + 'px' );
	}

	function scheduleCardHide() {
		clearTimeout( cardHideTimer );
		cardHideTimer = setTimeout( closeCard, CARD_HIDE_MS );
	}

	function closeCard() {
		clearTimeout( cardHideTimer );
		if ( ui && isOpen( ui.card ) ) {
			reveal( ui.card, false );
		}
		cardChapter = -1;
	}

	function onChapterClick( e, btn ) {
		const ci = toInt( btn.getAttribute( 'data-chapter' ) );

		if ( touchTap === ci ) {
			touchTap = -1;
			e.preventDefault();
			openCard( ci, btn );
			return;
		}

		const chapter = model.chapters[ ci ];
		if ( chapter ) {
			goTo( chapter.steps[ 0 ] );
		}
	}

	function onRootFocusOut( e ) {
		const to = e.relatedTarget;
		if ( isOpen( ui.card ) && ! ( to && ( ui.card.contains( to ) || ui.track.contains( to ) ) ) ) {
			scheduleCardHide();
		}
	}

	function onOutsidePointer( e ) {
		const node = e.target;
		if ( isOpen( ui.panel ) && ! ui.panel.contains( node ) && ! ui.barButtons.list.contains( node ) ) {
			togglePanel( false );
		}
		if ( isOpen( ui.card ) && ! ui.card.contains( node ) && ! ui.track.contains( node ) ) {
			closeCard();
		}
	}

	/* ---------- Steps panel ---------- */

	function fillPanel() {
		ui.panel.replaceChildren(
			...model.chapters.map( ( chapter ) => {
				const section = h( 'div', 'awb-steps-panel__chapter' );
				section.appendChild( h( 'h3', '', { text: chapter.title } ) );
				if ( chapter.description ) {
					section.appendChild( h( 'p', '', { text: chapter.description } ) );
				}
				const list = h( 'ol' );
				chapter.steps.forEach( ( i ) => list.appendChild( stepButton( i ) ) );
				section.appendChild( list );
				return section;
			} )
		);
	}

	function togglePanel( force ) {
		if ( ! ui ) {
			return;
		}

		const open = typeof force === 'boolean' ? force : ! isOpen( ui.panel );
		if ( open === isOpen( ui.panel ) ) {
			return;
		}

		if ( open ) {
			closeCard();
			fillPanel();
		}

		reveal( ui.panel, open );
		ui.barButtons.list.setAttribute( 'aria-expanded', open ? 'true' : 'false' );

		if ( open ) {
			const current = ui.panel.querySelector( 'button[aria-current]' ) || ui.panel.querySelector( 'button:not([disabled])' );
			if ( current ) {
				current.focus( { preventScroll: true } );
				current.scrollIntoView( { block: 'nearest' } );
			}
		}
	}

	/* ---------- Toast ---------- */

	let toastTimer = 0;

	function toast( text ) {
		buildUI();
		ui.toast.textContent = text;
		reveal( ui.toast, true );
		clearTimeout( toastTimer );
		toastTimer = setTimeout( () => reveal( ui.toast, false ), TOAST_MS );
	}

	/* ---------- Finding the element ---------- */

	function isVisible( node ) {
		const r = node.getBoundingClientRect();
		if ( r.width < 1 && r.height < 1 ) {
			return false;
		}
		return window.getComputedStyle( node ).visibility !== 'hidden';
	}

	// The first visible match, null while there's none yet, or false when the selector itself is broken.
	function findTarget( selector ) {
		let list;
		try {
			list = document.querySelectorAll( selector );
		} catch ( e ) {
			return false;
		}

		for ( const node of list ) {
			if ( ! ( ui && ui.root.contains( node ) ) && isVisible( node ) ) {
				return node;
			}
		}
		return null;
	}

	function waitFor( selector, ms, done ) {
		let finished = false;
		let observer = null;
		let timer = 0;
		let poll = 0;
		let raf = 0;

		const cleanup = () => {
			if ( observer ) {
				observer.disconnect();
			}
			clearTimeout( timer );
			clearInterval( poll );
			if ( raf ) {
				window.cancelAnimationFrame( raf );
			}
		};

		const settle = ( found ) => {
			if ( ! finished ) {
				finished = true;
				cleanup();
				done( found || null );
			}
		};

		const check = () => {
			raf = 0;
			const found = findTarget( selector );
			if ( found !== null ) {
				settle( found );
			}
		};

		check();
		if ( finished ) {
			return () => {};
		}

		observer = new window.MutationObserver( () => {
			if ( ! raf ) {
				raf = window.requestAnimationFrame( check );
			}
		} );
		observer.observe( document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: [ 'class', 'style', 'hidden', 'open', 'aria-hidden', 'aria-expanded' ],
		} );
		// CSS-only changes (like :hover menus) never touch the DOM, so I also poll.
		poll = setInterval( check, 250 );
		timer = setTimeout( () => settle( null ), ms );

		return () => {
			finished = true;
			cleanup();
		};
	}

	/* ---------- Step rendering ---------- */

	let mode = ''; // wait, target, float, away, lost
	let target = null;
	let stepToken = 0;
	let cancelWait = null;

	function resetStep() {
		stepToken++;
		if ( cancelWait ) {
			cancelWait();
			cancelWait = null;
		}
		stopTracking();
		disarmClick();
		clearTimeout( clickTimer );
		stopLeaving();
		target = null;
		mode = '';
		if ( ui ) {
			ui.root.classList.remove( 'is-waiting', 'is-leaving' );
		}
	}

	function render( allowNav ) {
		resetStep();
		applyTour();
		reveal( ui.end, false );

		if ( run.index >= model.steps.length ) {
			showEnd();
			return;
		}

		if ( run.min ) {
			showMinimized();
			return;
		}

		reveal( ui.pill, false );

		const step = model.steps[ run.index ];
		const landed = landedStep === step.id;
		landedStep = '';

		// A step whose URL I just navigated to counts as here, even if its screen id changed, so I never loop.
		if ( ! landed && ! isHere( step ) ) {
			if ( allowNav && run.nav ) {
				navigate( step );
				return;
			}
			setBar( true );
			updateBar();
			fillPop( step, { away: true } );
			showPop( 'away', null );
			return;
		}

		if ( run.nav || run.navStep ) {
			run.nav = false;
			run.navStep = '';
			saveRun();
		}

		setBar( true );
		updateBar();

		if ( ! step.selector ) {
			fillPop( step, {} );
			showPop( 'float', null );
			return;
		}

		const token = stepToken;
		mode = 'wait';
		ui.root.classList.add( 'is-waiting' );
		reveal( ui.pop, false );
		reveal( ui.dim, false );
		reveal( ui.spotlight, false );

		cancelWait = waitFor( step.selector, WAIT_MS, ( found ) => {
			cancelWait = null;
			if ( token !== stepToken ) {
				return;
			}
			ui.root.classList.remove( 'is-waiting' );
			fillPop( step, { missing: ! found, click: !! found && step.advance === 'click' } );
			showPop( found ? 'target' : 'float', found );
		} );
	}

	function fillPop( step, state ) {
		const index = run.index;
		const total = model.steps.length;
		const chapter = model.chapters[ model.chapterOf[ index ] ];
		const last = index === total - 1;
		const canSkip = !! model.settings.allow_skip;

		ui.popEyebrow.textContent = chapter ? chapter.title : '';
		ui.popEyebrow.hidden = ! ui.popEyebrow.textContent;
		ui.popTitle.textContent = step.title || '';
		// Already through wp_kses on the server.
		ui.popBody.innerHTML = step.html || '';
		ui.popCount.textContent = fmt( t( 'popCount', '%1$d / %2$d' ), index + 1, total );

		ui.popNotice.hidden = ! state.away && ! state.missing;
		ui.popNoticeText.textContent = state.away
			? t( 'awayNotice', 'This step is on another screen.' )
			: t( 'missingNotice', 'We couldn’t find the item this step points to. It may be hidden or the screen may have changed.' );
		ui.popGoto.hidden = ! state.away;

		ui.popHint.hidden = ! state.click;
		ui.popPrev.hidden = index === 0;
		ui.popSkip.hidden = ! ( state.click && canSkip );
		ui.popNext.hidden = !! state.click || ( !! state.away && ! canSkip );
		ui.popNext.textContent = last ? t( 'finish', 'Finish' ) : t( 'next', 'Next' );

		ui.pop.classList.toggle( 'is-away', !! state.away );
		ui.pop.classList.toggle( 'is-missing', !! state.missing );
		ui.pop.classList.toggle( 'is-click', !! state.click );
		ui.pop.classList.toggle( 'is-last', last );
	}

	function showPop( nextMode, node ) {
		const step = currentStep();

		mode = nextMode;
		target = node;
		ui.pop.classList.remove( 'is-detached' );
		reveal( ui.dim, nextMode === 'float' );
		reveal( ui.pop, true );

		startTracking();
		place();

		if ( node ) {
			scrollToTarget( node );
			if ( step.advance === 'click' ) {
				armClick();
			}
		}

		ui.popTitle.focus( { preventScroll: true } );
	}

	function navigate( step ) {
		if ( ! step ) {
			return;
		}
		run.nav = true;
		run.navStep = step.id;
		saveRun();
		buildUI().root.classList.add( 'is-leaving' );
		window.location.href = stepHref( step );
	}

	/* ---------- Positioning ---------- */

	let tracking = false;
	let rafId = 0;
	let settleUntil = 0;
	let safetyTimer = 0;
	let mutations = null;
	let resizes = null;
	let lastKey = '';

	function place() {
		if ( ! tracking || ! ui || mode === 'lost' ) {
			return;
		}

		if ( target && ! target.isConnected ) {
			relocate();
			return;
		}

		const safe = safeArea( ui.bar, model.bottom );
		const sheet = safe.vw < MOBILE;
		let rect = null;

		if ( target ) {
			const r = target.getBoundingClientRect();
			if ( r.width >= 1 || r.height >= 1 ) {
				rect = r;
			}
		}

		const pw = ui.pop.offsetWidth;
		const ph = ui.pop.offsetHeight;
		const key = [
			rect ? [ rect.top, rect.left, rect.width, rect.height ].map( Math.round ).join( ':' ) : '-',
			safe.vw,
			safe.vh,
			Math.round( safe.top ),
			Math.round( safe.bottom ),
			pw,
			ph,
		].join( ',' );

		if ( key === lastKey ) {
			return;
		}
		lastKey = key;

		const step = currentStep();
		placeSpotlight( ui.spotlight, rect );
		placePop( ui.pop, rect, {
			placement: step ? step.placement : 'auto',
			safe,
			sheet,
			lost: mode === 'target',
		} );
	}

	function scrollToTarget( node ) {
		const safe = safeArea( ui.bar, model.bottom );
		const vh = safe.vh;
		const r = node.getBoundingClientRect();
		const sheetH = ui.pop.classList.contains( 'is-sheet' ) ? ui.pop.offsetHeight : 0;
		const bottom = safe.bottom - sheetH;

		if ( r.top >= safe.top && r.bottom <= bottom ) {
			return;
		}

		// Scroll margins make "center" mean the middle of what's left between my bars and the sheet.
		const style = node.style;
		const before = [ style.scrollMarginTop, style.scrollMarginBottom ];
		style.scrollMarginTop = Math.round( safe.top + PAD ) + 'px';
		style.scrollMarginBottom = Math.round( vh - bottom + PAD ) + 'px';

		try {
			node.scrollIntoView( {
				behavior: reducedMotion() ? 'auto' : 'smooth',
				block: r.height > bottom - safe.top ? 'start' : 'center',
				inline: 'nearest',
			} );
		} catch ( e ) {}

		style.scrollMarginTop = before[ 0 ];
		style.scrollMarginBottom = before[ 1 ];
		nudge( 900 );
	}

	// Events schedule a few frames of re-measuring; a slow safety poll covers what fires no event.
	function nudge( ms ) {
		if ( ! tracking ) {
			return;
		}
		settleUntil = Math.max( settleUntil, performance.now() + ( typeof ms === 'number' ? ms : SETTLE_MS ) );
		if ( ! rafId ) {
			rafId = window.requestAnimationFrame( frame );
		}
	}

	function frame() {
		rafId = 0;
		if ( ! tracking ) {
			return;
		}
		place();
		if ( performance.now() < settleUntil ) {
			rafId = window.requestAnimationFrame( frame );
		}
	}

	function onTransition( e ) {
		if ( ! ( ui && e.target instanceof window.Node && ui.root.contains( e.target ) ) ) {
			nudge( e.type === 'transitionrun' ? 700 : SETTLE_MS );
		}
	}

	function startTracking() {
		if ( tracking ) {
			observeTarget();
			lastKey = '';
			nudge();
			return;
		}

		tracking = true;
		lastKey = '';
		window.addEventListener( 'scroll', nudge, { capture: true, passive: true } );
		window.addEventListener( 'resize', nudge, { passive: true } );
		document.addEventListener( 'transitionrun', onTransition, true );
		document.addEventListener( 'transitionend', onTransition, true );
		document.addEventListener( 'animationend', onTransition, true );

		mutations = new window.MutationObserver( ( records ) => {
			if ( records.some( ( r ) => ! ui.root.contains( r.target ) ) ) {
				nudge();
			}
		} );
		mutations.observe( document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: [ 'class', 'style', 'hidden', 'open' ],
		} );

		if ( window.ResizeObserver ) {
			resizes = new window.ResizeObserver( () => nudge() );
			resizes.observe( ui.pop );
		}
		observeTarget();
		safetyTimer = setInterval( place, SAFETY_MS );
	}

	function observeTarget() {
		if ( resizes && target ) {
			resizes.observe( target );
		}
	}

	function stopTracking() {
		if ( ! tracking ) {
			return;
		}
		tracking = false;
		window.removeEventListener( 'scroll', nudge, { capture: true } );
		window.removeEventListener( 'resize', nudge );
		document.removeEventListener( 'transitionrun', onTransition, true );
		document.removeEventListener( 'transitionend', onTransition, true );
		document.removeEventListener( 'animationend', onTransition, true );
		if ( mutations ) {
			mutations.disconnect();
			mutations = null;
		}
		if ( resizes ) {
			resizes.disconnect();
			resizes = null;
		}
		clearInterval( safetyTimer );
		if ( rafId ) {
			window.cancelAnimationFrame( rafId );
			rafId = 0;
		}
		lastKey = '';
	}

	// The screen re-rendered my element (React, AJAX tables); I look for its replacement before giving up.
	function relocate() {
		const step = currentStep();
		const token = stepToken;
		const clickMode = mode === 'target' && step.advance === 'click';

		disarmClick();
		if ( resizes && target ) {
			resizes.unobserve( target );
		}
		target = null;
		mode = 'lost';
		reveal( ui.spotlight, false );

		cancelWait = waitFor( step.selector, WAIT_MS, ( found ) => {
			cancelWait = null;
			if ( token !== stepToken ) {
				return;
			}
			mode = found ? 'target' : 'float';
			target = found;
			if ( ! found ) {
				fillPop( step, { missing: true } );
				reveal( ui.dim, true );
			} else if ( clickMode ) {
				armClick();
			}
			observeTarget();
			lastKey = '';
			place();
		} );
	}

	/* ---------- Click to continue ---------- */

	let clickArmed = false;
	let clickTimer = 0;
	let leaving = false;

	function armClick() {
		if ( ! clickArmed ) {
			clickArmed = true;
			document.addEventListener( 'click', onTargetClick, true );
		}
	}

	function disarmClick() {
		if ( clickArmed ) {
			clickArmed = false;
			document.removeEventListener( 'click', onTargetClick, true );
		}
	}

	function onLeaving() {
		leaving = true;
	}

	function stopLeaving() {
		leaving = false;
		window.removeEventListener( 'beforeunload', onLeaving );
	}

	// Capture phase on document, so I see the click before the page's own handlers act on it.
	function onTargetClick( e ) {
		if ( ! target || ! ( e.target instanceof window.Node ) || ! target.contains( e.target ) ) {
			return;
		}

		disarmClick();

		const nextIndex = run.index + 1;
		const nextStep = model.steps[ nextIndex ];

		// Saved before the default action runs, so if the click navigates the next page carries on.
		run.index = nextIndex;
		run.max = Math.max( run.max, nextIndex );
		run.nav = true;
		run.navStep = '';
		if ( ! nextStep ) {
			run.ended = true;
		}
		saveRun();

		if ( nextStep ) {
			runProgress( 'step', { step: nextStep.id }, true );
		} else {
			runProgress( 'complete', {}, true );
		}

		// beforeunload fires as soon as a navigation starts, long before the next page arrives.
		leaving = false;
		window.addEventListener( 'beforeunload', onLeaving );
		clearTimeout( clickTimer );
		clickTimer = setTimeout( afterTargetClick, CLICK_NAV_MS );
	}

	function afterTargetClick() {
		if ( ! leaving ) {
			stopLeaving();
			render( true );
			return;
		}

		// Still here long after leaving started: a download or a cancelled "leave site?" prompt.
		clickTimer = setTimeout( () => {
			stopLeaving();
			render( false );
		}, STUCK_MS );
	}

	/* ---------- Moving around ---------- */

	function startRun( m, index, opts ) {
		const options = opts || {};

		model = m;
		run = {
			tour: m.id,
			index: clamp( index, 0, m.steps.length - 1 ),
			preview: !! options.preview,
			nav: true,
			navStep: '',
			max: 0,
			min: false,
			ended: false,
		};
		run.max = run.index;
		saveRun();

		if ( ui ) {
			reveal( ui.offer, false );
		}

		if ( options.action ) {
			runProgress( options.action, { step: m.steps[ run.index ].id }, true );
		}

		render( true );
	}

	function goTo( index, force ) {
		if ( ! run || index < 0 ) {
			return;
		}
		if ( index >= model.steps.length ) {
			finish();
			return;
		}
		if ( ! force && ! canReach( index ) ) {
			return;
		}

		run.index = index;
		run.max = Math.max( run.max, index );
		run.nav = true;
		run.navStep = '';
		saveRun();

		runProgress( 'step', { step: model.steps[ index ].id }, true );
		closeCard();
		togglePanel( false );
		render( true );
	}

	function next() {
		goTo( run.index + 1, true );
	}

	function prev() {
		if ( run.index > 0 ) {
			goTo( run.index - 1, true );
		}
	}

	function skip() {
		if ( model.settings.allow_skip ) {
			goTo( run.index + 1, true );
		}
	}

	function skipChapter() {
		const following = model.chapters[ model.chapterOf[ run.index ] + 1 ];
		if ( model.settings.allow_skip && following ) {
			goTo( following.steps[ 0 ], true );
		}
	}

	function finish() {
		run.index = model.steps.length;
		saveRun();
		render( false );
	}

	function showMinimized() {
		const total = model.steps.length;

		setBar( false );
		reveal( ui.pop, false );
		reveal( ui.dim, false );
		reveal( ui.spotlight, false );

		ui.pillText.textContent = fmt(
			t( 'resumePill', 'Resume ‘%1$s’ · %2$d/%3$d' ),
			model.title,
			Math.min( run.index + 1, total ),
			total
		);
		ui.pill.style.setProperty( '--awb-progress', ( run.index / total ).toFixed( 3 ) );
		ui.pillFill.style.width = ( ( run.index / total ) * 100 ).toFixed( 2 ) + '%';
		reveal( ui.pill, true );
	}

	function minimize() {
		if ( ! run || run.min ) {
			return;
		}
		run.min = true;
		saveRun();
		render( false );
		ui.pillButton.focus( { preventScroll: true } );
	}

	function restore() {
		if ( ! run ) {
			return;
		}
		run.min = false;
		saveRun();
		render( false );
	}

	function teardown() {
		resetStep();
		removeStore( RUN_KEY );
		run = null;
		if ( ui ) {
			setBar( false );
			[ ui.pop, ui.dim, ui.spotlight, ui.pill ].forEach( ( node ) => reveal( node, false ) );
		}
	}

	function exitRun() {
		if ( ! run || ( ! model.settings.allow_exit && ! run.preview ) ) {
			return;
		}

		const preview = run.preview;
		runProgress( 'dismiss' );
		teardown();
		toast(
			preview
				? t( 'previewClosed', 'Preview closed.' )
				: t( 'exitToast', 'You can pick it up again from Guides in the toolbar.' )
		);
	}

	/* ---------- End card ---------- */

	function showEnd() {
		if ( ! run.ended ) {
			run.ended = true;
			runProgress( 'complete', {}, true );
		}

		const preview = run.preview;
		const replayable = !! model.settings.allow_replay;

		// The card lives on this page only; the run itself is over.
		teardown();
		endPreview = preview;

		ui.endTitle.textContent = t( 'endTitle', 'You’re all set!' );
		ui.endText.textContent = fmt( t( 'endText', 'You finished ‘%s’.' ), model.title );
		ui.endChapters.replaceChildren( ...model.chapters.map( ( c ) => h( 'li', 'is-done', { text: c.title } ) ) );
		ui.endChapters.hidden = model.chapters.length < 2;
		ui.endRemind.hidden = ! replayable || preview;
		ui.remindButton.disabled = false;
		ui.remindSelect.disabled = false;
		ui.endReplay.hidden = ! replayable && ! preview;

		reveal( ui.dim, true );
		reveal( ui.end, true );
		ui.endTitle.focus( { preventScroll: true } );
	}

	function closeEnd() {
		reveal( ui.end, false );
		reveal( ui.dim, false );
	}

	async function remind() {
		const days = toInt( ui.remindSelect.value ) || 7;

		ui.remindButton.disabled = true;
		ui.remindSelect.disabled = true;

		const res = await sendProgress( model.id, 'remind', { days } );

		if ( res.ok ) {
			toast( fmt( t( 'remindSaved', 'Got it. We’ll remind you in %d days.' ), days ) );
			closeEnd();
			return;
		}

		ui.remindButton.disabled = false;
		ui.remindSelect.disabled = false;
		toast( failMessage( res ) );
	}

	function replay() {
		closeEnd();
		startRun( model, 0, { preview: endPreview, action: endPreview ? '' : 'start' } );
	}

	/* ---------- Refresher offer ---------- */

	function showOffer() {
		const offer = cfg.offer;
		const tour = offer ? findTour( offer.tour ) : null;

		if ( ! tour || ! Array.isArray( tour.steps ) || ! tour.steps.length ) {
			return false;
		}

		const days = toInt( offer.days );
		let text;
		if ( days < 1 ) {
			text = t( 'offerTextRecent', 'Ready to go over ‘%2$s’ again?' );
		} else if ( days === 1 ) {
			text = t( 'offerTextOne', 'It’s been a day since you went through ‘%2$s’.' );
		} else {
			text = t( 'offerText', 'It’s been %1$d days since you went through ‘%2$s’.' );
		}

		buildUI();
		offerTour = tour;
		ui.offerText.textContent = fmt( text, days, tour.title || '' );
		reveal( ui.offer, true );
		return true;
	}

	async function answerOffer( action ) {
		const tour = offerTour;
		if ( ! tour ) {
			return;
		}

		reveal( ui.offer, false );

		if ( action === 'replay' ) {
			const m = buildModel( tour );
			if ( isHere( m.steps[ 0 ] ) ) {
				startRun( m, 0, { action: 'start' } );
			} else {
				window.location.href = stepHref( m.steps[ 0 ], { awb_start: m.id } );
			}
			return;
		}

		const res = await sendProgress( Number( tour.id ), action );
		if ( ! res.ok ) {
			toast( failMessage( res ) );
			reveal( ui.offer, true );
		}
	}

	/* ---------- Input ---------- */

	function onRootClick( e ) {
		const btn = e.target.closest( '[data-awb]' );
		if ( ! btn || btn.disabled ) {
			return;
		}

		const action = btn.getAttribute( 'data-awb' );

		if ( action === 'close' ) {
			closeEnd();
		} else if ( action === 'replay' ) {
			replay();
		} else if ( action === 'remind' ) {
			remind();
		} else if ( action.indexOf( 'offer-' ) === 0 ) {
			answerOffer( action.slice( 6 ) );
		}

		if ( ! run ) {
			return;
		}

		switch ( action ) {
			case 'next':
				next();
				break;
			case 'prev':
				prev();
				break;
			case 'skip':
				skip();
				break;
			case 'skip-chapter':
				skipChapter();
				break;
			case 'list':
				togglePanel();
				break;
			case 'minimize':
				minimize();
				break;
			case 'restore':
				restore();
				break;
			case 'exit':
				exitRun();
				break;
			case 'goto':
				navigate( currentStep() );
				break;
			case 'chapter':
				onChapterClick( e, btn );
				break;
			case 'jump':
				goTo( toInt( btn.getAttribute( 'data-index' ) ) );
				break;
		}
	}

	function onKey( e ) {
		if ( e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey ) {
			return;
		}

		const inside = e.target instanceof window.Node && ui.root.contains( e.target );

		if ( e.key === 'Escape' ) {
			if ( isOpen( ui.card ) ) {
				closeCard();
			} else if ( isOpen( ui.panel ) ) {
				togglePanel( false );
				ui.barButtons.list.focus();
			} else if ( isOpen( ui.end ) ) {
				closeEnd();
			} else if ( run && ! run.min && mode && ( inside || ! isTyping( e.target ) ) ) {
				minimize();
			} else {
				return;
			}
			e.preventDefault();
			return;
		}

		if ( ! run || run.min || ! isOpen( ui.pop ) || ( ! inside && isTyping( e.target ) ) ) {
			return;
		}

		if ( e.key === 'ArrowRight' && ! ui.popNext.hidden ) {
			e.preventDefault();
			next();
		} else if ( e.key === 'ArrowLeft' && run.index > 0 ) {
			e.preventDefault();
			prev();
		}
	}

	/* ---------- Start ---------- */

	function adopt( m, stored ) {
		const total = m.steps.length;
		if ( ! total ) {
			removeStore( RUN_KEY );
			return false;
		}

		model = m;
		run = {
			tour: m.id,
			index: clamp( toInt( stored.index ), 0, total ),
			preview: !! stored.preview,
			nav: !! stored.nav,
			navStep: typeof stored.navStep === 'string' ? stored.navStep : '',
			max: 0,
			min: !! stored.min,
			ended: !! stored.ended,
		};
		run.max = clamp( Math.max( toInt( stored.max ), run.index ), 0, total );

		const step = m.steps[ run.index ];
		landedStep = run.nav && step && run.navStep === step.id ? step.id : '';

		render( true );
		return true;
	}

	async function loadPreview( id, stepIndex, stored ) {
		const res = await api( 'GET', 'tours/' + id, null, { query: { context: 'play' } } );

		if ( ! res.ok || ! res.data || ! Array.isArray( res.data.steps ) ) {
			// Keep a stored run through a network blip so a reload can pick it up.
			if ( stored && ! res.network ) {
				removeStore( RUN_KEY );
			}
			toast(
				res.network
					? t( 'networkError', 'Couldn’t reach the site. Check your connection and try again.' )
					: fmt( t( 'previewError', 'Couldn’t load the preview (error %s).' ), res.status )
			);
			return;
		}

		const m = buildModel( res.data );
		if ( ! m.steps.length ) {
			toast( t( 'previewEmpty', 'This walkthrough has no steps yet.' ) );
			return;
		}

		if ( stored ) {
			adopt( m, Object.assign( {}, stored, { preview: true } ) );
		} else {
			startRun( m, stepIndex, { preview: true } );
		}
	}

	function resumeStored( stored ) {
		if ( ! stored || typeof stored !== 'object' || ! toInt( stored.tour ) ) {
			return false;
		}

		if ( stored.preview ) {
			if ( ! cfg.canManage ) {
				removeStore( RUN_KEY );
				return false;
			}
			loadPreview( toInt( stored.tour ), 0, stored );
			return true;
		}

		const tour = findTour( stored.tour );
		if ( ! tour ) {
			removeStore( RUN_KEY );
			return false;
		}

		return adopt( buildModel( tour ), stored );
	}

	function startFromLink( id, resume ) {
		const tour = findTour( id );
		const m = tour ? buildModel( tour ) : null;
		if ( ! m || ! m.steps.length ) {
			return false;
		}

		let index = 0;
		if ( resume && tour.progress && tour.progress.step ) {
			index = Math.max( 0, m.steps.findIndex( ( s ) => s.id === tour.progress.step ) );
		}

		startRun( m, index, { action: resume ? 'step' : 'start' } );
		return true;
	}

	function autoStart() {
		const tour = tours.find(
			( item ) =>
				item.settings &&
				item.settings.auto_start &&
				! ( item.progress && item.progress.status ) &&
				Array.isArray( item.steps ) &&
				item.steps.length &&
				item.steps[ 0 ].screen === cfg.screen
		);

		if ( ! tour ) {
			return false;
		}

		startRun( buildModel( tour ), 0, { action: 'start' } );
		return true;
	}

	function init() {
		const previewId = toInt( params.get( 'awb_preview' ) );

		stripParams();

		// An explicit link (preview button, Guides menu) wins over whatever this tab had running.
		if ( previewId && cfg.canManage ) {
			removeStore( RUN_KEY );
			loadPreview( previewId, toInt( params.get( 'awb_step' ) ), null );
			return;
		}

		const startId = toInt( params.get( 'awb_start' ) );
		if ( startId && startFromLink( startId, params.get( 'awb_resume' ) === '1' ) ) {
			return;
		}

		if ( resumeStored( readStore( RUN_KEY ) ) ) {
			return;
		}

		if ( ! autoStart() ) {
			showOffer();
		}
	}

	if ( params.has( 'awb_preview' ) && ! params.has( 'awb_build' ) ) {
		// A preview tab must never inherit build mode, even if the browser copied sessionStorage over.
		removeStore( BUILD_KEY );
	}

	if ( params.has( 'awb_build' ) || readStore( BUILD_KEY ) ) {
		return;
	}

	// The builder can switch build mode on without a reload (new walkthrough from the toolbar); I step aside.
	window.addEventListener( 'awb:build', () => {
		resetStep();
		if ( ui ) {
			setBar( false );
			[ ui.pop, ui.dim, ui.spotlight, ui.pill, ui.end, ui.offer ].forEach( ( node ) => reveal( node, false ) );
		}
	} );

	// Back/forward cache: the run may have moved on in a later page, so storage is the truth.
	window.addEventListener( 'pageshow', ( e ) => {
		if ( ! e.persisted || readStore( BUILD_KEY ) ) {
			return;
		}
		const stored = readStore( RUN_KEY );
		if ( run && ! stored ) {
			teardown();
		} else if ( stored ) {
			resumeStored( stored );
		}
	} );

	init();
} )();
