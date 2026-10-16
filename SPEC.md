# Admin Walkthrough Builder — build contract

Interactive step-by-step guides (floating popovers + a YouTube-style chapter bar) inside wp-admin, so agencies can train clients who don't know WordPress and cut post-delivery support.

Plugin folder: `/workspace/repo/admin-walkthrough-builder` (symlinked into `/workspace/wp-core/wp-content/plugins/`).
Slug / text domain: `admin-walkthrough-builder`. Prefix: `AWB_` (classes/constants), `awb_` (options, meta, hooks, actions), `awb-` (CSS/handles).
Style reference: copy the conventions of `/workspace/repo/live-admin-cursors` — plain `includes/class-awb-*.php` final classes with static `init()`, no composer/namespaces, PHP 7.4+, WP 6.2+, tabs, WPCS formatting, vanilla JS IIFE (`'use strict'`, `const`/`let`, no jQuery except `jquery-ui-sortable` in the editor), `filemtime` asset versions.
Comments: short, first person, only for the non-obvious why (see `/workspace/repo/.claude/context/philosophy.md` "Comments"). Don't bump the version (stays 1.0.0).

---

## 1. Data model

### Tour = custom post type `awb_tour`
`public => false, show_ui => false, show_in_rest => false, supports => title`. `post_title` = tour title, `post_excerpt` = tour description, `post_status` = `publish` (live) or `draft`.
Everything else lives in post meta `_awb_tour` (array):

```jsonc
{
  "chapters": [ { "id": "c_k3j9a1", "title": "Your pages", "description": "Where pages live and how to add one." } ],
  "steps": [
    {
      "id": "s_p0q8z2",
      "chapter": "c_k3j9a1",          // must be an existing chapter id
      "title": "This is the Pages menu",
      "content": "Raw text, basic HTML allowed",   // kses: a[href,target,rel], strong, b, em, i, br, p, ul, ol, li, code, kbd, mark
      "url": "edit.php?post_type=page", // admin-relative URL used to NAVIGATE to the step (no scheme/host, no leading slash, no 'wp-admin/')
      "screen": "edit-page",           // WP screen id (get_current_screen()->id) used to MATCH the current page
      "selector": "#menu-pages",       // CSS selector of the highlighted element; '' = floating (centered) step
      "label": "Pages",                // short text of the picked element, only for the editor list (max 80 chars)
      "placement": "auto",             // auto|top|bottom|left|right
      "advance": "next"                // next = Next button | click = person must click the highlighted element
    }
  ],
  "settings": {
    "roles": ["editor"],        // role slugs that see the tour
    "users": [12, 15],          // extra specific user ids
    "auto_start": true,         // start by itself the first time they open the first step's screen
    "allow_skip": true,         // Skip step / Skip chapter / jumping ahead in the bar
    "allow_exit": true,         // ✕ button (close the walkthrough)
    "allow_replay": true,       // replay after finishing + reminders
    "refresh_days": 0,          // 0 = off; else offer a refresher N days after finishing (1..365)
    "bar_position": "top"       // top|bottom
  }
}
```
Rules enforced on every save (server): ids match `/^[cs]_[a-z0-9]{4,12}$/` (generate one with `wp_generate_password(8,false)` lowercased when missing/invalid); at least one chapter (create "Getting started" if none); max 50 chapters / 200 steps; steps re-ordered so they're grouped by chapter in chapter order (stable within a chapter); steps pointing at unknown chapters go to the first chapter; title ≤ 200 chars (`sanitize_text_field`), descriptions `sanitize_textarea_field`, `content` through `wp_kses` with the allow-list above; `selector` = `wp_strip_all_tags`, ≤ 500 chars; `screen` = `sanitize_key`; `url` normalised (strip a leading `/`, anything up to and including `wp-admin/`, reject if it has a scheme or starts with `//`, `sanitize_text_field`, ≤ 500 chars, default `index.php`); enums fall back to defaults; roles intersected with `wp_roles()->get_names()` keys; users `absint` + must exist; `refresh_days` clamped 0..365.
Defaults for a new tour: one chapter "Getting started", no steps, roles `[]`, users `[]`, auto_start true, allow_skip true, allow_exit true, allow_replay true, refresh_days 0, bar_position top, status draft.

