<?php
/**
 * Loads the player and the builder on wp-admin screens, and adds "Guides" to the toolbar.
 *
 * @package AdminWalkthroughBuilder
 */

defined( 'ABSPATH' ) || exit;

/**
 * What learners and managers get on every wp-admin screen.
 */
final class AWB_Player {

	const PLAYER_HANDLE  = 'awb-player';
	const BUILDER_HANDLE = 'awb-builder';

	// Query args that only make sense once, so the toolbar's "Build" links drop them from the current URL.
	const VOLATILE_ARGS = array( '_wpnonce', '_wp_http_referer', 'message', 'updated', 'settings-updated', 'deleted', 'trashed', 'untrashed', 'ids', 'locked', 'awb_build', 'awb_chapter', 'awb_new', 'awb_preview', 'awb_step', 'awb_start', 'awb_resume', 'awb_notice' );

	/**
	 * Wires up the hooks.
	 */
	public static function init(): void {
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue_assets' ) );
		add_action( 'admin_bar_menu', array( __CLASS__, 'add_admin_bar_menu' ), 100 );
	}

	/**
	 * Only real, top-level wp-admin screens for logged-in people.
	 * Thickbox iframes, AJAX and the network/user admin never get a tour.
	 */
	private static function is_active_screen(): bool {
		return is_admin()
			&& is_user_logged_in()
			&& ! wp_doing_ajax()
			&& ! is_network_admin()
			&& ! is_user_admin()
			&& ! defined( 'IFRAME_REQUEST' );
	}

	/**
	 * Plugin version plus the file time, so browsers never keep running an old copy after an update.
	 *
	 * @param string $path Path relative to the plugin folder.
	 */
	public static function asset_version( string $path ): string {
		$file = plugin_dir_path( AWB_FILE ) . $path;
		return file_exists( $file ) ? AWB_VERSION . '.' . (int) filemtime( $file ) : AWB_VERSION;
	}

	/**
	 * Enqueues a script + style pair from assets/.
	 *
	 * @param string             $handle     Handle for both.
	 * @param string             $name       File name without extension.
	 * @param array<int, string> $deps       Script dependencies.
	 * @param array<int, string> $style_deps Style dependencies.
	 */
	public static function enqueue_pair( string $handle, string $name, array $deps = array(), array $style_deps = array() ): void {
		$url = plugin_dir_url( AWB_FILE );
		$css = 'assets/css/' . $name . '.css';
		$js  = 'assets/js/' . $name . '.js';

		wp_enqueue_style( $handle, $url . $css, $style_deps, self::asset_version( $css ) );
		wp_enqueue_script( $handle, $url . $js, $deps, self::asset_version( $js ), true );
	}

	/**
	 * The current screen id, as the player matches steps against it.
	 */
	private static function screen_id(): string {
		$screen = get_current_screen();
		return $screen ? (string) $screen->id : '';
	}

