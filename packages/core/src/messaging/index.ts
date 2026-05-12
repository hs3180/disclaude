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

// Input Message Router (Issue #3329 Phase 1 — Unified Agent Input Abstraction)
export {
  InputMessageRouter,
  type InputMessageRouterConfig,
  type ProjectChatIdResolver,
  type RouteResult,
  type RouteFallback,
  type InputRouteResult,
} from './input-message-router.js';
