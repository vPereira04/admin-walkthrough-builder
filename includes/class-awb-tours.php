<?php
/**
 * Walkthroughs: the awb_tour post type, its definition meta and who gets to see it.
 *
 * @package AdminWalkthroughBuilder
 */

defined( 'ABSPATH' ) || exit;

/**
 * Reads, sanitizes and saves tours, and answers "who sees this tour?".
 */
final class AWB_Tours {

	const POST_TYPE = 'awb_tour';
	const META      = '_awb_tour';

	const MAX_CHAPTERS = 50;
	const MAX_STEPS    = 200;

	const ID_PATTERN = '/^[cs]_[a-z0-9]{4,12}$/';

	const PLACEMENTS    = array( 'auto', 'top', 'bottom', 'left', 'right' );
	const ADVANCES      = array( 'next', 'click' );
	const BAR_POSITIONS = array( 'top', 'bottom' );
	const STATUSES      = array( 'publish', 'draft' );

	/**
	 * Sanitized definitions for this request, keyed by tour ID.
	 *
	 * @var array<int, array{chapters: array<int, array<string, string>>, steps: array<int, array<string, string>>, settings: array<string, mixed>}>
	 */
	private static $definitions = array();

	/**
	 * Visible tours for this request, keyed by user ID.
	 *
	 * @var array<int, array<int, WP_Post>>
	 */
	private static $visible = array();

	/**
	 * Wires up the hooks.
	 */
	public static function init(): void {
		add_action( 'init', array( __CLASS__, 'register_post_type' ) );
	}

	/**
	 * Capability needed to build and manage walkthroughs.
	 */
	public static function capability(): string {
		return (string) apply_filters( 'awb_capability', 'manage_options' );
	}

	/**
	 * Whether the current user builds and manages walkthroughs.
	 */
	public static function can_manage(): bool {
		return current_user_can( self::capability() );
	}

	/**
	 * Registers the post type. It has no UI of its own; the plugin's screens handle it.
	 */
	public static function register_post_type(): void {
		register_post_type(
			self::POST_TYPE,
			array(
				'labels'              => array(
					'name'          => __( 'Walkthroughs', 'admin-walkthrough-builder' ),
					'singular_name' => __( 'Walkthrough', 'admin-walkthrough-builder' ),
					'add_new_item'  => __( 'Add New Walkthrough', 'admin-walkthrough-builder' ),
					'edit_item'     => __( 'Edit Walkthrough', 'admin-walkthrough-builder' ),
					'all_items'     => __( 'All Walkthroughs', 'admin-walkthrough-builder' ),
					'not_found'     => __( 'No walkthroughs found.', 'admin-walkthrough-builder' ),
				),
				'public'              => false,
				'publicly_queryable'  => false,
				'exclude_from_search' => true,
				'show_ui'             => false,
				'show_in_menu'        => false,
				'show_in_nav_menus'   => false,
				'show_in_admin_bar'   => false,
				'show_in_rest'        => false,
				'has_archive'         => false,
				'rewrite'             => false,
				'query_var'           => false,
				'can_export'          => false,
				'delete_with_user'    => false,
				'supports'            => array( 'title' ),
			)
		);
	}

	/**
	 * Settings for a brand-new tour.
	 *
	 * @return array<string, mixed>
	 */
	public static function default_settings(): array {
		return array(
			'roles'        => array(),
			'users'        => array(),
			'auto_start'   => true,
			'allow_skip'   => true,
			'allow_exit'   => true,
			'allow_replay' => true,
			'refresh_days' => 0,
			'bar_position' => 'top',
		);
	}

	/**
	 * Definition for a brand-new tour: one empty chapter.
	 *
	 * @return array{chapters: array<int, array<string, string>>, steps: array<int, array<string, string>>, settings: array<string, mixed>}
	 */
	public static function default_definition(): array {
		return array(
			'chapters' => array( self::default_chapter() ),
			'steps'    => array(),
			'settings' => self::default_settings(),
		);
	}

