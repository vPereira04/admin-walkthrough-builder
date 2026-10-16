<?php
/**
 * Walkthroughs menu: the list screen, the editor shell with its People tab, and the admin-post actions.
 *
 * @package AdminWalkthroughBuilder
 */

defined( 'ABSPATH' ) || exit;

/**
 * The manager-facing screens.
 */
final class AWB_Admin {

	const LIST_SLUG     = 'awb-walkthroughs';
	const EDITOR_SLUG   = 'awb-walkthrough';
	const EDITOR_HANDLE = 'awb-editor';

	// The People tab and the list's progress column stop counting here, so a huge role can't stall the screen.
	const MAX_PEOPLE = 500;

	const MAX_IMPORT_BYTES = 1048576;

	/**
	 * Hook suffix of the list screen.
	 *
	 * @var string
	 */
	private static $list_hook = '';

	/**
	 * Hook suffix of the editor screen.
	 *
	 * @var string
	 */
	private static $editor_hook = '';

	/**
	 * Wires up the hooks.
	 */
	public static function init(): void {
		add_action( 'admin_menu', array( __CLASS__, 'add_menu' ) );
		add_action( 'admin_head', array( __CLASS__, 'hide_editor_menu_item' ) );
		add_filter( 'parent_file', array( __CLASS__, 'highlight_parent' ) );
		add_filter( 'submenu_file', array( __CLASS__, 'highlight_submenu' ) );
		add_filter( 'removable_query_args', array( __CLASS__, 'removable_query_args' ) );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue_editor' ) );
		add_action( 'admin_notices', array( __CLASS__, 'render_notice' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( AWB_FILE ), array( __CLASS__, 'add_plugin_link' ) );

		add_action( 'admin_post_awb_create', array( __CLASS__, 'handle_create' ) );
		add_action( 'admin_post_awb_duplicate', array( __CLASS__, 'handle_duplicate' ) );
		add_action( 'admin_post_awb_delete', array( __CLASS__, 'handle_delete' ) );
		add_action( 'admin_post_awb_export', array( __CLASS__, 'handle_export' ) );
		add_action( 'admin_post_awb_import', array( __CLASS__, 'handle_import' ) );
	}

	/**
	 * Adds the top-level menu, plus the editor page that's hidden from it later.
	 */
	public static function add_menu(): void {
		$capability = AWB_Tours::capability();

		self::$list_hook = (string) add_menu_page(
			__( 'Walkthroughs', 'admin-walkthrough-builder' ),
			__( 'Walkthroughs', 'admin-walkthrough-builder' ),
			$capability,
			self::LIST_SLUG,
			array( __CLASS__, 'render_list' ),
			'dashicons-welcome-learn-more'
		);

		add_submenu_page(
			self::LIST_SLUG,
			__( 'Walkthroughs', 'admin-walkthrough-builder' ),
			__( 'All walkthroughs', 'admin-walkthrough-builder' ),
			$capability,
			self::LIST_SLUG,
			array( __CLASS__, 'render_list' )
		);

		self::$editor_hook = (string) add_submenu_page(
			self::LIST_SLUG,
			__( 'Edit walkthrough', 'admin-walkthrough-builder' ),
			__( 'Edit walkthrough', 'admin-walkthrough-builder' ),
			$capability,
			self::EDITOR_SLUG,
			array( __CLASS__, 'render_editor' )
		);
	}

	/**
	 * Drops the editor from the submenu. I wait until admin_head because the page
	 * title is worked out from the submenu before that, and it'd come out blank.
	 */
	public static function hide_editor_menu_item(): void {
		remove_submenu_page( self::LIST_SLUG, self::EDITOR_SLUG );
	}

	/**
	 * Keeps "Walkthroughs" open while editing one.
	 *
	 * @param string|null $parent_file Parent menu slug.
	 * @return string|null
	 */
	public static function highlight_parent( $parent_file ) {
		return self::is_screen( self::$editor_hook ) ? self::LIST_SLUG : $parent_file;
	}

	/**
	 * Highlights "All walkthroughs" while editing one.
	 *
	 * @param string|null $submenu_file Submenu slug.
	 * @return string|null
	 */
	public static function highlight_submenu( $submenu_file ) {
		return self::is_screen( self::$editor_hook ) ? self::LIST_SLUG : $submenu_file;
	}

	/**
	 * Lets WP strip the notice flag from the address bar, so a reload doesn't repeat it.
	 *
	 * @param array<int, string> $args Removable query args.
	 * @return array<int, string>
	 */
	public static function removable_query_args( array $args ): array {
		$args[] = 'awb_notice';
		return $args;
	}

	/**
	 * Adds a "Walkthroughs" link on the Plugins screen.
	 *
	 * @param array<string, string> $links Plugin action links.
	 * @return array<string, string>
	 */
	public static function add_plugin_link( array $links ): array {
		$link = sprintf(
			'<a href="%1$s">%2$s</a>',
			esc_url( self::list_url() ),
			esc_html__( 'Walkthroughs', 'admin-walkthrough-builder' )
		);

		return array( 'walkthroughs' => $link ) + $links;
	}

	/**
	 * URL of the list screen, with optional extra query args.
	 *
	 * @param array<string, string|int> $args Extra query args.
	 */
	public static function list_url( array $args = array() ): string {
		return add_query_arg( $args, admin_url( 'admin.php?page=' . self::LIST_SLUG ) );
	}

	/**
	 * URL of the editor for a tour.
	 *
	 * @param int                       $id   Tour ID.
	 * @param array<string, string|int> $args Extra query args.
	 */
	public static function editor_url( int $id, array $args = array() ): string {
		return add_query_arg( array( 'tour' => $id ) + $args, admin_url( 'admin.php?page=' . self::EDITOR_SLUG ) );
	}

	/**
	 * Build mode for a tour: its first step's screen, or the Dashboard while it has none.
	 *
	 * @param WP_Post                   $post  The tour.
	 * @param array<string, string|int> $extra Extra query args, e.g. awb_new.
	 */
	public static function build_url( WP_Post $post, array $extra = array() ): string {
		$definition = AWB_Tours::definition( $post );
		$args       = array(
			'awb_build'   => (int) $post->ID,
			'awb_chapter' => $definition['chapters'][0]['id'],
		) + $extra;

		if ( $definition['steps'] ) {
			return AWB_Tours::step_link( $definition['steps'][0], $args );
		}

		return add_query_arg( $args, admin_url( 'index.php' ) );
	}

	/**
	 * Nonced admin-post URL for an action on a tour.
	 *
	 * @param string $action admin-post action, also the nonce action.
	 * @param int    $id     Tour ID, or 0.
	 */
	private static function action_url( string $action, int $id = 0 ): string {
		$args = array( 'action' => $action );

		if ( $id ) {
			$args['tour'] = $id;
		}

		return wp_nonce_url( add_query_arg( $args, admin_url( 'admin-post.php' ) ), $action );
	}

	/**
	 * Whether the current screen is the given hook suffix.
	 *
	 * @param string $hook Hook suffix.
	 */
	private static function is_screen( string $hook ): bool {
		$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		return '' !== $hook && $screen && $hook === $screen->id;
	}

	/**
	 * A display-only query arg (tour, tab, notice). Nothing is saved based on it.
	 *
	 * @param string $key Query arg name.
	 */
	public static function query_var( string $key ): string {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- Read-only screen state; nothing changes because of it.
		return isset( $_GET[ $key ] ) ? sanitize_key( wp_unslash( $_GET[ $key ] ) ) : '';
	}

	/**
	 * Stops anyone without the capability. Called first in every admin-post handler.
	 */
	private static function require_capability(): void {
		if ( ! AWB_Tours::can_manage() ) {
			wp_die(
				esc_html__( 'Sorry, you are not allowed to manage walkthroughs.', 'admin-walkthrough-builder' ),
				'',
				array(
					'response'  => 403,
					'back_link' => true,
				)
			);
		}
	}

	/**
	 * The tour an admin-post action points at, or a friendly stop.
	 *
	 * @param int $id Tour ID from the request.
	 */
	private static function tour_or_die( int $id ): WP_Post {
		$post = AWB_Tours::get( $id );

		if ( ! $post ) {
			wp_die(
				esc_html__( 'That walkthrough doesn’t exist any more.', 'admin-walkthrough-builder' ),
				'',
				array(
					'response'  => 404,
					'back_link' => true,
				)
			);
		}

		return $post;
	}

	/**
	 * Adds a new draft and opens it in build mode.
	 */
	public static function handle_create(): void {
		self::require_capability();
		check_admin_referer( 'awb_create' );

		$post = AWB_Tours::get( AWB_Tours::create() );

		if ( ! $post ) {
			wp_safe_redirect( self::list_url( array( 'awb_notice' => 'failed' ) ) );
			exit;
		}

		// A brand-new tour has no steps, so this lands on the Dashboard with the builder open.
		wp_safe_redirect( self::build_url( $post, array( 'awb_new' => 1 ) ) );
		exit;
	}

	/**
	 * Copies a tour into a new draft.
	 */
	public static function handle_duplicate(): void {
		self::require_capability();
		check_admin_referer( 'awb_duplicate' );

		$post = self::tour_or_die( isset( $_GET['tour'] ) ? absint( wp_unslash( $_GET['tour'] ) ) : 0 );
		$data = AWB_Tours::edit_shape( $post );

		/* translators: %s: walkthrough title. */
		$data['title']  = sprintf( __( '%s (copy)', 'admin-walkthrough-builder' ), $post->post_title );
		$data['status'] = 'draft';

		$id = AWB_Tours::create( $data );

		wp_safe_redirect( self::list_url( array( 'awb_notice' => $id ? 'duplicated' : 'failed' ) ) );
		exit;
	}

	/**
	 * Deletes a tour for good, along with everyone's progress in it.
	 */
	public static function handle_delete(): void {
		self::require_capability();
		check_admin_referer( 'awb_delete' );

		$post = self::tour_or_die( isset( $_POST['tour'] ) ? absint( wp_unslash( $_POST['tour'] ) ) : 0 );

		AWB_Progress::forget( (int) $post->ID );
		wp_delete_post( (int) $post->ID, true );

		wp_safe_redirect( self::list_url( array( 'awb_notice' => 'deleted' ) ) );
		exit;
	}

	/**
	 * Downloads the tour as walkthrough-<slug>.json.
	 */
	public static function handle_export(): void {
		self::require_capability();
		check_admin_referer( 'awb_export' );

		$post = self::tour_or_die( isset( $_GET['tour'] ) ? absint( wp_unslash( $_GET['tour'] ) ) : 0 );
		$slug = sanitize_title( $post->post_title );

		// Non-Latin titles come back percent-encoded, which makes a messy file name.
		if ( '' === $slug || preg_match( '/[^a-z0-9\-]/', $slug ) ) {
			$slug = (string) $post->ID;
		}

		nocache_headers();
		header( 'Content-Type: application/json; charset=utf-8' );
		header( 'Content-Disposition: attachment; filename="walkthrough-' . $slug . '.json"' );

		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- A JSON file download, not HTML.
		echo wp_json_encode( AWB_Tours::export_shape( $post ), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		exit;
	}

	/**
	 * Turns an exported .json file into a new draft.
	 */
	public static function handle_import(): void {
		self::require_capability();
		check_admin_referer( 'awb_import' );

		$tmp   = isset( $_FILES['awb_file']['tmp_name'] ) && is_string( $_FILES['awb_file']['tmp_name'] ) ? $_FILES['awb_file']['tmp_name'] : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- A server temp path, checked with is_uploaded_file() below.
		$error = isset( $_FILES['awb_file']['error'] ) ? (int) $_FILES['awb_file']['error'] : UPLOAD_ERR_NO_FILE;

		$file = null;

		if ( UPLOAD_ERR_OK === $error && '' !== $tmp && is_uploaded_file( $tmp ) && filesize( $tmp ) <= self::MAX_IMPORT_BYTES ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- Reading the local upload, not a remote URL.
			$file = json_decode( (string) file_get_contents( $tmp ), true );
		}

		if ( ! is_array( $file ) || ( ! isset( $file['steps'] ) && ! isset( $file['chapters'] ) ) ) {
			wp_safe_redirect( self::list_url( array( 'awb_notice' => 'import_failed' ) ) );
			exit;
		}

		$settings = isset( $file['settings'] ) && is_array( $file['settings'] ) ? $file['settings'] : array();

		// User IDs mean someone else on another site, so they never carry over.
		$settings['users'] = array();

		$id = AWB_Tours::create(
			array(
				'title'       => isset( $file['title'] ) ? $file['title'] : '',
				'description' => isset( $file['description'] ) ? $file['description'] : '',
				'status'      => 'draft',
				'chapters'    => isset( $file['chapters'] ) && is_array( $file['chapters'] ) ? $file['chapters'] : array(),
				'steps'       => isset( $file['steps'] ) && is_array( $file['steps'] ) ? $file['steps'] : array(),
				'settings'    => $settings,
			)
		);

		wp_safe_redirect( $id ? self::editor_url( $id, array( 'awb_notice' => 'imported' ) ) : self::list_url( array( 'awb_notice' => 'import_failed' ) ) );
		exit;
	}

	/**
	 * Result notices after an admin-post redirect.
	 */
	public static function render_notice(): void {
		if ( ! self::is_screen( self::$list_hook ) && ! self::is_screen( self::$editor_hook ) ) {
			return;
		}

		$messages = array(
			'duplicated'    => array( 'success', __( 'Walkthrough duplicated. The copy is a draft.', 'admin-walkthrough-builder' ) ),
			'deleted'       => array( 'success', __( 'Walkthrough deleted.', 'admin-walkthrough-builder' ) ),
			'imported'      => array( 'success', __( 'Walkthrough imported as a draft. Pick who sees it before setting it live.', 'admin-walkthrough-builder' ) ),
			'import_failed' => array( 'error', __( 'That file couldn’t be imported. Choose a .json file exported from Walkthroughs (1 MB max).', 'admin-walkthrough-builder' ) ),
			'failed'        => array( 'error', __( 'Something went wrong. Please try again.', 'admin-walkthrough-builder' ) ),
		);

		$code = self::query_var( 'awb_notice' );

		if ( ! isset( $messages[ $code ] ) ) {
			return;
		}

		printf(
			'<div class="notice notice-%1$s is-dismissible"><p>%2$s</p></div>',
			esc_attr( $messages[ $code ][0] ),
			esc_html( $messages[ $code ][1] )
		);
	}

	/**
	 * The list screen.
	 */
	public static function render_list(): void {
		if ( ! AWB_Tours::can_manage() ) {
			return;
		}

		$tours = AWB_Tours::query( AWB_Tours::STATUSES, 'DESC' );
		?>
		<div class="wrap awb-wrap awb-list">
			<h1 class="wp-heading-inline"><?php esc_html_e( 'Walkthroughs', 'admin-walkthrough-builder' ); ?></h1>
			<a href="<?php echo esc_url( self::action_url( 'awb_create' ) ); ?>" class="page-title-action"><?php esc_html_e( 'Create walkthrough', 'admin-walkthrough-builder' ); ?></a>
			<hr class="wp-header-end">

			<?php
			self::render_delete_confirm();

			if ( $tours ) {
				self::render_table( $tours );
			} else {
				self::render_empty_state();
			}

			self::render_import_box();
			?>
		</div>
		<?php
	}

	/**
	 * "Delete permanently?" box. Deleting is a POST from here, so a stray click on the row link can't lose a tour.
	 */
	private static function render_delete_confirm(): void {
		$post = AWB_Tours::get( absint( self::query_var( 'awb_confirm_delete' ) ) );

		if ( ! $post ) {
			return;
		}
		?>
		<div class="notice notice-warning awb-confirm">
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<p>
					<?php
					echo esc_html(
						sprintf(
							/* translators: %s: walkthrough title. */
							__( 'Delete ‘%s’ permanently? Everyone’s progress in it is deleted too. This can’t be undone.', 'admin-walkthrough-builder' ),
							$post->post_title
						)
					);
					?>
				</p>
				<p>
					<input type="hidden" name="action" value="awb_delete">
					<input type="hidden" name="tour" value="<?php echo esc_attr( (string) $post->ID ); ?>">
					<?php wp_nonce_field( 'awb_delete' ); ?>
					<button type="submit" class="button button-primary awb-confirm__delete"><?php esc_html_e( 'Delete permanently', 'admin-walkthrough-builder' ); ?></button>
					<a class="button" href="<?php echo esc_url( self::list_url() ); ?>"><?php esc_html_e( 'Cancel', 'admin-walkthrough-builder' ); ?></a>
				</p>
			</form>
		</div>
		<?php
	}

	/**
	 * First-run screen with the three-step "How it works".
	 */
	private static function render_empty_state(): void {
		?>
		<div class="awb-empty">
			<h2 class="awb-empty__title"><?php esc_html_e( 'Show your clients around wp-admin', 'admin-walkthrough-builder' ); ?></h2>
			<p class="awb-empty__text"><?php esc_html_e( 'Build a guided tour once and the people you pick get it step by step, right on the screens they use.', 'admin-walkthrough-builder' ); ?></p>
			<h3 class="awb-empty__subtitle"><?php esc_html_e( 'How it works', 'admin-walkthrough-builder' ); ?></h3>
			<ol class="awb-empty__steps">
				<li><strong><?php esc_html_e( 'Create', 'admin-walkthrough-builder' ); ?></strong> <?php esc_html_e( 'a walkthrough and split it into chapters.', 'admin-walkthrough-builder' ); ?></li>
				<li><strong><?php esc_html_e( 'Click elements', 'admin-walkthrough-builder' ); ?></strong> <?php esc_html_e( 'on any screen to add a step about each one.', 'admin-walkthrough-builder' ); ?></li>
				<li><strong><?php esc_html_e( 'Pick who sees it', 'admin-walkthrough-builder' ); ?></strong> <?php esc_html_e( 'by role or by person, and set it live.', 'admin-walkthrough-builder' ); ?></li>
			</ol>
			<p><a class="button button-primary" href="<?php echo esc_url( self::action_url( 'awb_create' ) ); ?>"><?php esc_html_e( 'Create your first walkthrough', 'admin-walkthrough-builder' ); ?></a></p>
		</div>
		<?php
	}

	/**
	 * The tours table.
	 *
	 * @param array<int, WP_Post> $tours Tours, newest first.
	 */
	private static function render_table( array $tours ): void {
		$role_names = wp_roles()->get_names();
		?>
		<table class="widefat striped awb-table">
			<thead>
				<tr>
					<th scope="col" class="awb-table__title"><?php esc_html_e( 'Title', 'admin-walkthrough-builder' ); ?></th>
					<th scope="col"><?php esc_html_e( 'Status', 'admin-walkthrough-builder' ); ?></th>
					<th scope="col"><?php esc_html_e( 'Steps', 'admin-walkthrough-builder' ); ?></th>
					<th scope="col"><?php esc_html_e( 'Who sees it', 'admin-walkthrough-builder' ); ?></th>
					<th scope="col"><?php esc_html_e( 'Progress', 'admin-walkthrough-builder' ); ?></th>
					<th scope="col"><?php esc_html_e( 'Updated', 'admin-walkthrough-builder' ); ?></th>
				</tr>
			</thead>
			<tbody>
				<?php
				foreach ( $tours as $post ) :
					$id         = (int) $post->ID;
					$definition = AWB_Tours::definition( $post );
					$settings   = $definition['settings'];
					$live       = 'publish' === $post->post_status;
					$audience   = AWB_Tours::audience_ids( $settings, self::MAX_PEOPLE );
					$finished   = 0;

					update_meta_cache( 'user', $audience );

					foreach ( $audience as $user_id ) {
						$entry = AWB_Progress::get( $user_id, $id );

						if ( $entry && 'completed' === $entry['status'] ) {
							++$finished;
						}
					}

					$who = array();

					foreach ( $settings['roles'] as $role ) {
						$who[] = translate_user_role( $role_names[ $role ] );
					}

					if ( $settings['users'] ) {
						$count = count( $settings['users'] );
						/* translators: %s: number of people. */
						$who[] = sprintf( _n( '%s person', '%s people', $count, 'admin-walkthrough-builder' ), number_format_i18n( $count ) );
					}

					$step_count    = count( $definition['steps'] );
					$chapter_count = count( $definition['chapters'] );
					?>
					<tr>
						<td class="awb-table__title">
							<strong><a class="row-title" href="<?php echo esc_url( self::editor_url( $id ) ); ?>"><?php echo esc_html( $post->post_title ); ?></a></strong>
							<?php if ( '' !== $post->post_excerpt ) : ?>
								<p class="awb-table__desc"><?php echo esc_html( $post->post_excerpt ); ?></p>
							<?php endif; ?>
							<div class="row-actions">
								<span class="build"><a href="<?php echo esc_url( self::build_url( $post ) ); ?>"><strong><?php esc_html_e( 'Build', 'admin-walkthrough-builder' ); ?></strong></a> | </span>
								<span class="edit"><a href="<?php echo esc_url( self::editor_url( $id ) ); ?>"><?php esc_html_e( 'Edit', 'admin-walkthrough-builder' ); ?></a> | </span>
								<span class="view">
									<?php if ( $definition['steps'] ) : ?>
										<a href="<?php echo esc_url( AWB_Tours::step_link( $definition['steps'][0], array( 'awb_preview' => $id ) ) ); ?>" target="_blank" rel="noopener"><?php esc_html_e( 'Preview', 'admin-walkthrough-builder' ); ?></a> |
									<?php else : ?>
										<span class="awb-table__disabled" title="<?php esc_attr_e( 'Add a step first', 'admin-walkthrough-builder' ); ?>"><?php esc_html_e( 'Preview', 'admin-walkthrough-builder' ); ?></span> |
									<?php endif; ?>
								</span>
								<span class="duplicate"><a href="<?php echo esc_url( self::action_url( 'awb_duplicate', $id ) ); ?>"><?php esc_html_e( 'Duplicate', 'admin-walkthrough-builder' ); ?></a> | </span>
								<span class="export"><a href="<?php echo esc_url( self::action_url( 'awb_export', $id ) ); ?>"><?php esc_html_e( 'Export', 'admin-walkthrough-builder' ); ?></a> | </span>
								<span class="trash"><a href="<?php echo esc_url( self::list_url( array( 'awb_confirm_delete' => $id ) ) ); ?>"><?php esc_html_e( 'Delete', 'admin-walkthrough-builder' ); ?></a></span>
							</div>
						</td>
						<td>
							<span class="awb-status awb-status--<?php echo esc_attr( $live ? 'live' : 'draft' ); ?>">
								<?php echo $live ? esc_html__( 'Live', 'admin-walkthrough-builder' ) : esc_html__( 'Draft', 'admin-walkthrough-builder' ); ?>
							</span>
						</td>
						<td>
							<?php
							echo esc_html(
								sprintf(
									/* translators: 1: step count text, 2: chapter count text. */
									__( '%1$s · %2$s', 'admin-walkthrough-builder' ),
									/* translators: %s: number of steps. */
									sprintf( _n( '%s step', '%s steps', $step_count, 'admin-walkthrough-builder' ), number_format_i18n( $step_count ) ),
									/* translators: %s: number of chapters. */
									sprintf( _n( '%s chapter', '%s chapters', $chapter_count, 'admin-walkthrough-builder' ), number_format_i18n( $chapter_count ) )
								)
							);
							?>
						</td>
						<td>
							<?php if ( $who ) : ?>
								<?php echo esc_html( implode( ', ', $who ) ); ?>
							<?php else : ?>
								<span class="awb-table__muted"><?php esc_html_e( 'Nobody yet', 'admin-walkthrough-builder' ); ?></span>
							<?php endif; ?>
						</td>
						<td>
							<?php
							echo esc_html(
								sprintf(
									/* translators: 1: people who finished, 2: people who see the walkthrough. */
									__( '%1$s of %2$s finished', 'admin-walkthrough-builder' ),
									number_format_i18n( $finished ),
									number_format_i18n( count( $audience ) )
								)
							);
							?>
						</td>
						<td>
							<?php
							echo esc_html(
								sprintf(
									/* translators: %s: time since, e.g. "3 hours". */
									__( '%s ago', 'admin-walkthrough-builder' ),
									human_time_diff( (int) get_post_modified_time( 'U', true, $post ) )
								)
							);
							?>
						</td>
					</tr>
				<?php endforeach; ?>
			</tbody>
		</table>
		<?php
	}

	/**
	 * Upload form for an exported .json file.
	 */
	private static function render_import_box(): void {
		?>
		<div class="awb-import">
			<h2 class="awb-import__title"><?php esc_html_e( 'Import a walkthrough', 'admin-walkthrough-builder' ); ?></h2>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" enctype="multipart/form-data">
				<input type="hidden" name="action" value="awb_import">
				<?php wp_nonce_field( 'awb_import' ); ?>
				<label for="awb-import-file"><?php esc_html_e( 'Walkthrough file (.json)', 'admin-walkthrough-builder' ); ?></label>
				<input type="file" id="awb-import-file" name="awb_file" accept=".json,application/json" required>
				<?php submit_button( __( 'Import', 'admin-walkthrough-builder' ), 'secondary', 'submit', false ); ?>
				<p class="description"><?php esc_html_e( 'It comes in as a draft. Specific people aren’t carried over from the other site.', 'admin-walkthrough-builder' ); ?></p>
			</form>
		</div>
		<?php
	}

	/**
	 * The editor shell. editor.js fills the Steps tab; the People tab is all server-side.
	 */
	public static function render_editor(): void {
		if ( ! AWB_Tours::can_manage() ) {
			return;
		}

		$post = AWB_Tours::get( absint( self::query_var( 'tour' ) ) );

		if ( ! $post ) {
			?>
			<div class="wrap awb-wrap">
				<h1><?php esc_html_e( 'Walkthrough not found', 'admin-walkthrough-builder' ); ?></h1>
				<p><a href="<?php echo esc_url( self::list_url() ); ?>"><?php esc_html_e( '← All walkthroughs', 'admin-walkthrough-builder' ); ?></a></p>
			</div>
			<?php
			return;
		}

		$tab  = 'people' === self::query_var( 'tab' ) ? 'people' : 'steps';
		$tabs = array(
			'steps'  => __( 'Steps', 'admin-walkthrough-builder' ),
			'people' => __( 'People', 'admin-walkthrough-builder' ),
		);
		?>
		<div class="wrap awb-wrap">
			<p class="awb-back"><a href="<?php echo esc_url( self::list_url() ); ?>"><?php esc_html_e( '← All walkthroughs', 'admin-walkthrough-builder' ); ?></a></p>
			<h1 class="awb-wrap__title"><?php echo esc_html( $post->post_title ); ?></h1>
			<p class="awb-wrap__builder">
				<a class="button button-primary button-hero awb-open-builder" href="<?php echo esc_url( self::build_url( $post ) ); ?>"><?php esc_html_e( 'Open the builder', 'admin-walkthrough-builder' ); ?></a>
				<span class="description"><?php esc_html_e( 'Add and edit steps right on your wp-admin screens.', 'admin-walkthrough-builder' ); ?></span>
			</p>
			<hr class="wp-header-end">

			<nav class="nav-tab-wrapper awb-tabs" aria-label="<?php esc_attr_e( 'Walkthrough sections', 'admin-walkthrough-builder' ); ?>">
				<?php foreach ( $tabs as $key => $label ) : ?>
					<a
						href="<?php echo esc_url( self::editor_url( (int) $post->ID, 'people' === $key ? array( 'tab' => 'people' ) : array() ) ); ?>"
						class="nav-tab<?php echo $tab === $key ? ' nav-tab-active' : ''; ?>"
						<?php echo $tab === $key ? 'aria-current="page"' : ''; ?>
					><?php echo esc_html( $label ); ?></a>
				<?php endforeach; ?>
			</nav>

			<?php if ( 'people' === $tab ) : ?>
				<?php self::render_people( $post ); ?>
			<?php else : ?>
				<div id="awb-editor" class="awb-editor">
					<p class="awb-editor__loading"><?php esc_html_e( 'Loading the editor…', 'admin-walkthrough-builder' ); ?></p>
					<noscript><p><?php esc_html_e( 'The walkthrough editor needs JavaScript turned on.', 'admin-walkthrough-builder' ); ?></p></noscript>
				</div>
			<?php endif; ?>
		</div>
		<?php
	}

	/**
	 * People tab: everyone the tour is for, and how far they got.
	 *
	 * @param WP_Post $post The tour.
	 */
	private static function render_people( WP_Post $post ): void {
		$definition = AWB_Tours::definition( $post );
		$steps      = $definition['steps'];
		$ids        = AWB_Tours::audience_ids( $definition['settings'], self::MAX_PEOPLE + 1 );
		$capped     = count( $ids ) > self::MAX_PEOPLE;
		$ids        = array_slice( $ids, 0, self::MAX_PEOPLE );
		$role_names = wp_roles()->get_names();

		$people = $ids ? get_users(
			array(
				// blog_id 0 so people picked by name show up even if they aren't members of this site.
				'blog_id' => 0,
				'include' => $ids,
				'orderby' => 'display_name',
			)
		) : array();

		$rows   = array();
		$totals = array(
			'finished'    => 0,
			'in_progress' => 0,
			'not_started' => 0,
		);

		foreach ( $people as $person ) {
			$entry = AWB_Progress::get( (int) $person->ID, (int) $post->ID );
			$pill  = self::status_pill( $entry, $steps );

			if ( ! $entry ) {
				++$totals['not_started'];
			} elseif ( 'completed' === $entry['status'] ) {
				++$totals['finished'];
			} else {
				++$totals['in_progress'];
			}

			$rows[] = array(
				'user'  => $person,
				'entry' => $entry,
				'pill'  => $pill,
			);
		}
		?>
		<div class="awb-people">
			<?php if ( 'publish' !== $post->post_status ) : ?>
				<div class="notice notice-info inline"><p><?php esc_html_e( 'This walkthrough is a draft, so nobody gets it yet.', 'admin-walkthrough-builder' ); ?></p></div>
			<?php endif; ?>

			<?php if ( ! $rows ) : ?>
				<p class="awb-people__empty"><?php esc_html_e( 'Nobody is picked yet. Choose roles or specific people under “Who sees it” on the Steps tab.', 'admin-walkthrough-builder' ); ?></p>
			<?php else : ?>
				<ul class="awb-people__summary">
					<li class="awb-people__total awb-people__total--finished">
						<?php
						/* translators: %s: number of people. */
						echo esc_html( sprintf( __( 'Finished: %s', 'admin-walkthrough-builder' ), number_format_i18n( $totals['finished'] ) ) );
						?>
					</li>
					<li class="awb-people__total awb-people__total--in-progress">
						<?php
						/* translators: %s: number of people. */
						echo esc_html( sprintf( __( 'In progress: %s', 'admin-walkthrough-builder' ), number_format_i18n( $totals['in_progress'] ) ) );
						?>
					</li>
					<li class="awb-people__total awb-people__total--not-started">
						<?php
						/* translators: %s: number of people. */
						echo esc_html( sprintf( __( 'Not started: %s', 'admin-walkthrough-builder' ), number_format_i18n( $totals['not_started'] ) ) );
						?>
					</li>
				</ul>

				<p class="awb-people__actions">
					<button type="button" class="button" data-awb-reset="0"><?php esc_html_e( 'Reset everyone', 'admin-walkthrough-builder' ); ?></button>
				</p>

				<table class="widefat striped awb-people__table">
					<thead>
						<tr>
							<th scope="col"><?php esc_html_e( 'Person', 'admin-walkthrough-builder' ); ?></th>
							<th scope="col"><?php esc_html_e( 'Role', 'admin-walkthrough-builder' ); ?></th>
							<th scope="col"><?php esc_html_e( 'Status', 'admin-walkthrough-builder' ); ?></th>
							<th scope="col"><span class="screen-reader-text"><?php esc_html_e( 'Actions', 'admin-walkthrough-builder' ); ?></span></th>
						</tr>
					</thead>
					<tbody>
						<?php
						foreach ( $rows as $row ) :
							$person = $row['user'];
							$roles  = array();

							foreach ( (array) $person->roles as $role ) {
								if ( isset( $role_names[ $role ] ) ) {
									$roles[] = translate_user_role( $role_names[ $role ] );
								}
							}
							?>
							<tr>
								<td class="awb-people__person">
									<img class="awb-people__avatar" src="<?php echo esc_url( (string) get_avatar_url( $person->ID, array( 'size' => 64 ) ) ); ?>" width="32" height="32" alt="">
									<strong class="awb-people__name"><?php echo esc_html( $person->display_name ); ?></strong>
									<span class="awb-people__email"><?php echo esc_html( $person->user_email ); ?></span>
								</td>
								<td><?php echo esc_html( $roles ? implode( ', ', $roles ) : '—' ); ?></td>
								<td><span class="awb-status awb-status--<?php echo esc_attr( $row['pill']['class'] ); ?>"><?php echo esc_html( $row['pill']['label'] ); ?></span></td>
								<td class="awb-people__reset">
									<button type="button" class="button button-small" data-awb-reset="<?php echo esc_attr( (string) $person->ID ); ?>" <?php disabled( null === $row['entry'] ); ?>><?php esc_html_e( 'Reset', 'admin-walkthrough-builder' ); ?></button>
								</td>
							</tr>
						<?php endforeach; ?>
					</tbody>
				</table>

				<?php if ( $capped ) : ?>
					<p class="description">
						<?php
						/* translators: %s: maximum number of people listed. */
						echo esc_html( sprintf( __( 'Showing the first %s people.', 'admin-walkthrough-builder' ), number_format_i18n( self::MAX_PEOPLE ) ) );
						?>
					</p>
				<?php endif; ?>
			<?php endif; ?>
		</div>
		<?php
	}

	/**
	 * Status pill for one person: Not started / In progress (step X of N) / Finished (date) / Closed / Reminder on (date).
	 *
	 * @param array<string, mixed>|null         $entry Their progress, or null.
	 * @param array<int, array<string, string>> $steps The tour's steps.
	 * @return array{class: string, label: string}
	 */
	private static function status_pill( ?array $entry, array $steps ): array {
		$date_format = (string) get_option( 'date_format' );

		if ( ! $entry ) {
			return array(
				'class' => 'not-started',
				'label' => __( 'Not started', 'admin-walkthrough-builder' ),
			);
		}

		if ( 'completed' === $entry['status'] ) {
			if ( $entry['remind_at'] > time() && ! $entry['no_remind'] ) {
				return array(
					'class' => 'reminder',
					/* translators: %s: date of the reminder. */
					'label' => sprintf( __( 'Reminder on %s', 'admin-walkthrough-builder' ), wp_date( $date_format, (int) $entry['remind_at'] ) ),
				);
			}

			return array(
				'class' => 'finished',
				/* translators: %s: date they finished. */
				'label' => sprintf( __( 'Finished %s', 'admin-walkthrough-builder' ), wp_date( $date_format, (int) $entry['completed'] ) ),
			);
		}

		if ( 'dismissed' === $entry['status'] ) {
			return array(
				'class' => 'closed',
				'label' => __( 'Closed', 'admin-walkthrough-builder' ),
			);
		}

		$index = AWB_Tours::step_index( $steps, (string) $entry['step'] );

		return array(
			'class' => 'in-progress',
			'label' => $index >= 0
				/* translators: 1: current step number, 2: total steps. */
				? sprintf( __( 'In progress (step %1$d of %2$d)', 'admin-walkthrough-builder' ), $index + 1, count( $steps ) )
				: __( 'In progress', 'admin-walkthrough-builder' ),
		);
	}

	/**
	 * Enqueues editor.js with the tour, roles, picked people and reachable screens.
	 *
	 * @param string $hook_suffix Current admin page.
	 */
	public static function enqueue_editor( string $hook_suffix ): void {
		if ( '' === self::$editor_hook || self::$editor_hook !== $hook_suffix || ! AWB_Tours::can_manage() ) {
			return;
		}

		$post = AWB_Tours::get( absint( self::query_var( 'tour' ) ) );

		if ( ! $post ) {
			return;
		}

		$tour  = AWB_Tours::edit_shape( $post );
		$roles = array();
		$users = array();

		foreach ( wp_roles()->get_names() as $slug => $label ) {
			$roles[] = array(
				'slug'  => $slug,
				'label' => translate_user_role( $label ),
			);
		}

		foreach ( $tour['settings']['users'] as $user_id ) {
			$user = get_userdata( (int) $user_id );

			if ( $user ) {
				$users[ (string) $user->ID ] = array(
					'name'   => $user->display_name,
					'avatar' => (string) get_avatar_url( $user->ID, array( 'size' => 48 ) ),
				);
			}
		}

		AWB_Player::enqueue_pair( self::EDITOR_HANDLE, 'editor', array( 'jquery-ui-sortable' ) );

		wp_localize_script(
			self::EDITOR_HANDLE,
			'awbEditor',
			array(
				'root'     => esc_url_raw( rest_url( AWB_Rest::ROUTE_NAMESPACE . '/' ) ),
				'nonce'    => wp_create_nonce( 'wp_rest' ),
				'adminUrl' => esc_url_raw( admin_url() ),
				'tour'     => $tour,
				'roles'    => $roles,
				// An object even when empty, so the JS can always look people up by ID.
				'users'    => (object) $users,
				'screens'  => self::admin_screens(),
				'listUrl'  => esc_url_raw( self::list_url() ),
				'i18n'     => self::editor_strings(),
			)
		);
	}

	/**
	 * The admin menu flattened to {group, label, url}, only what this person can open.
	 * Shared by awbEditor and awbBuilder; needs the menu built, so call it from admin_enqueue_scripts or later.
	 *
	 * @return array<int, array{group: string, label: string, url: string}>
	 */
	public static function admin_screens(): array {
		global $menu, $submenu;

		$screens = array();

		foreach ( (array) $menu as $item ) {
			if ( empty( $item[0] ) || empty( $item[2] ) ) {
				continue;
			}

			$group = self::menu_label( (string) $item[0] );
			$slug  = (string) $item[2];

			if ( '' === $group ) {
				continue;
			}

			$children = isset( $submenu[ $slug ] ) ? (array) $submenu[ $slug ] : array();

			if ( ! $children ) {
				if ( current_user_can( (string) $item[1] ) ) {
					self::add_screen( $screens, $group, $group, self::menu_url( $slug, '' ) );
				}
				continue;
			}

			foreach ( $children as $child ) {
				if ( empty( $child[0] ) || empty( $child[2] ) || self::EDITOR_SLUG === $child[2] || ! current_user_can( (string) $child[1] ) ) {
					continue;
				}

				$label = self::menu_label( (string) $child[0] );

				if ( '' !== $label ) {
					self::add_screen( $screens, $group, $label, self::menu_url( (string) $child[2], $slug ) );
				}
			}
		}

		return array_values( $screens );
	}

	/**
	 * Adds one menu link to the screens list, keyed by URL so repeats collapse.
	 *
	 * @param array<string, array{group: string, label: string, url: string}> $screens Screens so far.
	 * @param string                                                          $group   Top-level menu label.
	 * @param string                                                          $label   Item label.
	 * @param string                                                          $url     Link from the menu, possibly HTML-encoded.
	 */
	private static function add_screen( array &$screens, string $group, string $label, string $url ): void {
		// Some menu slugs arrive already run through esc_url(), with &#038; for &.
		$url = html_entity_decode( $url, ENT_QUOTES, 'UTF-8' );

		// Upgrade and docs links point off-site, so they aren't screens a step can live on.
		if ( AWB_Tours::is_external_url( $url ) ) {
			return;
		}

		$url = AWB_Tours::sanitize_admin_url( $url );

		if ( ! isset( $screens[ $url ] ) ) {
			$screens[ $url ] = array(
				'group' => $group,
				'label' => $label,
				'url'   => $url,
			);
		}
	}

	/**
	 * Menu label as plain text, without the count bubbles.
	 *
	 * @param string $label Raw menu label HTML.
	 */
	private static function menu_label( string $label ): string {
		// The bubbles nest spans (awaiting-mod > pending-count + screen-reader-text), so I peel them innermost first.
		for ( $i = 0; $i < 5; $i++ ) {
			$next = preg_replace( '#<span\b[^>]*\bclass=(["\'])[^"\']*(?:count|awaiting-mod|update-plugins|menu-counter|screen-reader-text|badge)[^"\']*\1[^>]*>(?:(?!<span\b).)*?</span>#is', '', $label );

			if ( null === $next || $next === $label ) {
				break;
			}

			$label = $next;
		}

		$label = html_entity_decode( wp_strip_all_tags( $label ), ENT_QUOTES, 'UTF-8' );

		return trim( (string) preg_replace( '/\s+/u', ' ', $label ) );
	}

	/**
	 * Same rules wp-admin's menu uses to turn a slug into a link.
	 *
	 * @param string $slug        Menu item slug.
	 * @param string $parent_slug Parent slug, '' for a top-level item.
	 */
	private static function menu_url( string $slug, string $parent_slug ): string {
		$file = explode( '?', $slug )[0];

		$is_plugin_page = get_plugin_page_hook( $slug, '' !== $parent_slug ? $parent_slug : 'admin.php' )
			|| ( 'index.php' !== $slug && is_file( WP_PLUGIN_DIR . '/' . $file ) && ! is_file( ABSPATH . 'wp-admin/' . $file ) );

		if ( ! $is_plugin_page ) {
			return $slug;
		}

		$base = '' !== $parent_slug && is_file( ABSPATH . 'wp-admin/' . explode( '?', $parent_slug )[0] ) ? $parent_slug : 'admin.php';

		return add_query_arg( 'page', $slug, $base );
	}

	/**
	 * Every string the editor shows.
	 *
	 * @return array<string, string>
	 */
	private static function editor_strings(): array {
		return array(
			'titleLabel'                    => __( 'Walkthrough title', 'admin-walkthrough-builder' ),
			'titlePlaceholder'              => __( 'Walkthrough title', 'admin-walkthrough-builder' ),
			'descriptionLabel'              => __( 'Description', 'admin-walkthrough-builder' ),
			'descriptionPlaceholder'        => __( 'A short description: what will people learn?', 'admin-walkthrough-builder' ),
			'descriptionHint'               => __( 'Shown in the Guides menu and when the walkthrough starts. Keep it short.', 'admin-walkthrough-builder' ),
			'addChapter'                    => __( 'Add chapter', 'admin-walkthrough-builder' ),
			/* translators: %d: chapter number. */
			'chapterNumber'                 => __( 'Chapter %d', 'admin-walkthrough-builder' ),
			'chapterTitlePlaceholder'       => __( 'Chapter title', 'admin-walkthrough-builder' ),
			/* translators: %d: chapter number. */
			'chapterTitleLabel'             => __( 'Chapter %d title', 'admin-walkthrough-builder' ),
			/* translators: %d: chapter number. */
			'moveChapterUp'                 => __( 'Move chapter %d up', 'admin-walkthrough-builder' ),
			/* translators: %d: chapter number. */
			'moveChapterDown'               => __( 'Move chapter %d down', 'admin-walkthrough-builder' ),
			/* translators: %d: chapter number. */
			'deleteChapter'                 => __( 'Delete chapter %d', 'admin-walkthrough-builder' ),
			'lastChapter'                   => __( 'A walkthrough needs at least one chapter', 'admin-walkthrough-builder' ),
			'chapterDescriptionPlaceholder' => __( 'What this chapter covers (optional)', 'admin-walkthrough-builder' ),
			/* translators: %d: chapter number. */
			'chapterDescriptionLabel'       => __( 'Chapter %d description', 'admin-walkthrough-builder' ),
			'chapterDescriptionHint'        => __( 'Shown when people hover this chapter in the progress bar', 'admin-walkthrough-builder' ),
			/* translators: %d: chapter number. */
			'chapterStepsLabel'             => __( 'Chapter %d steps', 'admin-walkthrough-builder' ),
			'chapterEmpty'                  => __( 'No steps yet — add some on a screen', 'admin-walkthrough-builder' ),
			'addStepsOnScreen'              => __( 'Add steps on a screen…', 'admin-walkthrough-builder' ),
			/* translators: %d: chapter number. */
			'newChapterTitle'               => __( 'Chapter %d', 'admin-walkthrough-builder' ),
			'defaultChapterTitle'           => __( 'Getting started', 'admin-walkthrough-builder' ),
			'untitledChapter'               => __( 'Untitled chapter', 'admin-walkthrough-builder' ),
			'chapterAdded'                  => __( 'Chapter added.', 'admin-walkthrough-builder' ),
			/* translators: %d: new position of the chapter. */
			'chapterMoved'                  => __( 'Chapter moved to position %d.', 'admin-walkthrough-builder' ),
			/* translators: 1: title of the chapter being deleted, 2: title of the chapter its steps move to. */
			'deleteChapterMoveConfirm'      => __( 'Delete the chapter “%1$s”? Its steps will move to “%2$s”.', 'admin-walkthrough-builder' ),
			/* translators: %s: chapter title. */
			'deleteChapterConfirm'          => __( 'Delete the chapter “%s”?', 'admin-walkthrough-builder' ),
			'chapterDeleted'                => __( 'Chapter deleted.', 'admin-walkthrough-builder' ),
			'dragToReorder'                 => __( 'Drag to reorder', 'admin-walkthrough-builder' ),
			/* translators: %d: step number. */
			'moveStepUp'                    => __( 'Move step %d up', 'admin-walkthrough-builder' ),
			/* translators: %d: step number. */
			'moveStepDown'                  => __( 'Move step %d down', 'admin-walkthrough-builder' ),
			'edit'                          => __( 'Edit', 'admin-walkthrough-builder' ),
			/* translators: %d: step number. */
			'editStep'                      => __( 'Edit step %d', 'admin-walkthrough-builder' ),
			'showOnScreen'                  => __( 'Show on screen', 'admin-walkthrough-builder' ),
			/* translators: %d: step number. */
			'showStepOnScreen'              => __( 'Show on screen: step %d', 'admin-walkthrough-builder' ),
			'delete'                        => __( 'Delete', 'admin-walkthrough-builder' ),
			/* translators: %d: step number. */
			'deleteStep'                    => __( 'Delete step %d', 'admin-walkthrough-builder' ),
			'untitledStep'                  => __( 'Untitled step', 'admin-walkthrough-builder' ),
			/* translators: 1: screen name, 2: label of the highlighted element. */
			'whereWithElement'              => __( '%1$s · “%2$s”', 'admin-walkthrough-builder' ),
			'badgeElement'                  => __( 'Element', 'admin-walkthrough-builder' ),
			'badgeFloating'                 => __( 'Floating', 'admin-walkthrough-builder' ),
			'badgeClick'                    => __( 'Click to continue', 'admin-walkthrough-builder' ),
			'stepTitleLabel'                => __( 'Title', 'admin-walkthrough-builder' ),
			'stepTextLabel'                 => __( 'Text', 'admin-walkthrough-builder' ),
			'formatting'                    => __( 'Formatting', 'admin-walkthrough-builder' ),
			'bold'                          => __( 'Bold', 'admin-walkthrough-builder' ),
			'italic'                        => __( 'Italic', 'admin-walkthrough-builder' ),
			'link'                          => __( 'Link', 'admin-walkthrough-builder' ),
			'linkPrompt'                    => __( 'Link address (URL)', 'admin-walkthrough-builder' ),
			'placementLabel'                => __( 'Where the popup appears', 'admin-walkthrough-builder' ),
			'placementAuto'                 => __( 'Auto', 'admin-walkthrough-builder' ),
			'placementTop'                  => __( 'Top', 'admin-walkthrough-builder' ),
			'placementBottom'               => __( 'Bottom', 'admin-walkthrough-builder' ),
			'placementLeft'                 => __( 'Left', 'admin-walkthrough-builder' ),
			'placementRight'                => __( 'Right', 'admin-walkthrough-builder' ),
			'advanceLabel'                  => __( 'Moves on when', 'admin-walkthrough-builder' ),
			'advanceNext'                   => __( 'They press Next', 'admin-walkthrough-builder' ),
			'advanceClick'                  => __( 'They click the highlighted element', 'admin-walkthrough-builder' ),
			'floatingNote'                  => __( 'Floating step: it shows in the middle of the screen with a Next button.', 'admin-walkthrough-builder' ),
			'done'                          => __( 'Done', 'admin-walkthrough-builder' ),
			/* translators: 1: new position of the step, 2: chapter title. */
			'stepMoved'                     => __( 'Step moved to position %1$d in “%2$s”.', 'admin-walkthrough-builder' ),
			/* translators: %s: step title. */
			'deleteStepConfirm'             => __( 'Delete the step “%s”?', 'admin-walkthrough-builder' ),
			'stepDeleted'                   => __( 'Step deleted.', 'admin-walkthrough-builder' ),
			'publishBox'                    => __( 'Publish', 'admin-walkthrough-builder' ),
			'statusLabel'                   => __( 'Status', 'admin-walkthrough-builder' ),
			'statusDraft'                   => __( 'Draft', 'admin-walkthrough-builder' ),
			'statusLive'                    => __( 'Live', 'admin-walkthrough-builder' ),
			'preview'                       => __( 'Preview', 'admin-walkthrough-builder' ),
			'previewNeedsSteps'             => __( 'Add a step to preview it', 'admin-walkthrough-builder' ),
			'save'                          => __( 'Save', 'admin-walkthrough-builder' ),
			'saving'                        => __( 'Saving…', 'admin-walkthrough-builder' ),
			'unsavedChanges'                => __( 'Unsaved changes', 'admin-walkthrough-builder' ),
			'saved'                         => __( 'Saved ✓', 'admin-walkthrough-builder' ),
			/* translators: %d: number of steps (1). */
			'stepCountOne'                  => __( '%d step', 'admin-walkthrough-builder' ),
			/* translators: %d: number of steps. */
			'stepCountMany'                 => __( '%d steps', 'admin-walkthrough-builder' ),
			/* translators: %d: number of chapters (1). */
			'chapterCountOne'               => __( '%d chapter', 'admin-walkthrough-builder' ),
			/* translators: %d: number of chapters. */
			'chapterCountMany'              => __( '%d chapters', 'admin-walkthrough-builder' ),
			'saveOffline'                   => __( 'Couldn’t reach the server, so nothing was saved. Check your connection and try again.', 'admin-walkthrough-builder' ),
			/* translators: %s: error message from the server. */
			'saveFailed'                    => __( 'Couldn’t save the walkthrough: %s', 'admin-walkthrough-builder' ),
			/* translators: %d: HTTP status code. */
			'errorStatus'                   => __( 'error %d', 'admin-walkthrough-builder' ),
			'dismissNotice'                 => __( 'Dismiss this notice.', 'admin-walkthrough-builder' ),
			'audienceBox'                   => __( 'Who sees it', 'admin-walkthrough-builder' ),
			'rolesLabel'                    => __( 'Roles', 'admin-walkthrough-builder' ),
			'peopleLabel'                   => __( 'Specific people', 'admin-walkthrough-builder' ),
			'peopleSearchPlaceholder'       => __( 'Search by name or email…', 'admin-walkthrough-builder' ),
			'peopleResultsLabel'            => __( 'Matching people', 'admin-walkthrough-builder' ),
			'selectedPeopleLabel'           => __( 'Selected people', 'admin-walkthrough-builder' ),
			'searching'                     => __( 'Searching…', 'admin-walkthrough-builder' ),
			/* translators: %d: number of people found (1). */
			'peopleFoundOne'                => __( '%d person found', 'admin-walkthrough-builder' ),
			/* translators: %d: number of people found. */
			'peopleFoundMany'               => __( '%d people found', 'admin-walkthrough-builder' ),
			'noPeopleFound'                 => __( 'No people found.', 'admin-walkthrough-builder' ),
			'peopleSearchOffline'           => __( 'Couldn’t reach the server to search.', 'admin-walkthrough-builder' ),
			/* translators: %s: error message from the server. */
			'peopleSearchFailed'            => __( 'Search failed: %s', 'admin-walkthrough-builder' ),
			/* translators: %s: person's name. */
			'personAdded'                   => __( '%s added.', 'admin-walkthrough-builder' ),
			/* translators: %s: person's name. */
			'personRemoved'                 => __( '%s removed.', 'admin-walkthrough-builder' ),
			/* translators: %s: person's name. */
			'removePerson'                  => __( 'Remove %s', 'admin-walkthrough-builder' ),
			/* translators: %d: user ID. */
			'userFallback'                  => __( 'User #%d', 'admin-walkthrough-builder' ),
			'nobodyWarning'                 => __( 'Nobody will see this walkthrough yet.', 'admin-walkthrough-builder' ),
			'behaviourBox'                  => __( 'Behaviour', 'admin-walkthrough-builder' ),
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
			'dialogTitle'                   => __( 'Add steps on a screen', 'admin-walkthrough-builder' ),
			/* translators: %s: chapter title. */
			'dialogIntro'                   => __( 'Pick the screen where these steps happen. It opens in build mode, and the steps you add there go into “%s”.', 'admin-walkthrough-builder' ),
			'close'                         => __( 'Close', 'admin-walkthrough-builder' ),
			'searchScreensLabel'            => __( 'Search screens', 'admin-walkthrough-builder' ),
			'searchScreensPlaceholder'      => __( 'Search screens…', 'admin-walkthrough-builder' ),
			'otherScreens'                  => __( 'Other', 'admin-walkthrough-builder' ),
			'noScreensMatch'                => __( 'No screens match your search.', 'admin-walkthrough-builder' ),
			'pasteUrlLabel'                 => __( 'or paste a wp-admin URL', 'admin-walkthrough-builder' ),
			'openUrl'                       => __( 'Open', 'admin-walkthrough-builder' ),
			'urlEmpty'                      => __( 'Paste a wp-admin URL first.', 'admin-walkthrough-builder' ),
			'urlInvalid'                    => __( 'That doesn’t look like a valid URL.', 'admin-walkthrough-builder' ),
			'urlOtherSite'                  => __( 'That URL isn’t in this site’s wp-admin.', 'admin-walkthrough-builder' ),
			'resetPersonConfirm'            => __( 'Reset this person’s progress? They’ll start this walkthrough from the beginning next time.', 'admin-walkthrough-builder' ),
			'resetEveryoneConfirm'          => __( 'Reset everyone’s progress? Everybody will start this walkthrough from the beginning next time.', 'admin-walkthrough-builder' ),
			'resetOffline'                  => __( 'Couldn’t reach the server, so nothing was reset. Check your connection and try again.', 'admin-walkthrough-builder' ),
			/* translators: %s: error message from the server. */
			'resetFailed'                   => __( 'Couldn’t reset progress: %s', 'admin-walkthrough-builder' ),
		);
	}
}
