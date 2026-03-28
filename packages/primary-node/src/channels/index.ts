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

// WeChat Channel (Issue #1473 - MVP: Auth + Send Message)
export { WeChatChannel, type WeChatChannelConfig } from './wechat/index.js';

// Wired Channel Descriptors (Issue #1594 Phase 2)
// Note: WECHAT_WIRED_DESCRIPTOR is exported for dynamic registration use only.
// It is NOT included in BUILTIN_WIRED_DESCRIPTORS (Issue #1638: WeChat only
// supports dynamic registration, not config-driven creation).
export {
  REST_WIRED_DESCRIPTOR,
  FEISHU_WIRED_DESCRIPTOR,
  WECHAT_WIRED_DESCRIPTOR,
} from './wired-descriptors.js';