	/**
	 * The tour post, or null when the ID isn't a tour.
	 *
	 * @param int $id Post ID.
	 */
	public static function get( int $id ): ?WP_Post {
		$post = $id > 0 ? get_post( $id ) : null;
		return ( $post instanceof WP_Post && self::POST_TYPE === $post->post_type ) ? $post : null;
	}

	/**
	 * The stored chapters, steps and settings.
	 *
	 * I sanitize on read as well, so a deleted user or role (or hand-edited meta)
	 * never reaches the player. It's memoised, so it runs once per tour per request.
	 *
	 * @param WP_Post $post The tour.
	 * @return array{chapters: array<int, array<string, string>>, steps: array<int, array<string, string>>, settings: array<string, mixed>}
	 */
	public static function definition( WP_Post $post ): array {
		$id = (int) $post->ID;

		if ( ! isset( self::$definitions[ $id ] ) ) {
			$raw                      = get_post_meta( $id, self::META, true );
			self::$definitions[ $id ] = self::sanitize_definition( is_array( $raw ) ? $raw : array() );
		}

		return self::$definitions[ $id ];
	}

	/**
	 * Creates a tour and returns its ID (0 on failure).
	 *
	 * @param array<string, mixed> $data Optional title, description, status, chapters, steps, settings.
	 */
	public static function create( array $data = array() ): int {
		$title = isset( $data['title'] ) ? self::sanitize_title( $data['title'] ) : '';

		$id = wp_insert_post(
			wp_slash(
				array(
					'post_type'    => self::POST_TYPE,
					'post_status'  => isset( $data['status'] ) && in_array( $data['status'], self::STATUSES, true ) ? $data['status'] : 'draft',
					'post_title'   => '' !== $title ? $title : __( 'New walkthrough', 'admin-walkthrough-builder' ),
					'post_excerpt' => isset( $data['description'] ) && is_string( $data['description'] ) ? sanitize_textarea_field( $data['description'] ) : '',
				)
			),
			true
		);

		if ( is_wp_error( $id ) ) {
			return 0;
		}

		self::store_definition( (int) $id, self::sanitize_definition( $data + self::default_definition() ) );

		return (int) $id;
	}

	/**
	 * Saves whatever parts of the tour are present in $data.
	 *
	 * @param WP_Post              $post The tour.
	 * @param array<string, mixed> $data Title, description, status, chapters, steps, settings (all optional).
	 */
	public static function save( WP_Post $post, array $data ): void {
		$update = array( 'ID' => (int) $post->ID );

		if ( isset( $data['title'] ) ) {
			$title = self::sanitize_title( $data['title'] );

			if ( '' !== $title ) {
				$update['post_title'] = $title;
			}
		}

		if ( isset( $data['description'] ) && is_string( $data['description'] ) ) {
			$update['post_excerpt'] = sanitize_textarea_field( $data['description'] );
		}

		if ( isset( $data['status'] ) && in_array( $data['status'], self::STATUSES, true ) ) {
			$update['post_status'] = $data['status'];
		}

		// I update the post even when only steps changed, so its modified date (the list's "Updated") moves too.
		wp_update_post( wp_slash( $update ) );

		$definition = self::definition( $post );

		foreach ( array( 'chapters', 'steps', 'settings' ) as $key ) {
			if ( isset( $data[ $key ] ) && is_array( $data[ $key ] ) ) {
				$definition[ $key ] = $data[ $key ];
			}
		}

		self::store_definition( (int) $post->ID, self::sanitize_definition( $definition ) );
	}

	/**
	 * Writes the meta and forgets the cached copy.
	 *
	 * @param int                  $id         Tour ID.
	 * @param array<string, mixed> $definition Sanitized definition.
	 */
	private static function store_definition( int $id, array $definition ): void {
		// Meta functions unslash, so without this a backslash in a step's text would vanish.
		update_post_meta( $id, self::META, wp_slash( $definition ) );
		unset( self::$definitions[ $id ] );
		self::$visible = array();
	}

