/**
 * Core Module.
 *
 * Platform-agnostic core components that can be shared across
 * different channel implementations (Feishu, REST, etc.).
 *
 * Components:
 * - MessageHistoryManager: Tracks conversation history per chat
 *
 * These components are extracted from Feishu-specific implementations
 * to enable reuse across all channel types.
 *
 * Note: AttachmentManager has been moved to file-transfer/inbound/
 */

export {
  MessageHistoryManager,
  messageHistoryManager,
  type IMessageHistoryManager,
  type ChatMessage,
  type ChatHistory,
} from './message-history.js';

// Re-export AttachmentManager from new location for backward compatibility
// @deprecated - Import from '../file-transfer/inbound/index.js' instead
export {
  AttachmentManager,
  attachmentManager,
} from '../file-transfer/inbound/index.js';
