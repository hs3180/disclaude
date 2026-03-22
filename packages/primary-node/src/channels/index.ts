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

// Adapter types
export type {
  FileAttachment,
  FileHandlerResult,
  IMessageSender,
  IFileHandler,
  IAttachmentManager,
  IPlatformAdapter,
} from './adapters/types.js';

// Base class
export { BaseChannel } from '@disclaude/core';

// REST Channel (Issue #1040)
export { RestChannel, type RestChannelConfig, type IFileStorageService } from './rest-channel.js';

// Feishu Channel (Issue #1040 - migrated from src/channels)
export { FeishuChannel, type FeishuChannelConfig } from './feishu-channel.js';

// WeChat Channel (Issue #1406 - ilink API integration)
export { WeChatChannel, type WeChatChannelConfig } from './wechat/wechat-channel.js';
