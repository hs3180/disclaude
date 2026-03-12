/**
 * Tool implementations for MCP.
 *
 * @module mcp/tools
 *
 * @deprecated Import from '@disclaude/mcp-server' instead.
 * Issue #1042: MCP Server migration to @disclaude/mcp-server package.
 * This file is now a re-export wrapper for backward compatibility.
 */

// Re-export types
export type {
  SendMessageResult,
  SendFileResult,
  MessageSentCallback,
  ActionPromptMap,
  InteractiveMessageContext,
  SendInteractiveResult,
  AskUserOptions,
  AskUserResult,
} from '@disclaude/mcp-server';

// Re-export tools
export {
  send_message,
  setMessageSentCallback,
  getMessageSentCallback,
  send_file,
  send_interactive_message,
  registerActionPrompts,
  getActionPrompts,
  unregisterActionPrompts,
  generateInteractionPrompt,
  cleanupExpiredContexts,
  ask_user,
  reply_in_thread,
  get_threads,
  get_thread_messages,
  generate_summary,
  generate_qa_pairs,
  generate_flashcards,
  generate_quiz,
  create_study_guide,
} from '@disclaude/mcp-server';

// Re-export types for thread tools and study guide
export type {
  ReplyInThreadToolResult,
  GetThreadsToolResult,
  GetThreadMessagesToolResult,
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
} from '@disclaude/mcp-server';
