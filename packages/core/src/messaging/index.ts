/**
 * Messaging types module.
 *
 * Re-exports Universal Message Format types for use by other packages.
 */

// Universal Message Format (Issue #515 Phase 2)
export type {
  // Content types
  TextContent,
  MarkdownContent,
  CardContent,
  FileContent,
  DoneContent,
  CardSection,
  CardAction,
  CardSectionType,
  CardActionType,
  MessageContent,
  // Message types
  UniversalMessage,
  UniversalMessageMetadata,
  SendResult,
} from './universal-message.js';

export {
  // Type Guards
  isTextContent,
  isMarkdownContent,
  isCardContent,
  isFileContent,
  isDoneContent,
  // Helpers
  createTextMessage,
  createMarkdownMessage,
  createCardMessage,
  createDoneMessage,
} from './universal-message.js';

// A2A Messaging (Issue #3334: Agent-to-Agent task delegation)
export type {
  A2ATask,
  A2APriority,
  A2ATaskStatus,
  EnqueueTaskParams,
  EnqueueTaskResult,
  A2ARateLimitConfig,
  A2AProjectResolver,
  A2AAgentPool,
} from './a2a-types.js';

export {
  isValidA2APriority,
  generateTaskId,
  DEFAULT_A2A_RATE_LIMIT,
} from './a2a-types.js';

export {
  A2AQueue,
  type A2ADeliveryCallback,
  type A2AQueueConfig,
} from './a2a-queue.js';
