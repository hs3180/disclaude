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
export { ask_user } from './ask-user.js';

// Thread Tools (Issue #873: Topic group extension)
export {
  reply_in_thread,
  get_threads,
  get_thread_messages,
} from './thread-tools.js';
export type {
  ReplyInThreadToolResult,
  GetThreadsToolResult,
  GetThreadMessagesToolResult,
} from './thread-tools.js';

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

// Spawn Subagents (Issue #897: Master-Workers Multi-Agent Collaboration)
export {
  spawn_subagents,
  setSpawnSubagentsCallbacks,
  getSpawnSubagentsCallbacks,
  disposeSpawnManager,
} from './spawn-subagents.js';
export type {
  SpawnSubagentsResult,
  SpawnSubagentsOptions,
  SubagentResult,
  SubagentTask,
} from './spawn-subagents.js';
