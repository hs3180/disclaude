/**
 * Universal Message Format (UMF) - Re-exported from @disclaude/core.
 *
 * This module re-exports platform-independent message format types.
 *
 * @deprecated Import directly from '@disclaude/core' instead.
 *
 * @see Issue #515 - Universal Message Format + Channel Adapters (Phase 2)
 */

// Re-export all types and functions from core
export type {
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
  UniversalMessage,
  UniversalMessageMetadata,
  SendResult,
} from '@disclaude/core';

export {
  isTextContent,
  isMarkdownContent,
  isCardContent,
  isFileContent,
  isDoneContent,
  createTextMessage,
  createMarkdownMessage,
  createCardMessage,
  createDoneMessage,
} from '@disclaude/core';
