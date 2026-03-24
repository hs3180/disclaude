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
 * Channel plugin manifest - parsed from `channel.yaml`.
 *
 * Each channel has its own independent directory and configuration file,
 * eliminating concurrent read-modify-write race conditions.
 */
export interface ChannelPluginManifest {
  /** Unique channel identifier (must match directory name) */
  id: string;

  /** Human-readable channel name */
  name: string;

  /**
   * Module specifier for the channel plugin.
   * Can be:
   * - npm package: `@scope/package-name`
   * - local path: `./relative-path` or `/absolute-path`
   */
  module: string;

  /** Whether this channel is enabled (default: true) */
  enabled: boolean;

  /** Channel version (optional, for npm packages) */
  version?: string;

  /** Channel description (optional) */
  description?: string;

  /** Channel author (optional) */
  author?: string;

  /** Channel-specific configuration */
  config?: Record<string, unknown>;
}

/**
 * Loaded dynamic channel entry.
 *
 * Represents a channel that has been discovered and loaded from
 * the `.disclaude/channels/` directory structure.
 */
export interface DynamicChannelEntry {
  /** Channel manifest parsed from channel.yaml */
  manifest: ChannelPluginManifest;

  /** Absolute path to the channel directory */
  directoryPath: string;

  /** Absolute path to the channel.yaml file */
  configFilePath: string;

  /** Whether the channel was successfully loaded */
  valid: boolean;

  /** Error message if loading failed */
  error?: string;
}

/**
 * Options for channel loader.
 */
export interface ChannelLoaderOptions {
  /** Base directory containing `.disclaude/channels/` (default: process.cwd()) */
  baseDir?: string;

  /** Whether to skip disabled channels (default: true) */
  skipDisabled?: boolean;
}

/**
 * Options for adding a new channel.
 */
export interface AddChannelOptions {
  /** Human-readable channel name (defaults to channelId if not provided) */
  name?: string;

  /** Channel-specific configuration key-value pairs */
  config?: Record<string, unknown>;

  /** Channel description */
  description?: string;

  /** Channel author */
  author?: string;

  /** Channel version */
  version?: string;

  /** Whether to enable the channel immediately (default: true) */
  enabled?: boolean;
}

/**
 * Result of listing channels.
 */
export interface ChannelListResult {
  /** List of discovered channels */
  channels: DynamicChannelEntry[];

  /** Total number of channels found */
  total: number;

  /** Number of enabled channels */
  enabled: number;

  /** Number of disabled channels */
  disabled: number;

  /** Number of channels with invalid configuration */
  invalid: number;
}

/**
 * Valid channel ID pattern.
 * Prevents path traversal and directory escape attacks.
 */
export const SAFE_CHANNEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_\-]*$/;

/**
 * Reserved channel IDs that cannot be used for dynamic channels.
 */
export const RESERVED_CHANNEL_IDS = ['.', '..', 'templates', '_shared'];
