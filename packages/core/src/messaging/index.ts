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

// Unified Message Types (Issue #3331 Phase 1 — RFC #3329)
export type {
  // Source types
  MessageSource,
  MessagePriority,
  SystemTrigger,
  ModelTier as MessageModelTier,
  // Message types
  Message,
  UserMessage,
  SystemMessage,
  AgentMessage,
  NonUserMessage,
  // Attachment type
  MessageAttachment,
} from './message-types.js';

export {
  // Type Guards
  isUserMessage,
  isSystemMessage,
  isAgentMessage,
  // Helpers
  generateMessageId,
  createUserMessage,
  createSystemMessage,
  createAgentMessage,
} from './message-types.js';

// MessageRouter (Issue #3331 Phase 1)
export {
  MessageRouter,
} from './message-router.js';

export type {
  ProjectResolver,
  ProjectResolution,
  RoutableAgent,
  RoutableAgentPool,
  MessageRouterOptions,
} from './message-router.js';
