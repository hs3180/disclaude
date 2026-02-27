/**
 * Channels module - Communication channel abstractions.
 *
 * This module provides a unified interface for different messaging platforms.
 * Each channel implements the IChannel interface, allowing the CommunicationNode
 * to work with any platform.
 *
 * Available Channels:
 * - FeishuChannel: Feishu/Lark messaging via WebSocket
 * - RestChannel: RESTful API for direct agent interaction
 *
 * Platform Adapters:
 * - IMessageSender: Platform-agnostic message sending
 * - IFileHandler: Platform-agnostic file handling
 *
 * Usage:
 * ```typescript
 * import { IChannel, FeishuChannel, RestChannel } from './channels/index.js';
 *
 * // Create a Feishu channel
 * const feishuChannel = new FeishuChannel({
 *   appId: '...',
 *   appSecret: '...',
 * });
 *
 * // Create a REST channel
 * const restChannel = new RestChannel({
 *   port: 3000,
 * });
 *
 * // Register message handler
 * channel.onMessage(async (message) => {
 *   console.log('Received:', message.content);
 * });
 *
 * // Start the channel
 * await channel.start();
 * ```
 */

// Types
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
} from './types.js';

// Base class
export { BaseChannel } from './base-channel.js';

// Channel implementations
export { FeishuChannel, type FeishuChannelConfig } from './feishu-channel.js';
export { RestChannel, type RestChannelConfig } from './rest-channel.js';

// Platform Adapters
export type {
  FileAttachment,
  FileHandlerResult,
  IMessageSender,
  IFileHandler,
  IAttachmentManager,
  IPlatformAdapter,
} from './adapters/types.js';

// Platform Implementations (re-export from platforms module)
export {
  FeishuMessageSender,
  type FeishuMessageSenderConfig,
  FeishuFileHandler,
  type FeishuFileHandlerConfig,
  buildTextContent,
} from '../platforms/feishu/index.js';
