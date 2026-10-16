<?php
/**
 * Per-person progress through each tour, stored as a per-site user option.
 *
 * @package AdminWalkthroughBuilder
 */

defined( 'ABSPATH' ) || exit;

/**
 * Reads and updates the awb_progress user option and works out refresher offers.
 */
final class AWB_Progress {

	const OPTION = 'awb_progress';

	const ACTIONS  = array( 'start', 'step', 'complete', 'dismiss', 'remind', 'later', 'never' );
	const STATUSES = array( 'in_progress', 'completed', 'dismissed' );

	// "Later" on the refresher offer asks again after this many days.
	const LATER_DAYS = 3;

	/**
	 * Every tour entry this person has, keyed by tour ID.
	 *
	 * @param int $user_id The person.
	 * @return array<int, array{status: string, step: string, updated: int, completed: int, remind_at: int, no_remind: bool, runs: int}>
	 */
	public static function all( int $user_id ): array {
		$saved = $user_id > 0 ? get_user_option( self::OPTION, $user_id ) : false;
		$all   = array();

		if ( ! is_array( $saved ) ) {
			return $all;
		}

		foreach ( $saved as $tour_id => $entry ) {
			if ( (int) $tour_id > 0 && is_array( $entry ) ) {
				$all[ (int) $tour_id ] = self::normalize( $entry );
			}
		}

		return $all;
	}

	/**
	 * This person's entry for one tour, or null when they haven't started it.
	 *
	 * @param int $user_id The person.
	 * @param int $tour_id The tour.
	 * @return array{status: string, step: string, updated: int, completed: int, remind_at: int, no_remind: bool, runs: int}|null
	 */
	public static function get( int $user_id, int $tour_id ): ?array {
		$all = self::all( $user_id );
		return isset( $all[ $tour_id ] ) ? $all[ $tour_id ] : null;
	}

	/**
	 * Applies a player action and returns the updated entry.
	 *
	 * @param int                               $user_id The person.
	 * @param int                               $tour_id The tour.
	 * @param array<int, array<string, string>> $steps   The tour's sanitized steps.
	 * @param string                            $action  One of self::ACTIONS.
	 * @param string                            $step    Step id, already checked to belong to the tour (or '').
	 * @param int                               $days    Days for "remind", 1..365.
	 * @return array{status: string, step: string, updated: int, completed: int, remind_at: int, no_remind: bool, runs: int}
	 */
	public static function apply( int $user_id, int $tour_id, array $steps, string $action, string $step, int $days ): array {
		$all   = self::all( $user_id );
		$entry = isset( $all[ $tour_id ] ) ? $all[ $tour_id ] : self::normalize( array() );
		$now   = time();

		switch ( $action ) {
			case 'start':
				$entry['status']    = 'in_progress';
				$entry['step']      = '' !== $step ? $step : ( $steps ? $steps[0]['id'] : '' );
				$entry['runs']     += 1;
				$entry['remind_at'] = 0;
				break;

			case 'step':
				$entry['status'] = 'in_progress';
				$entry['step']   = $step;
				break;

			case 'complete':
				$entry['status']    = 'completed';
				$entry['completed'] = $now;
				$entry['step']      = '';
				$entry['remind_at'] = 0;
				break;

			case 'dismiss':
				if ( 'completed' !== $entry['status'] ) {
					$entry['status'] = 'dismissed';
				}
				if ( '' !== $step ) {
					$entry['step'] = $step;
				}
				break;

			case 'remind':
				$entry['remind_at'] = $now + max( 1, min( 365, $days ) ) * DAY_IN_SECONDS;
				$entry['no_remind'] = false;
				break;

			case 'later':
				$entry['remind_at'] = $now + self::LATER_DAYS * DAY_IN_SECONDS;
				break;

			case 'never':
				$entry['no_remind'] = true;
				$entry['remind_at'] = 0;
				break;
		}

		$entry['updated'] = $now;

		$all[ $tour_id ] = $entry;
		update_user_option( $user_id, self::OPTION, wp_slash( $all ) );

		return $entry;
	}