	/**
	 * Enqueues the player for anyone with a tour or the capability, and the builder for managers.
	 */
	public static function enqueue_assets(): void {
		if ( ! self::is_active_screen() ) {
			return;
		}

		$user       = wp_get_current_user();
		$tours      = AWB_Tours::visible_for( $user );
		$can_manage = AWB_Tours::can_manage();

		if ( ! $tours && ! $can_manage ) {
			return;
		}

		$common = array(
			'root'     => esc_url_raw( rest_url( AWB_Rest::ROUTE_NAMESPACE . '/' ) ),
			'nonce'    => wp_create_nonce( 'wp_rest' ),
			'adminUrl' => esc_url_raw( admin_url() ),
			'screen'   => self::screen_id(),
		);

		$play = array();

		foreach ( $tours as $post ) {
			$play[] = AWB_Tours::play_shape( $post, (int) $user->ID );
		}

		self::enqueue_pair( self::PLAYER_HANDLE, 'player' );

		// wp_localize_script() turns top-level booleans into strings, hence '1' / ''.
		wp_localize_script(
			self::PLAYER_HANDLE,
			'awbPlayer',
			$common + array(
				'canManage' => $can_manage ? '1' : '',
				'tours'     => $play,
				'offer'     => AWB_Progress::offer( $tours, (int) $user->ID ),
				'i18n'      => self::player_strings(),
			)
		);

		if ( ! $can_manage ) {
			return;
		}

		// The builder reuses window.awbUI from player.js and the player's .awb-pop styles for its bubbles.
		self::enqueue_pair( self::BUILDER_HANDLE, 'builder', array( self::PLAYER_HANDLE ), array( self::PLAYER_HANDLE ) );

		$roles = array();

		foreach ( wp_roles()->get_names() as $slug => $label ) {
			$roles[] = array(
				'slug'  => $slug,
				'label' => translate_user_role( $label ),
			);
		}

		wp_localize_script(
			self::BUILDER_HANDLE,
			'awbBuilder',
			$common + array(
				'editUrl' => esc_url_raw( admin_url( 'admin.php?page=' . AWB_Admin::EDITOR_SLUG . '&tour=' ) ),
				'listUrl' => esc_url_raw( AWB_Admin::list_url() ),
				'newTour' => '1' === AWB_Admin::query_var( 'awb_new' ) ? '1' : '',
				'roles'   => $roles,
				// Empty on purpose: the builder looks names up through /wp/v2/users when its settings open.
				'users'   => (object) array(),
				'screens' => AWB_Admin::admin_screens(),
				'i18n'    => self::builder_strings(),
			)
		);
	}

	/**
	 * "Guides" in the toolbar: one entry per tour with where the person is in it.
	 *
	 * @param WP_Admin_Bar $bar The admin bar.
	 */
	public static function add_admin_bar_menu( WP_Admin_Bar $bar ): void {
		if ( ! self::is_active_screen() ) {
			return;
		}

		$user       = wp_get_current_user();
		$tours      = AWB_Tours::visible_for( $user );
		$can_manage = AWB_Tours::can_manage();

		if ( ! $tours && ! $can_manage ) {
			return;
		}

		if ( $can_manage ) {
			self::add_build_menu( $bar );
		}

		$progress = AWB_Progress::all( (int) $user->ID );
		$new      = 0;

		foreach ( $tours as $post ) {
			if ( ! isset( $progress[ (int) $post->ID ] ) ) {
				++$new;
			}
		}

		$title = '<span class="ab-icon dashicons dashicons-welcome-learn-more" aria-hidden="true"></span>'
			. '<span class="ab-label">' . esc_html__( 'Guides', 'admin-walkthrough-builder' ) . '</span>';

		if ( $new ) {
			$title .= ' <span class="awb-guides__count">' . esc_html( number_format_i18n( $new ) ) . '</span>';
		}

		$bar->add_node(
			array(
				'id'     => 'awb-guides',
				'parent' => 'top-secondary',
				'title'  => $title,
				'meta'   => array(
					'class' => 'awb-guides',
					'title' => __( 'Guided walkthroughs', 'admin-walkthrough-builder' ),
				),
			)
		);

		foreach ( $tours as $post ) {
			$bar->add_node( self::tour_node( $post, $progress ) );
		}

		if ( $can_manage ) {
			$bar->add_node(
				array(
					'id'     => 'awb-guides-manage',
					'parent' => 'awb-guides',
					'title'  => esc_html__( 'Manage walkthroughs', 'admin-walkthrough-builder' ),
					'href'   => admin_url( 'admin.php?page=' . AWB_Admin::LIST_SLUG ),
					'meta'   => array( 'class' => 'awb-guides__manage' ),
				)
			);
		}
	}

