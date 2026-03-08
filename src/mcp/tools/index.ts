/**
 * Tool implementations for MCP.
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
  // Issue #631: 离线消息相关
  OfflineMessageContext,
  LeaveMessageResult,
  // Ask User tool
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
export {
  leave_message,
  registerOfflineContext,
  getOfflineContext,
  unregisterOfflineContext,
  generateFollowUpPrompt,
  cleanupExpiredOfflineContexts,
  getAllOfflineContexts,
} from './leave-message.js';

// Ask User tool (Human-in-the-Loop)
export { ask_user } from './ask-user.js';

// Study Guide Generator (NotebookLM M4)
export {
  generate_summary,
  generate_qa_pairs,
  generate_flashcards,
  generate_quiz,
  create_study_guide,
} from './study-guide-generator.js';

export type {
  SummaryOptions,
  SummaryResult,
  QAPair,
  QAGeneratorOptions,
  QAGeneratorResult,
  Flashcard,
  FlashcardGeneratorOptions,
  FlashcardGeneratorResult,
  QuizQuestion,
  QuizGeneratorOptions,
  QuizGeneratorResult,
  StudyGuideOptions,
  StudyGuideResult,
} from './study-guide-generator.js';
