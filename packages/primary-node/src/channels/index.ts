/**
 * Channels module - Communication channel abstractions.
 *
 * This module provides a unified interface for different messaging platforms.
 * Each channel implements the IChannel interface, allowing the PrimaryNode
 * to work with any platform.
 *
 * @module channels
 */

// Re-export types from @disclaude/core
export type {
  IncomingMessage,
  OutgoingMessage,
  OutgoingContentType,
  MessageAttachment,
  ControlCommand,
  ControlCommandType,
  ControlResponse,
  ChannelStatus,
  MessageHandler,
  ControlHandler,
  IChannel,
  ChannelConfig,
  ChannelFactory,
  ChannelCapabilities,
} from '@disclaude/core';

export { DEFAULT_CHANNEL_CAPABILITIES } from '@disclaude/core';

// Base class
export { BaseChannel } from './base-channel.js';

// REST Channel (Issue #1040)
export { RestChannel, type RestChannelConfig, type IFileStorageService } from './rest-channel.js';