	/**
	 * Wipes a tour's entry for one person, or for everyone when $user_id is 0.
	 *
	 * @param int $tour_id The tour.
	 * @param int $user_id The person, or 0 for everyone.
	 */
	public static function forget( int $tour_id, int $user_id = 0 ): void {
		$user_ids = $user_id > 0 ? array( $user_id ) : self::users_with_progress();

		foreach ( $user_ids as $id ) {
			$all = self::all( (int) $id );

			if ( ! isset( $all[ $tour_id ] ) ) {
				continue;
			}

			unset( $all[ $tour_id ] );

			if ( $all ) {
				update_user_option( (int) $id, self::OPTION, wp_slash( $all ) );
			} else {
				delete_user_option( (int) $id, self::OPTION );
			}
		}
	}

	/**
	 * The first finished tour that's due a refresher, as {tour, days since finishing}.
	 *
	 * @param array<int, WP_Post> $tours   Tours this person can see.
	 * @param int                 $user_id The person.
	 * @return array{tour: int, days: int}|null
	 */
	public static function offer( array $tours, int $user_id ): ?array {
		$all = self::all( $user_id );
		$now = time();

		foreach ( $tours as $post ) {
			$id       = (int) $post->ID;
			$settings = AWB_Tours::definition( $post )['settings'];

			if ( ! isset( $all[ $id ] ) || ! $settings['allow_replay'] ) {
				continue;
			}

			$entry = $all[ $id ];

			if ( 'completed' !== $entry['status'] || $entry['no_remind'] ) {
				continue;
			}

			$due = $entry['remind_at'];

			if ( ! $due && $settings['refresh_days'] > 0 ) {
				$due = $entry['completed'] + $settings['refresh_days'] * DAY_IN_SECONDS;
			}

			if ( $due && $now >= $due ) {
				return array(
					'tour' => $id,
					'days' => (int) floor( max( 0, $now - $entry['completed'] ) / DAY_IN_SECONDS ),
				);
			}
		}

		return null;
	}

	/**
	 * Meta key of the per-site option, the way update_user_option() writes it.
	 */
	public static function meta_key(): string {
		global $wpdb;
		return $wpdb->get_blog_prefix() . self::OPTION;
	}

	/**
	 * IDs of everyone who has progress saved on this site.
	 *
	 * @return array<int, int>
	 */
	private static function users_with_progress(): array {
		$ids = get_users(
			array(
				// blog_id 0, so people already removed from the site still get cleaned up.
				'blog_id'      => 0,
				'fields'       => 'ID',
				'meta_key'     => self::meta_key(), // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key -- Only runs on a manual reset or delete.
				'meta_compare' => 'EXISTS',
			)
		);

		return array_map( 'intval', $ids );
	}

	/**
	 * Fills in missing keys and casts types.
	 *
	 * @param array<string, mixed> $entry Raw entry.
	 * @return array{status: string, step: string, updated: int, completed: int, remind_at: int, no_remind: bool, runs: int}
	 */
	private static function normalize( array $entry ): array {
		$status = isset( $entry['status'] ) && in_array( $entry['status'], self::STATUSES, true ) ? $entry['status'] : 'in_progress';

		return array(
			'status'    => $status,
			'step'      => isset( $entry['step'] ) && is_string( $entry['step'] ) ? $entry['step'] : '',
			'updated'   => isset( $entry['updated'] ) ? (int) $entry['updated'] : 0,
			'completed' => isset( $entry['completed'] ) ? (int) $entry['completed'] : 0,
			'remind_at' => isset( $entry['remind_at'] ) ? (int) $entry['remind_at'] : 0,
			'no_remind' => ! empty( $entry['no_remind'] ),
			'runs'      => isset( $entry['runs'] ) ? (int) $entry['runs'] : 0,
		);
	}
}
