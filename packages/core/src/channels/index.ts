/**
 * Channels module.
 *
 * Provides base classes and utilities for implementing communication channels.
 * Includes dynamic plugin registration system for runtime-discoverable channels.
 *
 * @see Issue #1422
 */

export { BaseChannel } from './base-channel.js';

// Dynamic channel plugin system (Issue #1422)
export {
  ChannelRegistry,
  isChannelPlugin,
  isChannelFactory,
  type ChannelPlugin,
  type ChannelFactory,
} from './channel-plugin.js';

export {
  ChannelLoader,
  findDisclaudeDir,
  findDynamicChannelsFile,
  readDynamicChannelsFile,
  writeDynamicChannel,
  removeDynamicChannel,
  DYNAMIC_CHANNELS_FILENAME,
  type DynamicChannelEntry,
  type DynamicChannelsFile,
} from './channel-loader.js';