	/**
	 * Cleans a full definition: ids, limits, chapter grouping, allow-lists.
	 *
	 * @param array<string, mixed> $raw Raw chapters, steps and settings.
	 * @return array{chapters: array<int, array<string, string>>, steps: array<int, array<string, string>>, settings: array<string, mixed>}
	 */
	public static function sanitize_definition( array $raw ): array {
		$chapters = array();
		$renamed  = array();
		$used     = array();

		$raw_chapters = isset( $raw['chapters'] ) && is_array( $raw['chapters'] ) ? array_values( $raw['chapters'] ) : array();

		foreach ( array_slice( $raw_chapters, 0, self::MAX_CHAPTERS ) as $chapter ) {
			if ( ! is_array( $chapter ) ) {
				continue;
			}

			$raw_id = isset( $chapter['id'] ) && is_string( $chapter['id'] ) ? $chapter['id'] : '';
			$id     = self::unique_id( $raw_id, 'c', $used );

			// Steps still point at the chapter's old id, so I remember the swap.
			if ( '' !== $raw_id && ! isset( $renamed[ $raw_id ] ) ) {
				$renamed[ $raw_id ] = $id;
			}

			$chapters[] = array(
				'id'          => $id,
				'title'       => isset( $chapter['title'] ) ? self::sanitize_title( $chapter['title'] ) : '',
				'description' => isset( $chapter['description'] ) && is_string( $chapter['description'] ) ? sanitize_textarea_field( $chapter['description'] ) : '',
			);
		}

		if ( ! $chapters ) {
			$chapters[]                 = self::default_chapter();
			$used[ $chapters[0]['id'] ] = true;
		}

		$buckets = array_fill_keys( array_column( $chapters, 'id' ), array() );
		$first   = $chapters[0]['id'];

		$raw_steps = isset( $raw['steps'] ) && is_array( $raw['steps'] ) ? array_values( $raw['steps'] ) : array();

		foreach ( array_slice( $raw_steps, 0, self::MAX_STEPS ) as $step ) {
			if ( ! is_array( $step ) ) {
				continue;
			}

			$clean   = self::sanitize_step( $step, $used );
			$chapter = isset( $step['chapter'] ) && is_string( $step['chapter'] ) && isset( $renamed[ $step['chapter'] ] ) ? $renamed[ $step['chapter'] ] : $first;

			$clean['chapter']      = $chapter;
			$buckets[ $chapter ][] = $clean;
		}

		return array(
			'chapters' => $chapters,
			'steps'    => array_merge( ...array_values( $buckets ) ),
			'settings' => self::sanitize_settings( isset( $raw['settings'] ) && is_array( $raw['settings'] ) ? $raw['settings'] : array() ),
		);
	}

	/**
	 * One step. The chapter is filled in by the caller.
	 *
	 * @param array<string, mixed> $step Raw step.
	 * @param array<string, bool>  $used Ids taken so far.
	 * @return array<string, string>
	 */
	private static function sanitize_step( array $step, array &$used ): array {
		$text = static function ( string $key ) use ( $step ): string {
			return isset( $step[ $key ] ) && is_scalar( $step[ $key ] ) ? (string) $step[ $key ] : '';
		};

		$placement = $text( 'placement' );
		$advance   = $text( 'advance' );

		return array(
			'id'        => self::unique_id( $text( 'id' ), 's', $used ),
			'chapter'   => '',
			'title'     => self::sanitize_title( $text( 'title' ) ),
			'content'   => wp_kses( $text( 'content' ), self::allowed_html() ),
			'url'       => self::sanitize_admin_url( $text( 'url' ) ),
			'screen'    => sanitize_key( $text( 'screen' ) ),
			'selector'  => mb_substr( trim( wp_strip_all_tags( $text( 'selector' ) ) ), 0, 500 ),
			'label'     => mb_substr( sanitize_text_field( $text( 'label' ) ), 0, 80 ),
			'placement' => in_array( $placement, self::PLACEMENTS, true ) ? $placement : 'auto',
			'advance'   => in_array( $advance, self::ADVANCES, true ) ? $advance : 'next',
		);
	}

