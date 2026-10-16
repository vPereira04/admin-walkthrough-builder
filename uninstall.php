<?php
/**
 * Deletes every walkthrough and everyone's progress, on every site.
 *
 * @package AdminWalkthroughBuilder
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

/**
 * Cleans up the current site.
 */
function awb_uninstall_site(): void {
	global $wpdb;

	$tour_ids = get_posts(
		array(
			'post_type'      => 'awb_tour',
			'post_status'    => array( 'publish', 'draft', 'pending', 'private', 'future', 'trash', 'auto-draft' ),
			'posts_per_page' => -1,
			'fields'         => 'ids',
		)
	);

	foreach ( $tour_ids as $tour_id ) {
		wp_delete_post( (int) $tour_id, true );
	}

	// Progress is a per-site user option, so its meta key carries this site's table prefix.
	delete_metadata( 'user', 0, $wpdb->get_blog_prefix() . 'awb_progress', '', true );
}

if ( is_multisite() ) {
	foreach ( get_sites(
		array(
			'fields' => 'ids',
			'number' => 0,
		)
	) as $awb_site_id ) {
		switch_to_blog( (int) $awb_site_id );
		awb_uninstall_site();
		restore_current_blog();
	}
} else {
	awb_uninstall_site();
}
