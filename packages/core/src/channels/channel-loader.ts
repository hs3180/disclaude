/**
 * Channel Loader.
 *
 * Loads dynamic channel plugins from the `.disclaude/channels/` directory structure.
 * Each channel is loaded independently from its own directory, ensuring
 * isolation and eliminating race conditions.
 *
 * @module channels/channel-loader
 */

import { createLogger } from '../utils/logger.js';
import type {
  ChannelPluginManifest,
  DynamicChannelEntry,
  ChannelLoaderOptions,
} from '../types/channel-plugin.js';
import {
  listChannels,
  resolveChannelsDir,
  getChannel,
} from './channel-directory.js';

const logger = createLogger('ChannelLoader');

/**
 * Channel Loader.
 *
 * Discovers and loads dynamic channel plugins from the directory structure.
 * Each channel is stored in its own independent directory under
 * `.disclaude/channels/<channel-id>/` with an isolated `channel.yaml`.
 *
 * Key design decisions:
 * - Independent directories per channel (no shared state)
 * - Fail-safe: one channel's failure doesn't affect others
 * - Enable/disable support via channel.yaml
 * - Synchronous API: all underlying operations are sync (fs.existsSync, etc.)
 *
 * @example
 * ```typescript
 * const loader = new ChannelLoader({ baseDir: '/path/to/project' });
 *
 * // Load all enabled channels
 * const channels = loader.load();
 * for (const entry of channels) {
 *   console.log(`Loaded: ${entry.manifest.id} - ${entry.manifest.name}`);
 * }
 *
 * // Load a specific channel
 * const wechat = loader.loadOne('wechat');
 * ```
 */
export class ChannelLoader {
  private readonly baseDir: string;
  private readonly skipDisabled: boolean;

  constructor(options?: ChannelLoaderOptions) {
    this.baseDir = options?.baseDir || process.cwd();
    this.skipDisabled = options?.skipDisabled !== false;
  }

  /**
   * Get the channels directory path.
   *
   * @returns Absolute path to `.disclaude/channels/`
   */
  getChannelsDir(): string {
    return resolveChannelsDir(this.baseDir);
  }

  /**
   * Load all dynamic channels.
   *
   * Scans the channels directory and returns all valid channel entries.
   * Channels that fail to load are returned with `valid: false` and an error message.
   *
   * @returns Array of channel entries (both valid and invalid)
   */
  load(): DynamicChannelEntry[] {
    const result = listChannels(this.baseDir);

    if (result.total === 0) {
      logger.debug({ channelsDir: this.getChannelsDir() }, 'No dynamic channels found');
      return [];
    }

    const entries: DynamicChannelEntry[] = [];

    for (const entry of result.channels) {
      // Invalid channels are always included (configuration errors should be reported)
      if (!entry.valid) {
        logger.warn(
          { channelId: entry.manifest.id, error: entry.error },
          'Channel has invalid config',
        );
        entries.push(entry);
        continue;
      }

      if (this.skipDisabled && !entry.manifest.enabled) {
        logger.debug(
          { channelId: entry.manifest.id },
          'Skipping disabled channel',
        );
        continue;
      }

      entries.push(entry);
      logger.info(
        { channelId: entry.manifest.id, module: entry.manifest.module },
        'Dynamic channel discovered',
      );
    }

    logger.info(
      { total: result.total, loaded: entries.length, enabled: result.enabled, disabled: result.disabled },
      'Channel loading complete',
    );

    return entries;
  }

  /**
   * Load a single channel by ID.
   *
   * @param channelId - Channel identifier
   * @returns Channel entry or undefined if not found
   */
  loadOne(channelId: string): DynamicChannelEntry | undefined {
    const entry = getChannel(channelId, this.baseDir);

    if (!entry) {
      logger.debug({ channelId }, 'Channel not found');
      return undefined;
    }

    // Invalid channels are always returned (configuration errors should be reported)
    if (!entry.valid) {
      logger.warn({ channelId, error: entry.error }, 'Channel has invalid config');
      return entry;
    }

    if (this.skipDisabled && !entry.manifest.enabled) {
      logger.debug({ channelId }, 'Channel is disabled');
      return undefined;
    }

    logger.info({ channelId, module: entry.manifest.module }, 'Channel loaded');
    return entry;
  }

  /**
   * Check if a channel exists.
   *
   * @param channelId - Channel identifier
   * @returns true if the channel directory and config exist
   */
  hasChannel(channelId: string): boolean {
    return getChannel(channelId, this.baseDir) !== undefined;
  }

  /**
   * Get the manifest of a channel without loading it.
   *
   * @param channelId - Channel identifier
   * @returns Channel manifest or undefined
   */
  getManifest(channelId: string): ChannelPluginManifest | undefined {
    const entry = getChannel(channelId, this.baseDir);
    return entry?.manifest;
  }
}
