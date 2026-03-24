/**
 * Channels module.
 *
 * Provides base classes and utilities for implementing communication channels.
 * Includes dynamic channel registration via directory-based discovery.
 */

export { BaseChannel } from './base-channel.js';

// Dynamic channel registration (Issue #1422)
export {
  ChannelLoader,
} from './channel-loader.js';

export {
  addChannel,
  removeChannel,
  setChannelEnabled,
  getChannel,
  listChannels,
  resolveChannelsDir,
  resolveChannelDir,
  resolveChannelConfigPath,
  validateChannelId,
  parseChannelConfig,
  serializeChannelConfig,
} from './channel-directory.js';