### Progress = per-site user option `awb_progress`
`get_user_option('awb_progress')` / `update_user_option($uid, 'awb_progress', $data)` (per-site prefix, multisite-safe). Shape keyed by tour id:
```jsonc
{ "42": { "status": "in_progress", "step": "s_p0q8z2", "updated": 1760000000, "completed": 0, "remind_at": 0, "no_remind": false, "runs": 1 } }
```
`status`: `in_progress` | `completed` | `dismissed`. Missing entry = not started.

### Audience
User sees a tour when: tour is `publish` AND (user has one of `settings.roles` — super admins count as `administrator` — OR user id is in `settings.users`).

### Capability
Building/managing = `AWB_Tours::capability()` → `apply_filters( 'awb_capability', 'manage_options' )`.

### Refresher offer (server-computed)
For each visible tour with `allow_replay` and progress `completed` and not `no_remind`: `due = remind_at ?: ( refresh_days > 0 ? completed + refresh_days * DAY_IN_SECONDS : 0 )`. If `due && time() >= due` → offer it (first match only).

---

## 2. REST API — namespace `admin-walkthrough-builder/v1`, cookie auth + `wp_rest` nonce

| Route | Method | Permission | Body / params | Returns |
|---|---|---|---|---|
| `/tours/(?P<id>\d+)` | GET | capability | `context=edit\|play` (default edit) | edit or play shape (below) |
| `/tours/(?P<id>\d+)` | POST | capability | `{title, description, status, chapters, steps, settings}` | edit shape after sanitize+save |
| `/tours/(?P<id>\d+)/reset` | POST | capability | `{user: int}` (0 = everyone) | `{ok:true}` — deletes that tour's progress entry for the user(s) |
| `/progress` | POST | logged in; tour must be visible to the user | `{tour:int, action, step?:string, days?:int}` | `{progress: {...entry}}` |

`/progress` actions: `start` (status in_progress, step = given or first step, runs++, remind_at 0) · `step` (status in_progress, step) · `complete` (status completed, completed = now, step '', remind_at 0) · `dismiss` (status dismissed unless already completed; keep step) · `remind` (remind_at = now + days·DAY, days 1..365, no_remind false) · `later` (remind_at = now + 3 days) · `never` (no_remind true, remind_at 0). Always set `updated = now`.

**Edit shape**: `{id, title, description, status, chapters, steps (raw content), settings (full), modified (unix)}`.
**Play shape**: `{id, title, description, chapters, steps: [{id, chapter, title, html, url, screen, selector, placement, advance}], settings: {auto_start, allow_skip, allow_exit, allow_replay, bar_position}, progress: {status, step, completed, runs}}` — `html = wpautop( content )`.

---

## 3. Script config objects (wp_localize_script)

Never load anything on: AJAX, network/user admin, `IFRAME_REQUEST`, logged-out.

### `awbPlayer` — handle `awb-player` (`assets/js/player.js` + `assets/css/player.css`)
Loaded on every wp-admin screen for users with ≥1 visible tour OR the capability.
```jsonc
{
  "root": "https://…/wp-json/admin-walkthrough-builder/v1/",
  "nonce": "…",
  "adminUrl": "https://…/wp-admin/",
  "screen": "edit-page",                 // get_current_screen()->id
  "canManage": true,
  "tours": [ /* play shape, only tours visible to this user */ ],
  "offer": { "tour": 42, "days": 9 },    // or null; days = whole days since completion
  "i18n": { /* every visible string */ }
}
```

