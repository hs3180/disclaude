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

// NonUserMessage types and router (Issue #3331)
export type {
  NonUserMessage,
  NonUserMessageType,
  NonUserMessagePriority,
  RouteResult,
} from './non-user-message.js';

export {
  RouteError,
} from './non-user-message.js';

export {
  NonUserMessageRouter,
  StaticProjectResolver,
  type NonUserMessageRouterConfig,
  type ProjectResolver,
} from './non-user-message-router.js';

// A2A messaging (Issue #3334)
export type {
  A2AConfig,
  A2AEnqueueResult,
  A2ARateLimitConfig,
  EnqueueTaskParams,
} from './a2a-types.js';

export {
  DEFAULT_A2A_RATE_LIMIT,
} from './a2a-types.js';

export {
  A2ARateLimiter,
} from './a2a-rate-limiter.js';

export {
  createA2AEnqueueHandler,
  ENQUEUE_TASK_DESCRIPTION,
  ENQUEUE_TASK_PARAMETERS,
} from './a2a-enqueue-tool.js';
