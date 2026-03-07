/**
 * Tool implementations for MCP.
 *
 * @module mcp/tools
 */

export type {
  SendMessageResult,
  SendFileResult,
  WaitForInteractionResult,
  MessageSentCallback,
  PendingInteraction,
  ActionPromptMap,
  InteractiveMessageContext,
  SendInteractiveResult,
} from './types.js';

export { send_message, setMessageSentCallback, getMessageSentCallback } from './send-message.js';
export { send_file } from './send-file.js';
export { wait_for_interaction, resolvePendingInteraction } from './card-interaction.js';
export {
  send_interactive_message,
  registerActionPrompts,
  getActionPrompts,
  unregisterActionPrompts,
  generateInteractionPrompt,
  cleanupExpiredContexts,
} from './interactive-message.js';

// Discussion Chat Creation (Issue #393)
export { create_discussion_chat } from './create-discussion-chat.js';
export type { CreateDiscussionChatResult } from './create-discussion-chat.js';

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