	/**
	 * Tour settings, falling back to the defaults for anything missing or invalid.
	 *
	 * @param array<string, mixed> $raw Raw settings.
	 * @return array<string, mixed>
	 */
	public static function sanitize_settings( array $raw ): array {
		$settings = self::default_settings();

		if ( isset( $raw['roles'] ) && is_array( $raw['roles'] ) ) {
			$roles             = array_map( 'sanitize_key', array_filter( $raw['roles'], 'is_string' ) );
			$settings['roles'] = array_values( array_intersect( array_keys( wp_roles()->get_names() ), $roles ) );
		}

		if ( isset( $raw['users'] ) && is_array( $raw['users'] ) ) {
			$users = array_unique( array_map( 'absint', array_filter( $raw['users'], 'is_scalar' ) ) );

			$settings['users'] = array_values(
				array_filter(
					$users,
					static function ( int $id ): bool {
						return $id > 0 && false !== get_userdata( $id );
					}
				)
			);
		}

		foreach ( array( 'auto_start', 'allow_skip', 'allow_exit', 'allow_replay' ) as $flag ) {
			if ( isset( $raw[ $flag ] ) && is_scalar( $raw[ $flag ] ) ) {
				$settings[ $flag ] = rest_sanitize_boolean( is_bool( $raw[ $flag ] ) ? $raw[ $flag ] : (string) $raw[ $flag ] );
			}
		}

		if ( isset( $raw['refresh_days'] ) && is_numeric( $raw['refresh_days'] ) ) {
			$settings['refresh_days'] = max( 0, min( 365, (int) $raw['refresh_days'] ) );
		}

		if ( isset( $raw['bar_position'] ) && in_array( $raw['bar_position'], self::BAR_POSITIONS, true ) ) {
			$settings['bar_position'] = $raw['bar_position'];
		}

		return $settings;
	}

	/**
	 * Keeps a step URL relative to wp-admin, so the player can always prefix it with admin_url().
	 *
	 * I don't use sanitize_text_field() here: it strips %xx octets, which would break
	 * encoded query args like customize.php?return=%2Fwp-admin%2F.
	 *
	 * @param mixed $url Raw URL, full or admin-relative.
	 */
	public static function sanitize_admin_url( $url ): string {
		$url = is_string( $url ) ? trim( $url ) : '';

		// Only the path counts, so a return=/wp-admin/… query arg is left alone.
		$pos = strpos( substr( $url, 0, strcspn( $url, '?#' ) ), 'wp-admin/' );

		if ( false !== $pos ) {
			$url = substr( $url, $pos + strlen( 'wp-admin/' ) );
		}

		if ( self::is_external_url( $url ) ) {
			return 'index.php';
		}

		$url = ltrim( $url, '/' );
		$url = (string) preg_replace( '|[^a-z0-9\-~+_.?#=!&;,/:%@$\|*\'()\[\]\x80-\xff]|i', '', $url );
		$url = mb_substr( $url, 0, 500 );

		return '' !== $url ? $url : 'index.php';
	}

	/**
	 * Whether a URL has a scheme (https:, javascript:) or is protocol-relative.
	 *
	 * @param string $url The URL.
	 */
	public static function is_external_url( string $url ): bool {
		return 0 === strpos( $url, '//' ) || (bool) preg_match( '#^[a-z][a-z0-9+.\-]*:#i', $url );
	}

	/**
	 * HTML allowed in a step's text.
	 *
	 * @return array<string, array<string, bool>>
	 */
	public static function allowed_html(): array {
		return array(
			'a'      => array(
				'href'   => true,
				'target' => true,
				'rel'    => true,
			),
			'strong' => array(),
			'b'      => array(),
			'em'     => array(),
			'i'      => array(),
			'br'     => array(),
			'p'      => array(),
			'ul'     => array(),
			'ol'     => array(),
			'li'     => array(),
			'code'   => array(),
			'kbd'    => array(),
			'mark'   => array(),
		);
	}

