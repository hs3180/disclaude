/**
 * Core Module.
 *
 * Platform-agnostic core components that can be shared across
 * different channel implementations (Feishu, REST, etc.).
 *
 * Components:
 * - MessageHistoryManager: Tracks conversation history per chat
 * - AttachmentManager: Manages pending file attachments per chat
 * - TaskFlowOrchestrator: Manages dialogue execution phase
 * - MessageLogger: Persistent message logging to chat-specific MD files
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

export {
  AttachmentManager,
  attachmentManager,
} from './attachment-manager.js';

export {
  TaskFlowOrchestrator,
  type MessageCallbacks,
} from './task-flow-orchestrator.js';

export {
  MessageLogger,
  messageLogger,
} from './message-logger.js';
