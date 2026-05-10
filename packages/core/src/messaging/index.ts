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