	/**
	 * The shape the editor and builder work with.
	 *
	 * @param WP_Post $post The tour.
	 * @return array<string, mixed>
	 */
	public static function edit_shape( WP_Post $post ): array {
		$definition = self::definition( $post );

		return array(
			'id'          => (int) $post->ID,
			'title'       => $post->post_title,
			'description' => $post->post_excerpt,
			'status'      => 'publish' === $post->post_status ? 'publish' : 'draft',
			'chapters'    => $definition['chapters'],
			'steps'       => $definition['steps'],
			'settings'    => $definition['settings'],
			'modified'    => (int) get_post_modified_time( 'U', true, $post ),
		);
	}

	/**
	 * The shape the player runs, with this user's progress.
	 *
	 * @param WP_Post $post    The tour.
	 * @param int     $user_id Whose progress to include.
	 * @return array<string, mixed>
	 */
	public static function play_shape( WP_Post $post, int $user_id ): array {
		$definition = self::definition( $post );
		$progress   = AWB_Progress::get( $user_id, (int) $post->ID );
		$steps      = array();

		foreach ( $definition['steps'] as $step ) {
			$steps[] = array(
				'id'        => $step['id'],
				'chapter'   => $step['chapter'],
				'title'     => $step['title'],
				'html'      => wpautop( $step['content'] ),
				'url'       => $step['url'],
				'screen'    => $step['screen'],
				'selector'  => $step['selector'],
				'placement' => $step['placement'],
				'advance'   => $step['advance'],
			);
		}

		return array(
			'id'          => (int) $post->ID,
			'title'       => $post->post_title,
			'description' => $post->post_excerpt,
			'chapters'    => $definition['chapters'],
			'steps'       => $steps,
			'settings'    => array(
				'auto_start'   => (bool) $definition['settings']['auto_start'],
				'allow_skip'   => (bool) $definition['settings']['allow_skip'],
				'allow_exit'   => (bool) $definition['settings']['allow_exit'],
				'allow_replay' => (bool) $definition['settings']['allow_replay'],
				'bar_position' => $definition['settings']['bar_position'],
			),
			'progress'    => array(
				'status'    => $progress ? $progress['status'] : '',
				'step'      => $progress ? $progress['step'] : '',
				'completed' => $progress ? $progress['completed'] : 0,
				'runs'      => $progress ? $progress['runs'] : 0,
			),
		);
	}

	/**
	 * The portable file contents for "Export". Specific people don't carry over to another site.
	 *
	 * @param WP_Post $post The tour.
	 * @return array<string, mixed>
	 */
	public static function export_shape( WP_Post $post ): array {
		$definition = self::definition( $post );

		$definition['settings']['users'] = array();

		return array(
			'version'     => 1,
			'title'       => $post->post_title,
			'description' => $post->post_excerpt,
			'chapters'    => $definition['chapters'],
			'steps'       => $definition['steps'],
			'settings'    => $definition['settings'],
		);
	}

	/**
	 * Whether this person gets the tour: it's live, and they have a picked role or were picked by name.
	 *
	 * @param WP_Post $post The tour.
	 * @param WP_User $user The person.
	 */
	public static function is_visible_to( WP_Post $post, WP_User $user ): bool {
		if ( 'publish' !== $post->post_status || ! $user->exists() ) {
			return false;
		}

		$settings = self::definition( $post )['settings'];

		if ( in_array( (int) $user->ID, $settings['users'], true ) ) {
			return true;
		}

		// Super admins often have no role on a multisite site, so they count as administrators.
		if ( in_array( 'administrator', $settings['roles'], true ) && is_multisite() && is_super_admin( $user->ID ) ) {
			return true;
		}

		return (bool) array_intersect( $settings['roles'], (array) $user->roles );
	}

	/**
	 * Live tours with at least one step that this person gets, oldest first.
	 *
	 * @param WP_User $user The person.
	 * @return array<int, WP_Post>
	 */
	public static function visible_for( WP_User $user ): array {
		$user_id = (int) $user->ID;

		if ( isset( self::$visible[ $user_id ] ) ) {
			return self::$visible[ $user_id ];
		}

		$tours = array();

		foreach ( self::query( array( 'publish' ) ) as $post ) {
			if ( self::definition( $post )['steps'] && self::is_visible_to( $post, $user ) ) {
				$tours[] = $post;
			}
		}

		self::$visible[ $user_id ] = $tours;

		return $tours;
	}

