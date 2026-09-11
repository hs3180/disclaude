/**
 * Dynamic Channel Plugin types.
 *
 * Defines the interface for dynamically loaded channel plugins.
 * Each channel plugin is stored in its own directory under
 * `.disclaude/channels/<channel-id>/` with an independent `channel.yaml`.
 *
 * This approach eliminates race conditions that existed with unified file
 * approaches (see rejected PRs #1443, #1485).
 *
 * @module types/channel-plugin
 */
/**
 * Valid channel ID pattern.
 * Prevents path traversal and directory escape attacks.
 */
export const SAFE_CHANNEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_\-]*$/;
/**
 * Reserved channel IDs that cannot be used for dynamic channels.
 */
export const RESERVED_CHANNEL_IDS = ['.', '..', 'templates', '_shared'];