	/**
	 * Managers' "Build" menu: start a new tour or switch any tour into build mode right on this screen.
	 *
	 * @param WP_Admin_Bar $bar The admin bar.
	 */
	private static function add_build_menu( WP_Admin_Bar $bar ): void {
		$bar->add_node(
			array(
				'id'     => 'awb-build',
				'parent' => 'top-secondary',
				'title'  => '<span class="ab-icon dashicons dashicons-edit" aria-hidden="true"></span><span class="ab-label">' . esc_html__( 'Build', 'admin-walkthrough-builder' ) . '</span>',
				'meta'   => array(
					'class' => 'awb-build-bar',
					'title' => __( 'Build walkthroughs on this screen', 'admin-walkthrough-builder' ),
				),
			)
		);

		// The admin bar can't put data attributes on its own links, so builder.js gets a link of mine inside the title.
		$bar->add_node(
			array(
				'id'     => 'awb-build-new',
				'parent' => 'awb-build',
				'title'  => '<a href="#" class="awb-build-bar__new" data-awb-new="1">' . esc_html__( '+ New walkthrough', 'admin-walkthrough-builder' ) . '</a>',
				'meta'   => array( 'class' => 'awb-build-bar__item awb-build-bar__item--new' ),
			)
		);

		$here = remove_query_arg( self::VOLATILE_ARGS );

		foreach ( AWB_Tours::query( AWB_Tours::STATUSES, 'DESC' ) as $post ) {
			$live = 'publish' === $post->post_status;

			$bar->add_node(
				array(
					'id'     => 'awb-build-tour-' . $post->ID,
					'parent' => 'awb-build',
					'title'  => '<span class="awb-build-bar__title">' . esc_html( $post->post_title ) . '</span> <span class="awb-build-bar__state">' . ( $live ? esc_html__( 'Live', 'admin-walkthrough-builder' ) : esc_html__( 'Draft', 'admin-walkthrough-builder' ) ) . '</span>',
					'href'   => add_query_arg( 'awb_build', (int) $post->ID, $here ),
					'meta'   => array( 'class' => 'awb-build-bar__item awb-build-bar__item--' . ( $live ? 'live' : 'draft' ) ),
				)
			);
		}

		$bar->add_node(
			array(
				'id'     => 'awb-build-all',
				'parent' => 'awb-build',
				'title'  => esc_html__( 'All walkthroughs', 'admin-walkthrough-builder' ),
				'href'   => AWB_Admin::list_url(),
				'meta'   => array( 'class' => 'awb-build-bar__item awb-build-bar__item--all' ),
			)
		);
	}

	/**
	 * Toolbar entry for one tour: New / In progress · 3/12 / Finished.
	 *
	 * @param WP_Post                                    $post     The tour.
	 * @param array<int, array<string, int|string|bool>> $progress The person's progress, keyed by tour ID.
	 * @return array<string, mixed>
	 */
	private static function tour_node( WP_Post $post, array $progress ): array {
		$id         = (int) $post->ID;
		$definition = AWB_Tours::definition( $post );
		$steps      = $definition['steps'];
		$settings   = $definition['settings'];
		$entry      = isset( $progress[ $id ] ) ? $progress[ $id ] : null;
		$href       = AWB_Tours::step_link( $steps[0], array( 'awb_start' => $id ) );
		$index      = $entry ? AWB_Tours::step_index( $steps, (string) $entry['step'] ) : -1;

		if ( $entry && 'completed' === $entry['status'] ) {
			$state = __( 'Finished ✓', 'admin-walkthrough-builder' );
			$class = 'finished';

			// Replays are off, so there's nothing to open; it just shows as done.
			if ( ! $settings['allow_replay'] ) {
				$href = false;
			}
		} elseif ( $entry && $index >= 0 ) {
			$state = sprintf(
				/* translators: 1: current step number, 2: total steps. */
				__( 'In progress · %1$d/%2$d', 'admin-walkthrough-builder' ),
				$index + 1,
				count( $steps )
			);
			$class = 'in-progress';
			$href  = AWB_Tours::step_link(
				$steps[ $index ],
				array(
					'awb_start'  => $id,
					'awb_resume' => 1,
				)
			);
		} else {
			$state = __( 'New', 'admin-walkthrough-builder' );
			$class = 'new';
		}

		$node = array(
			'id'     => 'awb-guides-tour-' . $id,
			'parent' => 'awb-guides',
			'title'  => '<span class="awb-guides__title">' . esc_html( $post->post_title ) . '</span> <span class="awb-guides__state">' . esc_html( $state ) . '</span>',
			'meta'   => array( 'class' => 'awb-guides__tour awb-guides__tour--' . $class ),
		);

		if ( $href ) {
			$node['href'] = $href;
		}

		return $node;
	}