### `awbBuilder` — handle `awb-builder` (`assets/js/builder.js` + `assets/css/builder.css`)
Loaded on every wp-admin screen for users with the capability (it stays idle unless build mode is on).
```jsonc
{ "root", "nonce", "adminUrl", "screen", "editUrl": "…/wp-admin/admin.php?page=awb-walkthrough&tour=", "i18n": {} }
```

### `awbEditor` — handle `awb-editor` (`assets/js/editor.js` + `assets/css/editor.css`, deps `jquery-ui-sortable`)
Only on the editor screen.
```jsonc
{
  "root", "nonce", "adminUrl",
  "tour": { /* edit shape */ },
  "roles": [ { "slug": "editor", "label": "Editor" } ],
  "users": { "12": { "name": "Ana Costa", "avatar": "https://…" } },   // the ones already in settings.users
  "screens": [ { "group": "Pages", "label": "All Pages", "url": "edit.php?post_type=page" } ], // flattened admin menu the current user can reach
  "listUrl": "…/admin.php?page=awb-walkthroughs",
  "i18n": {}
}
```

---

## 4. URL params & session state (shared between player.js and builder.js)

- `awb_build=<tour>&awb_chapter=<chapterId>` → builder turns on and stores `sessionStorage['awb_build'] = {"tour":42,"chapter":"c_…"}`; it stays on across page loads in that tab until **Done**.
- `awb_preview=<tour>[&awb_step=<index>]` → player fetches `/tours/<id>?context=play` and runs it in preview mode (no progress saved, ignores audience/status). Builder must stay idle on a page with `awb_preview` and must open previews with `window.open(url, '_blank', 'noopener')` so the new tab doesn't inherit build mode.
- `awb_start=<tour>[&awb_resume=1]` → player starts that tour from the beginning (or from the saved progress step when `awb_resume=1`).
- Player run state: `sessionStorage['awb_run'] = {"tour":42,"index":3,"preview":false,"nav":true}` (`nav` = the player itself navigated, so on arrival show the step; if the person wandered off themselves, show a "This step is on another screen — Take me there" card instead of yanking them).
- Remove all `awb_*` params with `history.replaceState` after reading them.
- Player stays completely idle while build mode is on (`sessionStorage.awb_build` present or `awb_build` in URL).

Screen matching: a step is "here" when `step.screen === cfg.screen`. Navigating to a step = `location.href = adminUrl + step.url`.

---

## 5. Admin screens (PHP)

Top-level menu **Walkthroughs** (`dashicons-welcome-learn-more`, capability above):
- `admin.php?page=awb-walkthroughs` — list (plain `widefat striped` table, not WP_List_Table): Title (row actions: Edit · Preview · Duplicate · Export · Delete), Status (Live/Draft), Steps ("8 steps · 3 chapters"), Who sees it (role names + "N people"), Progress ("5 of 9 finished"), Updated. "Add New" (admin-post `awb_create` → draft with defaults → redirect to editor). Import box (file upload `.json`, admin-post `awb_import` → sanitized → new draft). Empty state with a short "How it works" (1. Create 2. Click elements on any screen 3. Pick who sees it).
- `admin.php?page=awb-walkthrough&tour=<id>` — editor (hidden submenu: register under the parent then remove from the submenu, or `add_submenu_page(null/'' …)`). PHP renders: `<div class="wrap awb-wrap">`, `<h1>` + back link, nav tabs **Steps** / **People** (`&tab=people`), Steps tab = `<div id="awb-editor" class="awb-editor"></div>` filled by editor.js; People tab = server-rendered table (avatar, name+email, role, status pill: Not started / In progress (step X of N) / Finished (date) / Closed / Reminder on (date), Reset button `data-awb-reset="<uid>"` + "Reset everyone"), summary counts on top (Finished · In progress · Not started). Reset buttons call REST `/tours/<id>/reset` with a tiny inline-free script in editor.js.
- admin-post actions, all nonce + capability checked: `awb_create`, `awb_duplicate`, `awb_delete`, `awb_export` (download `walkthrough-<slug>.json` = `{version:1, title, description, chapters, steps, settings}` with `settings.users` emptied), `awb_import`.
- Preview URL = `admin_url( first_step.url )` + `awb_preview=<id>` (disabled when there are no steps).
- Plugin action link "Walkthroughs" on the Plugins screen.

