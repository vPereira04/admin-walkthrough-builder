<?php
/**
 * REST endpoints for the editor, the builder and the player.
 *
 * @package AdminWalkthroughBuilder
 */

defined( 'ABSPATH' ) || exit;

/**
 * Tour read/save/reset for managers, progress for learners.
 */
final class AWB_Rest {

	const ROUTE_NAMESPACE = 'admin-walkthrough-builder/v1';

	/**
	 * Wires up the hooks.
	 */
	public static function init(): void {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
	}

	/**
	 * Registers the routes.
	 */
	public static function register_routes(): void {
		$id_arg = array(
			'type'    => 'integer',
			'minimum' => 1,
		);

		register_rest_route(
			self::ROUTE_NAMESPACE,
			'/tours',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'create_tour' ),
				'permission_callback' => array( 'AWB_Tours', 'can_manage' ),
				'args'                => array(
					'title' => array(
						'type'    => 'string',
						'default' => '',
					),
				),
			)
		);

		register_rest_route(
			self::ROUTE_NAMESPACE,
			'/tours/(?P<id>\d+)',
			array(
				array(
					'methods'             => WP_REST_Server::READABLE,
					'callback'            => array( __CLASS__, 'get_tour' ),
					'permission_callback' => array( 'AWB_Tours', 'can_manage' ),
					'args'                => array(
						'id'      => $id_arg,
						'context' => array(
							'type'    => 'string',
							'enum'    => array( 'edit', 'play' ),
							'default' => 'edit',
						),
					),
				),
				array(
					'methods'             => WP_REST_Server::CREATABLE,
					'callback'            => array( __CLASS__, 'save_tour' ),
					'permission_callback' => array( 'AWB_Tours', 'can_manage' ),
					'args'                => array(
						'id'          => $id_arg,
						'title'       => array( 'type' => 'string' ),
						'description' => array( 'type' => 'string' ),
						'status'      => array(
							'type' => 'string',
							'enum' => AWB_Tours::STATUSES,
						),
						'chapters'    => array(
							'type'  => 'array',
							'items' => array( 'type' => 'object' ),
						),
						'steps'       => array(
							'type'  => 'array',
							'items' => array( 'type' => 'object' ),
						),
						'settings'    => array( 'type' => 'object' ),
					),
				),
			)
		);

		register_rest_route(
			self::ROUTE_NAMESPACE,
			'/tours/(?P<id>\d+)/reset',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'reset_tour' ),
				'permission_callback' => array( 'AWB_Tours', 'can_manage' ),
				'args'                => array(
					'id'   => $id_arg,
					'user' => array(
						'type'    => 'integer',
						'minimum' => 0,
						'default' => 0,
					),
				),
			)
		);

		register_rest_route(
			self::ROUTE_NAMESPACE,
			'/progress',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'save_progress' ),
				'permission_callback' => array( __CLASS__, 'can_track' ),
				'args'                => array(
					'tour'   => array(
						'type'     => 'integer',
						'minimum'  => 1,
						'required' => true,
					),
					'action' => array(
						'type'     => 'string',
						'enum'     => AWB_Progress::ACTIONS,
						'required' => true,
					),
					'step'   => array(
						'type'              => 'string',
						'default'           => '',
						'sanitize_callback' => array( __CLASS__, 'sanitize_step_id' ),
					),
					'days'   => array(
						'type'    => 'integer',
						'minimum' => 1,
						'maximum' => 365,
						'default' => 7,
					),
				),
			)
		);
	}

	/**
	 * Progress is only saved for tours the person actually gets.
	 *
	 * @param WP_REST_Request $request The request.
	 */
	public static function can_track( WP_REST_Request $request ): bool {
		$post = AWB_Tours::get( (int) $request['tour'] );
		return $post && is_user_logged_in() && AWB_Tours::is_visible_to( $post, wp_get_current_user() );
	}

	/**
	 * Tour in the editor's shape, or the player's for previews.
	 *
	 * @param WP_REST_Request $request The request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function get_tour( WP_REST_Request $request ) {
		$post = AWB_Tours::get( (int) $request['id'] );

		if ( ! $post ) {
			return self::not_found();
		}

		if ( 'play' === $request['context'] ) {
			return rest_ensure_response( AWB_Tours::play_shape( $post, get_current_user_id() ) );
		}

		return rest_ensure_response( AWB_Tours::edit_shape( $post ) );
	}

	/**
	 * Creates a draft with the defaults (the builder's "New walkthrough").
	 *
	 * @param WP_REST_Request $request The request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function create_tour( WP_REST_Request $request ) {
		$post = AWB_Tours::get( AWB_Tours::create( array( 'title' => (string) $request['title'] ) ) );

		if ( ! $post ) {
			return new WP_Error( 'awb_create_failed', __( 'The walkthrough couldn’t be created.', 'admin-walkthrough-builder' ), array( 'status' => 500 ) );
		}

		$response = rest_ensure_response( AWB_Tours::edit_shape( $post ) );
		$response->set_status( 201 );

		return $response;
	}

	/**
	 * Saves the parts of the tour that were sent and returns the cleaned result.
	 *
	 * @param WP_REST_Request $request The request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function save_tour( WP_REST_Request $request ) {
		$post = AWB_Tours::get( (int) $request['id'] );

		if ( ! $post ) {
			return self::not_found();
		}

		$data = array();

		foreach ( array( 'title', 'description', 'status', 'chapters', 'steps', 'settings' ) as $key ) {
			if ( $request->has_param( $key ) ) {
				$data[ $key ] = $request[ $key ];
			}
		}

		AWB_Tours::save( $post, $data );

		$post = AWB_Tours::get( (int) $post->ID );

		return rest_ensure_response( $post ? AWB_Tours::edit_shape( $post ) : array() );
	}

	/**
	 * Clears the tour's progress for one person, or everyone with user 0.
	 *
	 * @param WP_REST_Request $request The request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function reset_tour( WP_REST_Request $request ) {
		$post = AWB_Tours::get( (int) $request['id'] );

		if ( ! $post ) {
			return self::not_found();
		}

		AWB_Progress::forget( (int) $post->ID, (int) $request['user'] );

		return rest_ensure_response( array( 'ok' => true ) );
	}

	/**
	 * Records a player action for the current person.
	 *
	 * @param WP_REST_Request $request The request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function save_progress( WP_REST_Request $request ) {
		$post = AWB_Tours::get( (int) $request['tour'] );

		if ( ! $post ) {
			return self::not_found();
		}

		$steps  = AWB_Tours::definition( $post )['steps'];
		$action = (string) $request['action'];
		$step   = (string) $request['step'];

		// A step from an older copy of the tour is dropped rather than saved as a dead end.
		if ( -1 === AWB_Tours::step_index( $steps, $step ) ) {
			$step = '';
		}

		if ( 'step' === $action && '' === $step ) {
			return new WP_Error( 'awb_unknown_step', __( 'That step is not part of this walkthrough.', 'admin-walkthrough-builder' ), array( 'status' => 400 ) );
		}

		$entry = AWB_Progress::apply( get_current_user_id(), (int) $post->ID, $steps, $action, $step, (int) $request['days'] );

		return rest_ensure_response( array( 'progress' => $entry ) );
	}

	/**
	 * Anything that isn't a well-formed step id becomes ''.
	 *
	 * @param mixed $step Raw step id.
	 */
	public static function sanitize_step_id( $step ): string {
		return is_string( $step ) && preg_match( AWB_Tours::ID_PATTERN, $step ) ? $step : '';
	}

	/**
	 * The 404 for a missing or non-tour ID.
	 */
	private static function not_found(): WP_Error {
		return new WP_Error( 'awb_not_found', __( 'Walkthrough not found.', 'admin-walkthrough-builder' ), array( 'status' => 404 ) );
	}
}
