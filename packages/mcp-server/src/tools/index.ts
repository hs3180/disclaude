/**
 * MCP tool implementations.
 *
 * @module mcp-server/tools
 */

// Types
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

// Send Message
export {
  send_message,
  setMessageSentCallback,
  getMessageSentCallback,
  getWorkspaceDir,
  getFeishuCredentials,
} from './send-message.js';

// Send File
export { send_file } from './send-file.js';

// Interactive Message
export {
  send_interactive_message,
  registerActionPrompts,
  getActionPrompts,
  unregisterActionPrompts,
  generateInteractionPrompt,
  cleanupExpiredContexts,
  startIpcServer,
  stopIpcServer,
  isIpcServerRunning,
  getIpcServerSocketPath,
  registerFeishuHandlers,
  unregisterFeishuHandlers,
} from './interactive-message.js';

// Ask User
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
