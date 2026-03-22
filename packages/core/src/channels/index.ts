/**
 * Channels module.
 *
 * Provides base classes and utilities for implementing communication channels.
 * Supports dynamic channel registration via plugin system (Issue #1422).
 */

export { BaseChannel } from './base-channel.js';
export {
  ChannelRegistry,
  type ChannelPlugin,
  type DynamicChannelConfig,
  type ExtendedChannelsConfig,
  type ResolvedChannel,
} from './channel-plugin.js';
export {
  ChannelLoader,
  type ChannelLoadResult,
} from './channel-loader.js';
