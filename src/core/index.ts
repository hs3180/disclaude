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
 */

export {
  MessageHistoryManager,
  messageHistoryManager,
  type IMessageHistoryManager,
  type ChatMessage,
  type ChatHistory,
} from './message-history.js';