	/**
	 * Tours with the given statuses.
	 *
	 * @param array<int, string> $statuses Post statuses.
	 * @param string             $order    'ASC' for oldest first, 'DESC' for newest first.
	 * @return array<int, WP_Post>
	 */
	public static function query( array $statuses, string $order = 'ASC' ): array {
		return get_posts(
			array(
				'post_type'      => self::POST_TYPE,
				'post_status'    => $statuses,
				'posts_per_page' => 100,
				'orderby'        => 'date',
				'order'          => 'DESC' === $order ? 'DESC' : 'ASC',
			)
		);
	}

	/**
	 * IDs of the people the tour's settings pick, up to $limit.
	 *
	 * @param array<string, mixed> $settings Sanitized tour settings.
	 * @param int                  $limit    Max people to return.
	 * @return array<int, int>
	 */
	public static function audience_ids( array $settings, int $limit ): array {
		$ids = array_map( 'intval', $settings['users'] );

		if ( $settings['roles'] ) {
			$ids = array_merge(
				$ids,
				array_map(
					'intval',
					get_users(
						array(
							'role__in' => $settings['roles'],
							'fields'   => 'ID',
							'number'   => $limit,
							'orderby'  => 'display_name',
						)
					)
				)
			);
		}

		if ( in_array( 'administrator', $settings['roles'], true ) && is_multisite() ) {
			foreach ( get_super_admins() as $login ) {
				$admin = get_user_by( 'login', $login );

				if ( $admin ) {
					$ids[] = (int) $admin->ID;
				}
			}
		}

		return array_slice( array_values( array_unique( $ids ) ), 0, $limit );
	}

	/**
	 * Admin URL for a step with extra query args, e.g. awb_start.
	 *
	 * @param array<string, string> $step Sanitized step.
	 * @param array<string, mixed>  $args Query args to add.
	 */
	public static function step_link( array $step, array $args ): string {
		return add_query_arg( $args, admin_url( $step['url'] ) );
	}

	/**
	 * Position of a step in the tour (0-based), or -1.
	 *
	 * @param array<int, array<string, string>> $steps   Sanitized steps.
	 * @param string                            $step_id Step id.
	 */
	public static function step_index( array $steps, string $step_id ): int {
		if ( '' === $step_id ) {
			return -1;
		}

		$index = array_search( $step_id, array_column( $steps, 'id' ), true );

		return false === $index ? -1 : (int) $index;
	}

	/**
	 * Titles go through sanitize_text_field and stop at 200 characters.
	 *
	 * @param mixed $title Raw title.
	 */
	private static function sanitize_title( $title ): string {
		return is_scalar( $title ) ? mb_substr( sanitize_text_field( (string) $title ), 0, 200 ) : '';
	}

	/**
	 * Keeps a valid, not-yet-used id, or makes a fresh one.
	 *
	 * @param string              $id     Raw id.
	 * @param string              $prefix 'c' for chapters, 's' for steps.
	 * @param array<string, bool> $used   Ids taken so far.
	 */
	private static function unique_id( string $id, string $prefix, array &$used ): string {
		if ( 0 !== strpos( $id, $prefix . '_' ) || ! preg_match( self::ID_PATTERN, $id ) || isset( $used[ $id ] ) ) {
			do {
				$id = $prefix . '_' . strtolower( wp_generate_password( 8, false ) );
			} while ( isset( $used[ $id ] ) );
		}

		$used[ $id ] = true;

		return $id;
	}

	/**
	 * The "Getting started" chapter every new tour begins with.
	 *
	 * @return array<string, string>
	 */
	private static function default_chapter(): array {
		return array(
			'id'          => 'c_' . strtolower( wp_generate_password( 8, false ) ),
			'title'       => __( 'Getting started', 'admin-walkthrough-builder' ),
			'description' => '',
		);
	}
}
