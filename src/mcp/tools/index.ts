/**
 * Tool implementations for MCP.
 *
 * Issue #1155: Consolidated tools to reduce token overhead.
 * - send_message: Unified messaging (text, card, interactive, question)
 * - send_file: File transfer
 * - create_study_guide: Study materials generation
 *
 * @module mcp/tools
 */

export type {
  SendMessageResult,
  SendFileResult,
  MessageSentCallback,
  ActionPromptMap,
  InteractiveMessageContext,
  SendInteractiveResult,
  AskUserOptions,
  AskUserResult,
} from './types.js';

export { send_message, setMessageSentCallback, getMessageSentCallback } from './send-message.js';
export { send_file } from './send-file.js';
export {
  send_interactive_message,
  registerActionPrompts,
  getActionPrompts,
  unregisterActionPrompts,
  generateInteractionPrompt,
  cleanupExpiredContexts,
} from './interactive-message.js';

// Ask User tool (Human-in-the-Loop)
// Used internally by consolidated send_message
export { ask_user } from './ask-user.js';

// Study Guide Generator (NotebookLM)
// Issue #1155: Only export create_study_guide, individual generators are internal
export { create_study_guide } from './study-guide-generator.js';

export type {
  StudyGuideOptions,
  StudyGuideResult,
} from './study-guide-generator.js';