	/**
	 * Every string the player shows. %s / %d / %1$s placeholders are filled in by player.js.
	 *
	 * @return array<string, string>
	 */
	private static function player_strings(): array {
		return array(
			'region'         => __( 'Walkthrough', 'admin-walkthrough-builder' ),
			'next'           => __( 'Next', 'admin-walkthrough-builder' ),
			'back'           => __( 'Back', 'admin-walkthrough-builder' ),
			'finish'         => __( 'Finish', 'admin-walkthrough-builder' ),
			'skip'           => __( 'Skip', 'admin-walkthrough-builder' ),
			'skipStep'       => __( 'Skip step', 'admin-walkthrough-builder' ),
			'skipChapter'    => __( 'Skip chapter', 'admin-walkthrough-builder' ),
			'steps'          => __( 'Steps', 'admin-walkthrough-builder' ),
			'allSteps'       => __( 'All steps', 'admin-walkthrough-builder' ),
			'minimize'       => __( 'Minimize', 'admin-walkthrough-builder' ),
			'exit'           => __( 'Exit', 'admin-walkthrough-builder' ),
			'exitLabel'      => __( 'Close the walkthrough', 'admin-walkthrough-builder' ),
			'resume'         => __( 'Resume', 'admin-walkthrough-builder' ),
			/* translators: 1: walkthrough title, 2: current step number, 3: total steps. */
			'resumeTour'     => __( 'Resume ‘%1$s’ · %2$d/%3$d', 'admin-walkthrough-builder' ),
			/* translators: 1: current step number, 2: total steps. */
			'stepOf'         => __( 'Step %1$d of %2$d', 'admin-walkthrough-builder' ),
			/* translators: 1: current step number, 2: total steps, 3: step title. */
			'stepMeta'       => __( 'Step %1$d of %2$d · %3$s', 'admin-walkthrough-builder' ),
			/* translators: 1: current step number, 2: total steps. */
			'count'          => __( '%1$d / %2$d', 'admin-walkthrough-builder' ),
			/* translators: 1: chapter number, 2: total chapters. */
			'chapterOf'      => __( 'Chapter %1$d of %2$d', 'admin-walkthrough-builder' ),
			/* translators: 1: chapter number, 2: chapter title. */
			'chapterLabel'   => __( 'Chapter %1$d: %2$s', 'admin-walkthrough-builder' ),
			/* translators: %d: number of steps (always 1). */
			'stepsOne'       => __( '%d step', 'admin-walkthrough-builder' ),
			/* translators: %d: number of steps. */
			'stepsMany'      => __( '%d steps', 'admin-walkthrough-builder' ),
			/* translators: 1: step number, 2: step title. */
			'goToStep'       => __( 'Go to step %1$d: %2$s', 'admin-walkthrough-builder' ),
			'stepDone'       => __( 'Done', 'admin-walkthrough-builder' ),
			'stepCurrent'    => __( 'You are here', 'admin-walkthrough-builder' ),
			'untitledStep'   => __( 'Untitled step', 'admin-walkthrough-builder' ),
			'notFound'       => __( 'Can’t find the item this step points at. It may be hidden right now, or this screen looks a little different.', 'admin-walkthrough-builder' ),
			'otherScreen'    => __( 'This step is on another screen.', 'admin-walkthrough-builder' ),
			'takeMeThere'    => __( 'Take me there', 'admin-walkthrough-builder' ),
			'clickHint'      => __( 'Click the highlighted item to continue', 'admin-walkthrough-builder' ),
			'previewBadge'   => __( 'Preview', 'admin-walkthrough-builder' ),
			'previewNotice'  => __( 'Preview: progress isn’t saved.', 'admin-walkthrough-builder' ),
			'loadError'      => __( 'This walkthrough couldn’t be loaded.', 'admin-walkthrough-builder' ),
			'endBadge'       => __( 'Finished', 'admin-walkthrough-builder' ),
			'endTitle'       => __( 'You’re all done!', 'admin-walkthrough-builder' ),
			/* translators: %s: walkthrough title. */
			'endText'        => __( 'You finished ‘%s’. Nice work.', 'admin-walkthrough-builder' ),
			'endChapters'    => __( 'What you covered', 'admin-walkthrough-builder' ),
			'remindLabel'    => __( 'Remind me to go over this again in', 'admin-walkthrough-builder' ),
			/* translators: %d: number of days. */
			'remindDays'     => __( '%d days', 'admin-walkthrough-builder' ),
			'remindButton'   => __( 'Remind me', 'admin-walkthrough-builder' ),
			/* translators: %d: number of days. */
			'remindSaved'    => __( 'Got it. You’ll get a reminder in %d days.', 'admin-walkthrough-builder' ),
			'replay'         => __( 'Go through it again', 'admin-walkthrough-builder' ),
			'close'          => __( 'Close', 'admin-walkthrough-builder' ),
			'offerTitle'     => __( 'Time for a quick refresher?', 'admin-walkthrough-builder' ),
			/* translators: %s: walkthrough title. */
			'offerTextToday' => __( 'You went through ‘%s’ earlier today.', 'admin-walkthrough-builder' ),
			/* translators: %s: walkthrough title. */
			'offerTextOne'   => __( 'It’s been a day since you went through ‘%s’.', 'admin-walkthrough-builder' ),
			/* translators: 1: number of days, 2: walkthrough title. */
			'offerText'      => __( 'It’s been %1$d days since you went through ‘%2$s’.', 'admin-walkthrough-builder' ),
			'offerReplay'    => __( 'Go through it again', 'admin-walkthrough-builder' ),
			'offerLater'     => __( 'Later', 'admin-walkthrough-builder' ),
			'offerNever'     => __( 'Don’t ask again', 'admin-walkthrough-builder' ),
			'toastExit'      => __( 'You can pick it up again from Guides in the toolbar.', 'admin-walkthrough-builder' ),
			'toastLater'     => __( 'Okay, we’ll ask again in a few days.', 'admin-walkthrough-builder' ),
			'toastNever'     => __( 'Okay, we won’t ask again.', 'admin-walkthrough-builder' ),
			'progressLabel'  => __( 'Walkthrough progress', 'admin-walkthrough-builder' ),
		);
	}