### Toolbar "Guides" (admin bar, wp-admin only)
For users with ≥1 visible tour (or the capability): node `awb-guides` in `top-secondary`, title = icon + "Guides" + count badge of tours not started yet. Children per tour: title + state ("New", "In progress · 3/12", "Finished ✓"); href = first step url with `awb_start=<id>`, or the saved step's url with `awb_start=<id>&awb_resume=1` when in progress; finished + `allow_replay=false` → no href (shown as done). For managers: a last child "Manage walkthroughs".

### Uninstall
Delete all `awb_tour` posts (+meta), every user's `{blog_prefix}awb_progress` meta, on every site (pattern from live-admin-cursors `uninstall.php`).

---

## 6. Player UX (player.js) — the part learners see

Start order on page load: (1) resume `sessionStorage.awb_run`; (2) `awb_preview` param (needs canManage); (3) `awb_start` param; (4) auto-start: first tour with `auto_start`, no progress entry, and `steps[0].screen === cfg.screen`; (5) otherwise show the refresher offer if `cfg.offer`.

Elements (all inside one `<div class="awb-root" data-position="top|bottom">` appended to `<body>`; classes are the contract with player.css):

```
.awb-root[data-position]
  .awb-spotlight                 – absolutely/fixed positioned box over the target rect (+8px pad), huge box-shadow dims the rest. pointer-events:none
  .awb-dim                       – full-screen dim used for floating steps / end card
  .awb-bar  (role=region)        – fixed full-width bar under the admin bar (top) or at the bottom
    .awb-bar__info  > .awb-bar__tour, .awb-bar__chapter
    .awb-bar__progress
      .awb-track (role=list)
        button.awb-track__chapter[.is-done|.is-current][style=flex-grow:<steps in chapter>] (aria-label "Chapter 2: Title")
          .awb-track__fill[style=width:<% of chapter done>]
          .awb-track__ticks > span.awb-track__tick[.is-done|.is-current]   – one per step
      .awb-bar__meta             – "Step 5 of 12 · Step title"
    .awb-bar__actions > button.awb-btn.awb-btn--icon[data-awb=prev|skip|skip-chapter|list|minimize|exit]  (each with aria-label + title, inline SVG icon)
  .awb-chapter-card[hidden]      – YouTube-style hover preview under (or above, for bottom bar) the hovered chapter segment
    .awb-chapter-card__eyebrow ("Chapter 2 of 4 · 3 steps"), .awb-chapter-card__title, .awb-chapter-card__desc,
    ol.awb-chapter-card__steps > li[.is-done|.is-current] > button (jump to step)
  .awb-steps-panel[hidden]       – full list from the ☰ button: per chapter .awb-steps-panel__chapter > h3 + p + ol > li > button
  .awb-pop (role=dialog, data-placement=top|bottom|left|right|center)
    .awb-pop__arrow, .awb-pop__eyebrow (chapter title), h2.awb-pop__title, .awb-pop__body (step html),
    .awb-pop__notice (element not found / step is on another screen + "Take me there" button),
    .awb-pop__hint ("Click the highlighted item to continue" for advance=click),
    .awb-pop__footer > .awb-pop__count ("3 / 12") + .awb-pop__buttons > button.awb-btn.awb-btn--ghost[data-awb=prev], button.awb-btn.awb-btn--ghost[data-awb=skip] (click steps), button.awb-btn.awb-btn--primary[data-awb=next] ("Next" / "Finish")
  .awb-pill[hidden]              – minimized state, bottom-right: button[data-awb=restore] "Resume ‘Tour’ · 5/12" + small progress ring/bar
  .awb-end[hidden] (role=dialog) – finish card: .awb-end__badge, h2.awb-end__title, .awb-end__text, ul.awb-end__chapters > li.is-done,
    .awb-end__remind (label "Remind me to go over this again in" + select 3/7/14/30 days + button) [only if allow_replay],
    .awb-end__actions > [data-awb=replay] (if allow_replay) + [data-awb=close]
  .awb-offer[hidden]             – refresher card bottom-right: __title "Time for a quick refresher?", __text "It's been 9 days since you went through ‘Tour’.", __actions: [data-awb=offer-replay] [data-awb=offer-later] [data-awb=offer-never]
  .awb-toast[hidden]             – small transient message
```
States on `<html>`: `.awb-has-bar` (+ `.awb-has-bar--top` / `--bottom`) while the bar is visible; CSS uses it to push the page down/up by the bar height so the bar never covers wp-admin content.

