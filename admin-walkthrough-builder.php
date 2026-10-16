<?php
/**
 * Plugin Name:       Admin Walkthrough Builder
 * Description:       Build step-by-step guided tours inside wp-admin so you can train clients right where they work.
 * Version:           1.0.0
 * Requires at least: 6.2
 * Requires PHP:      7.4
 * Author:            Victor Pereira
 * License:           GPLv2 or later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       admin-walkthrough-builder
 * Domain Path:       /languages
 *
 * @package AdminWalkthroughBuilder
 */

defined( 'ABSPATH' ) || exit;

define( 'AWB_FILE', __FILE__ );
define( 'AWB_VERSION', '1.0.0' );

require_once __DIR__ . '/includes/class-awb-tours.php';
require_once __DIR__ . '/includes/class-awb-progress.php';
require_once __DIR__ . '/includes/class-awb-rest.php';
require_once __DIR__ . '/includes/class-awb-player.php';
require_once __DIR__ . '/includes/class-awb-admin.php';

AWB_Tours::init();
AWB_Rest::init();
AWB_Player::init();
AWB_Admin::init();