	/**
	 * Every string the floating builder menu, its bubbles and its settings panel show.
	 *
	 * @return array<string, string>
	 */
	private static function builder_strings(): array {
		return array(
			'menuLabel'                     => __( 'Walkthrough builder', 'admin-walkthrough-builder' ),
			'dragMenu'                      => __( 'Drag to move the builder', 'admin-walkthrough-builder' ),
			'collapse'                      => __( 'Collapse', 'admin-walkthrough-builder' ),
			'expand'                        => __( 'Open the builder', 'admin-walkthrough-builder' ),
			/* translators: %s: step count text, e.g. "3 steps". */
			'launcherLabel'                 => __( 'Open the builder (%s)', 'admin-walkthrough-builder' ),
			'done'                          => __( 'Done', 'admin-walkthrough-builder' ),
			'doneLabel'                     => __( 'Leave build mode', 'admin-walkthrough-builder' ),
			'buildModeOff'                  => __( 'Build mode is off.', 'admin-walkthrough-builder' ),
			'openOverview'                  => __( 'Open overview', 'admin-walkthrough-builder' ),
			'titleLabel'                    => __( 'Walkthrough title', 'admin-walkthrough-builder' ),
			'titlePlaceholder'              => __( 'Name this walkthrough', 'admin-walkthrough-builder' ),
			'untitledTour'                  => __( 'Untitled walkthrough', 'admin-walkthrough-builder' ),
			'statusDraft'                   => __( 'Draft', 'admin-walkthrough-builder' ),
			'statusLive'                    => __( 'Live', 'admin-walkthrough-builder' ),
			'makeLive'                      => __( 'Draft: click to set it live', 'admin-walkthrough-builder' ),
			'makeDraft'                     => __( 'Live: click to switch it back to draft', 'admin-walkthrough-builder' ),
			'nowLive'                       => __( 'It’s live. The people you picked will see it.', 'admin-walkthrough-builder' ),
			'nowDraft'                      => __( 'Switched back to draft. Nobody sees it now.', 'admin-walkthrough-builder' ),
			'addStep'                       => __( 'Add step', 'admin-walkthrough-builder' ),
			'addFloating'                   => __( 'Bubble in the middle', 'admin-walkthrough-builder' ),
			'preview'                       => __( 'Preview', 'admin-walkthrough-builder' ),
			'previewNeedsSteps'             => __( 'Add a step to preview it', 'admin-walkthrough-builder' ),
			'settings'                      => __( 'Settings', 'admin-walkthrough-builder' ),
			'back'                          => __( 'Back', 'admin-walkthrough-builder' ),
			'outlineLabel'                  => __( 'Chapters and steps', 'admin-walkthrough-builder' ),
			'addChapter'                    => __( 'Chapter', 'admin-walkthrough-builder' ),
			'addChapterLabel'               => __( 'Add a chapter', 'admin-walkthrough-builder' ),
			/* translators: %d: chapter number. */
			'newChapterTitle'               => __( 'Chapter %d', 'admin-walkthrough-builder' ),
			'untitledChapter'               => __( 'Untitled chapter', 'admin-walkthrough-builder' ),
			'chapterTitlePlaceholder'       => __( 'Chapter title', 'admin-walkthrough-builder' ),
			'chapterDescriptionPlaceholder' => __( 'What this chapter covers (optional)', 'admin-walkthrough-builder' ),
			/* translators: %s: chapter title. */
			'chapterToggle'                 => __( 'Show or hide the steps in ‘%s’', 'admin-walkthrough-builder' ),
			'currentChapter'                => __( 'New steps go here', 'admin-walkthrough-builder' ),
			'setCurrentChapter'             => __( 'Add new steps to this chapter', 'admin-walkthrough-builder' ),
			'deleteChapter'                 => __( 'Delete chapter', 'admin-walkthrough-builder' ),
			/* translators: %s: chapter title. */
			'deleteChapterConfirm'          => __( 'Delete the chapter ‘%s’? Its steps move to the previous chapter.', 'admin-walkthrough-builder' ),
			'lastChapter'                   => __( 'A walkthrough needs at least one chapter.', 'admin-walkthrough-builder' ),
			'chapterEmpty'                  => __( 'No steps in this chapter yet.', 'admin-walkthrough-builder' ),
			'noSteps'                       => __( 'No steps yet. Press “Add step”, then click anything on the page.', 'admin-walkthrough-builder' ),
			/* translators: %d: step number. */
			'stepNumber'                    => __( 'Step %d', 'admin-walkthrough-builder' ),
			'untitledStep'                  => __( 'Untitled step', 'admin-walkthrough-builder' ),
			'onThisScreen'                  => __( 'On this screen', 'admin-walkthrough-builder' ),
			/* translators: %s: name of the screen the step is on. */
			'otherScreen'                   => __( '↗ %s', 'admin-walkthrough-builder' ),
			'otherScreenUnknown'            => __( '↗ Another screen', 'admin-walkthrough-builder' ),
			'dragStep'                      => __( 'Drag to reorder', 'admin-walkthrough-builder' ),
			/* translators: 1: new position of the step, 2: chapter title. */
			'stepMoved'                     => __( 'Step moved to position %1$d in ‘%2$s’.', 'admin-walkthrough-builder' ),
			/* translators: %d: number of steps (1). */
			'stepsOne'                      => __( '%d step', 'admin-walkthrough-builder' ),
			/* translators: %d: number of steps. */
			'stepsMany'                     => __( '%d steps', 'admin-walkthrough-builder' ),
			'goToScreen'                    => __( 'Go to screen…', 'admin-walkthrough-builder' ),
			'searchScreens'                 => __( 'Search screens…', 'admin-walkthrough-builder' ),
			'noScreensMatch'                => __( 'No screens match your search.', 'admin-walkthrough-builder' ),
			'hint'                          => __( 'Browse normally to add steps on other screens — build mode follows you.', 'admin-walkthrough-builder' ),
			'pickHint'                      => __( 'Click anything on the page… (Esc to cancel)', 'admin-walkthrough-builder' ),
			'pickCancel'                    => __( 'Cancel', 'admin-walkthrough-builder' ),
			'pickOwnUi'                     => __( 'That’s part of the builder. Pick something on the page instead.', 'admin-walkthrough-builder' ),
			'pickIframe'                    => __( 'Items inside the block editor’s canvas can’t be picked. Try the toolbar or sidebar instead.', 'admin-walkthrough-builder' ),
			'bubbleLabel'                   => __( 'Edit step', 'admin-walkthrough-builder' ),
			'stepTitlePlaceholder'          => __( 'Step title', 'admin-walkthrough-builder' ),
			'stepTextPlaceholder'           => __( 'Write what this does…', 'admin-walkthrough-builder' ),
			'formatting'                    => __( 'Formatting', 'admin-walkthrough-builder' ),
			'bold'                          => __( 'Bold', 'admin-walkthrough-builder' ),
			'italic'                        => __( 'Italic', 'admin-walkthrough-builder' ),
			'link'                          => __( 'Link', 'admin-walkthrough-builder' ),
			'linkPrompt'                    => __( 'Link address (URL)', 'admin-walkthrough-builder' ),
			'removeLink'                    => __( 'Remove link', 'admin-walkthrough-builder' ),
			'placementLabel'                => __( 'Where the bubble appears', 'admin-walkthrough-builder' ),
			'placementAuto'                 => __( 'Auto', 'admin-walkthrough-builder' ),
			'placementTop'                  => __( 'Above', 'admin-walkthrough-builder' ),
			'placementRight'                => __( 'Right', 'admin-walkthrough-builder' ),
			'placementBottom'               => __( 'Below', 'admin-walkthrough-builder' ),
			'placementLeft'                 => __( 'Left', 'admin-walkthrough-builder' ),
			'dragBubble'                    => __( 'Drag to move the bubble around the element', 'admin-walkthrough-builder' ),
			'advanceLabel'                  => __( 'Moves on:', 'admin-walkthrough-builder' ),
			'advanceNext'                   => __( 'Next button', 'admin-walkthrough-builder' ),
			'advanceClick'                  => __( 'Click on element', 'admin-walkthrough-builder' ),
			'chapterLabel'                  => __( 'Chapter', 'admin-walkthrough-builder' ),
			'changeElement'                 => __( 'Change element', 'admin-walkthrough-builder' ),
			'delete'                        => __( 'Delete', 'admin-walkthrough-builder' ),
			'stepDeleted'                   => __( 'Step deleted.', 'admin-walkthrough-builder' ),
			'undo'                          => __( 'Undo', 'admin-walkthrough-builder' ),
			'closeBubble'                   => __( 'Close', 'admin-walkthrough-builder' ),
			'floatingBadge'                 => __( 'Floating', 'admin-walkthrough-builder' ),
			'floatingNote'                  => __( 'This bubble shows in the middle of the screen.', 'admin-walkthrough-builder' ),
			'elementMissing'                => __( 'This step’s element isn’t on the screen right now. Use “Change element” to pick a new one.', 'admin-walkthrough-builder' ),
			'learnerNext'                   => __( 'Next', 'admin-walkthrough-builder' ),
			'learnerBack'                   => __( 'Back', 'admin-walkthrough-builder' ),
			'learnerFinish'                 => __( 'Finish', 'admin-walkthrough-builder' ),
			/* translators: 1: current step number, 2: total steps. */
			'count'                         => __( '%1$d / %2$d', 'admin-walkthrough-builder' ),
			'settingsTitle'                 => __( 'Settings', 'admin-walkthrough-builder' ),
			'audienceTitle'                 => __( 'Who sees it', 'admin-walkthrough-builder' ),
			'rolesLabel'                    => __( 'Roles', 'admin-walkthrough-builder' ),
			'peopleLabel'                   => __( 'Specific people', 'admin-walkthrough-builder' ),
			'peopleSearchPlaceholder'       => __( 'Search by name or email…', 'admin-walkthrough-builder' ),
			'searching'                     => __( 'Searching…', 'admin-walkthrough-builder' ),
			'noPeopleFound'                 => __( 'No people found.', 'admin-walkthrough-builder' ),
			/* translators: %s: error message from the server. */
			'peopleSearchFailed'            => __( 'Search failed: %s', 'admin-walkthrough-builder' ),
			/* translators: %s: person's name. */
			'removePerson'                  => __( 'Remove %s', 'admin-walkthrough-builder' ),
			/* translators: %d: user ID. */
			'userFallback'                  => __( 'User #%d', 'admin-walkthrough-builder' ),
			'nobodyWarning'                 => __( 'Nobody will see this walkthrough yet. Pick a role or a person.', 'admin-walkthrough-builder' ),
			'behaviourTitle'                => __( 'Behaviour', 'admin-walkthrough-builder' ),
			'behaviourAutoStart'            => __( 'Start automatically the first time they open the first screen', 'admin-walkthrough-builder' ),
			'behaviourAllowSkip'            => __( 'Let them skip ahead', 'admin-walkthrough-builder' ),
			'behaviourAllowExit'            => __( 'Let them close it', 'admin-walkthrough-builder' ),
			'behaviourAllowReplay'          => __( 'Allow replays', 'admin-walkthrough-builder' ),
			'refreshLabel'                  => __( 'Offer a refresher after', 'admin-walkthrough-builder' ),
			'refreshUnit'                   => __( 'days', 'admin-walkthrough-builder' ),
			'refreshHint'                   => __( '0 = never. Needs replays turned on.', 'admin-walkthrough-builder' ),
			'barPositionLabel'              => __( 'Progress bar position', 'admin-walkthrough-builder' ),
			'barTop'                        => __( 'Top', 'admin-walkthrough-builder' ),
			'barBottom'                     => __( 'Bottom', 'admin-walkthrough-builder' ),
			'saving'                        => __( 'Saving…', 'admin-walkthrough-builder' ),
			'saved'                         => __( 'Saved ✓', 'admin-walkthrough-builder' ),
			/* translators: %s: error message from the server. */
			'saveFailed'                    => __( 'Couldn’t save: %s', 'admin-walkthrough-builder' ),
			'saveOffline'                   => __( 'Couldn’t reach the server, so the last change isn’t saved yet.', 'admin-walkthrough-builder' ),
			'retry'                         => __( 'Retry', 'admin-walkthrough-builder' ),
			/* translators: %d: HTTP status code. */
			'errorStatus'                   => __( 'error %d', 'admin-walkthrough-builder' ),
			'loadError'                     => __( 'Couldn’t load this walkthrough.', 'admin-walkthrough-builder' ),
			'createFailed'                  => __( 'Couldn’t create the walkthrough. Please try again.', 'admin-walkthrough-builder' ),
			'dismiss'                       => __( 'Dismiss', 'admin-walkthrough-builder' ),
		);
	}
}