Behaviour:
- Rendering a step: if not on its screen → if `run.nav` navigate, else show the "another screen" card. On its screen: wait up to ~4s for the selector (MutationObserver + timeout, `querySelector` in try/catch); found → scroll into view (smooth, centered) if needed, position spotlight + popover (preferred placement, flip when it doesn't fit, clamp to viewport, arrow points at the element), keep them glued on scroll/resize/DOM changes via rAF. Not found or `selector === ''` → centered popover over `.awb-dim` (with a notice when a selector was set but missing).
- Next on last step → end card. `advance=click`: no Next button, hint shown; a capturing click listener on the target advances (save `awb_run` index+1 with `nav:true` + send progress with `fetch(…, {keepalive:true})` BEFORE the default action, so a navigation still lands on the next step; if no navigation happens within ~400ms, render the next step in place).
- Skip step / Skip chapter / clicking ahead in the bar or lists only when `allow_skip`; going back always allowed. Exit (✕) only when `allow_exit` → progress `dismiss` + toast "You can pick it up again from Guides in the toolbar." Minimize → pill; restore from pill.
- Keyboard: → next (when allowed and advance=next), ← back, Esc minimize; ignore while typing in inputs. Focus moves to the popover title on each step (a11y), `aria-live` on the meta line.
- Progress calls (skipped in preview): `start` when a run begins, `step` on every step change, `complete` at the end card, `dismiss` on exit, `remind` from the end card, `later`/`never` from the offer.
- Offer → Replay: navigate to `steps[0].url` with `awb_start=<id>`.
- Mobile (< 782px): admin bar is 46px; bar compacts (hide `.awb-bar__info`, keep track + actions), popover becomes a bottom sheet.

## 7. Builder UX (builder.js) — the part the agency uses

Active only when build mode is on (§4). Loads the tour with `GET /tours/<id>?context=edit`, saves with `POST /tours/<id>` (full definition) after each change.
- **Dock** (`.awb-build`, fixed bottom-center, draggable is NOT needed; collapsible): "Building: <tour title>", chapter select (where new steps go, default = `awb_chapter`), buttons **Pick element** · **Floating step** · **Preview** (from the first step of this screen, new tab with noopener) · **Done** (clears build mode, goes to `editUrl + id`). Below: steps of this tour that are on this screen (numbered, click to edit) and a count of total steps; a hint "Browse normally to add steps on other screens — build mode follows you."
- **Markers**: numbered badges (`.awb-build-marker`) on the elements of existing steps on this screen.
- **Pick mode**: hover outline box (`.awb-build-hover` + label with a readable element name) following the element under the mouse; click (capture phase, preventDefault + stopPropagation) selects it; Esc cancels; ignore the plugin's own UI. Generate a robust unique selector: stable `#id` (skip ids with 4+ digit runs or `:`), else build a path upward using `a[href="…"]` for links, `[name="…"]` for form fields, distinctive non-state classes, `:nth-of-type` as last resort, stopping as soon as `querySelectorAll(sel)` matches only that element. Use `CSS.escape`.
- **Step form** (`.awb-build-form`, popover next to the picked element, or centered for floating): Title, Text (textarea with tiny **B** / *I* / Link buttons that wrap the selection in `<strong>`/`<em>`/`<a href>`), Chapter, Placement (Auto/Top/Bottom/Left/Right; hidden for floating), "Moves on when" (They press Next / They click this element; hidden for floating), Save / Cancel / Delete (existing). New steps get `url` = current admin-relative URL minus volatile params (`_wpnonce`, `_wp_http_referer`, `message`, `updated`, `settings-updated`, `deleted`, `trashed`, `untrashed`, `ids`, `locked`, `awb_*`), `screen` = `cfg.screen`, appended at the end of the chosen chapter.

Known limit to mention in readme: elements inside the block editor's iframe canvas can't be picked (toolbar/sidebars can).

## 8. Editor UX (editor.js) — the hub screen

Two columns (main + 280px sidebar, stacks under 960px). Main: big title input, description textarea ("Shown at the start…" no — description is shown in Guides/intro; keep short). Chapters as cards: title input, description textarea (hint: "Shown when people hover this chapter in the progress bar"), move up/down, delete (confirm; its steps move to the previous chapter). Steps inside each chapter as a sortable list (jquery-ui-sortable, `connectWith` across chapters, drag handle): number, title, where (screen label from `screens` by url, else the url), badge "Element"/"Floating" and "Click to continue" when advance=click, actions: Edit (inline expand: title, text, placement, advance), Show on screen (go to `adminUrl + step.url` with `awb_build=<id>&awb_chapter=<chapter>`), Delete. Per chapter button **Add steps on a screen…** → dialog (`<dialog class="awb-dialog">`) with a search box over `screens` (grouped) + "or paste a wp-admin URL"; choosing one saves first if dirty, then navigates to it in build mode. **Add chapter** button.
Sidebar boxes: **Publish** (Draft/Live toggle, Save button with "Saved ✓"/"Unsaved changes" state, Preview link — disabled with no steps, step/chapter count); **Who sees it** (role checkboxes + "Specific people" search box using `GET /wp/v2/users?search=…&per_page=10&context=edit`? → use `context=view` fields id,name,avatar_urls, chips with remove; warning when nobody is selected); **Behaviour** (Start automatically the first time they open the first screen · Let them skip ahead · Let them close it · Allow replays · Offer a refresher after [N] days (0 = never, disabled unless replays) · Progress bar position Top/Bottom).
Save = `POST /tours/<id>`; Ctrl/Cmd+S saves; `beforeunload` warning when dirty. People-tab reset buttons (`[data-awb-reset]`) also handled here (confirm first, then reload).

---

## 9. v2 — Victor's direction (SUPERSEDES §5/§7/§8 wherever they conflict)

Victor: the authoring must happen **on the page itself**, through a **floating menu**, not in a form screen. "Click to create something, move around, set the bubble text right there." The editor screen becomes a secondary overview.

### 9.1 Entry points (PHP)
- List screen **Create walkthrough** button → admin-post `awb_create` creates the draft and redirects to `admin_url('index.php')` + `awb_build=<id>&awb_chapter=<first chapter>&awb_new=1` (the floating builder opens on the Dashboard with the title field focused). Each list row also gets **Build** (opens build mode at the first step's url, or Dashboard when empty) as the primary row action, before Edit.
- Toolbar (managers only, wp-admin): node `awb-build` in `top-secondary`, title = pencil/tour icon + "Build", children: **+ New walkthrough** (`#` link with `data-awb-new` — builder.js handles it: POST `/tours` then enters build mode on the CURRENT page), then one child per existing tour (any status) → current page url + `awb_build=<id>`, then "All walkthroughs". Keep the learner "Guides" node separate.
- New REST route **`POST /tours`** (capability) `{title}` → creates a draft with defaults, returns the edit shape (201).
- New REST route **`DELETE /tours/<id>`** is NOT needed.
- `awbBuilder` gains: `roles` [{slug,label}], `users` {} (empty map; builder resolves names via /wp/v2/users when the settings panel opens), `listUrl`, `newTour` (bool, true when `awb_new=1` was in the URL), `screens` (same flattened admin-menu list as awbEditor, for "Go to screen…" inside the menu), and builder i18n.
- `awbBuilder` must be loaded with the PLAYER css too (builder reuses `.awb-pop` styling for the WYSIWYG bubble) — enqueue `awb-player` style as a dependency of `awb-builder` style.

### 9.2 Floating builder menu (builder.js) — the main authoring tool
A compact floating panel `.awb-build` (≈320px wide), **draggable by its header** (pointer events, clamp to viewport, remember position in localStorage `awb_build_pos`, snap to the nearest edge on release), collapsible to a small round launcher `.awb-build-launcher` (shows step count). Sections:
1. **Header** — editable tour title (inline input, saves on blur/Enter), status chip Draft/Live (click toggles publish), collapse button, close (= Done: leaves build mode, returns to where you are, NOT forced to the editor; a toast offers "Open overview").
2. **Primary actions** — big **＋ Add step** button (→ pick mode: "Click anything on the page… (Esc to cancel)", hovering outlines elements with a readable label; click places the step), small **＋ Bubble in the middle** (floating step), **▶ Preview** (new tab, noopener), **⚙ Settings**.
3. **Outline** — chapters as collapsible groups with editable title + description (inline, small), steps listed under them: number, title, a dot when the step is on THIS screen vs a "↗ other screen" hint with the screen name. Click a step on this screen → scroll to it and open its bubble; click a step on another screen → navigate there (build mode follows) and open it on arrival (`sessionStorage.awb_build.open = stepId`). Drag steps to reorder (within and across chapters; pointer-based, no jQuery). **＋ Chapter** at the bottom; the "current chapter" (where new steps go) is highlighted and selected by clicking a chapter header.
4. **Settings panel** (slides over the outline inside the menu, back arrow): Who sees it (role chips toggle + people search via /wp/v2/users), and the behaviour switches (auto start, skip, close, replay, refresher days, bar top/bottom). Same fields as §8 sidebar, saved immediately.
5. **Footer status** — "Saved ✓" / "Saving…" / error with Retry. Everything autosaves (debounced 600ms) with `POST /tours/<id>`; no Save button.

### 9.3 WYSIWYG bubble editing
- When a step is placed or opened, render the **real learner bubble** (`.awb-pop` markup from §6, same CSS) attached to the element with the spotlight, plus edit affordances (`.awb-pop.is-editing`):
  - Title and body are `contenteditable` (body allows the kses tags only: strip everything else on save; paste as plain text). Placeholders "Step title" / "Write what this does…".
  - A small floating format bar above the body when text is selected: **B**, *I*, Link.
  - **Side handles**: four small arrow buttons on the bubble's edges (`.awb-pop__side[data-side=top|right|bottom|left]`) + an "Auto" option — click to set placement; the bubble re-positions instantly. Also allow **dragging the bubble**: on release it snaps to the side of the element nearest to where it was dropped.
  - Bubble toolbar row (`.awb-pop__tools`, under the content): "Moves on: [Next button | Click on element]" segmented control, chapter select, **Change element** (re-enters pick mode for this step), **Delete** (with an undo toast instead of a confirm).
  - The footer still shows the learner buttons (Back/Next, "3 / 12") greyed to show what learners will see.
  - Click outside (not on the menu) or Esc closes the bubble (autosaved). Only one bubble open at a time.
- **Markers**: numbered dots on the elements of this screen's steps (`.awb-build-marker`), click to open that bubble. Floating steps on this screen are listed in the menu only.

### 9.4 Editor screen (§8) becomes the overview
Keep it, but it's secondary: the top of the page shows a prominent **"Open the builder"** button (→ build mode at first step url or Dashboard). It remains useful for bulk reordering, the settings sidebar and the People tab. No changes needed in editor.js beyond what it does now, other than reading the reconciled i18n keys.
