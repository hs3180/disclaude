/**
 * @disclaude/mcp-server
 *
 * MCP Server process for disclaude.
 *
 * This package contains:
 * - MCP tools (send_message, send_file, interactive messages, etc.)
 * - MCP tool types
 * - MCP utilities
 * - IPC client (for cross-process communication with Primary Node)
 * - MCP servers
 */

// Tool Types
export type {
  SendMessageResult,
  SendFileResult,
  MessageSentCallback,
  ActionPromptMap,
  InteractiveMessageContext,
  SendInteractiveResult,
  AskUserOptions,
  AskUserResult,
} from './tools/types.js';

// Tools - Send Message
export {
  send_message,
  setMessageSentCallback,
  getMessageSentCallback,
} from './tools/send-message.js';

// Tools - Send File
export { send_file } from './tools/send-file.js';

// Tools - Interactive Message
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
} from './tools/interactive-message.js';

// Tools - Ask User
export { ask_user } from './tools/ask-user.js';

// Tools - Thread Tools
export {
  reply_in_thread,
  get_threads,
  get_thread_messages,
} from './tools/thread-tools.js';
export type {
  ReplyInThreadToolResult,
  GetThreadsToolResult,
  GetThreadMessagesToolResult,
} from './tools/thread-tools.js';

// Tools - Study Guide Generator
export {
  generate_summary,
  generate_qa_pairs,
  generate_flashcards,
  generate_quiz,
  create_study_guide,
} from './tools/study-guide-generator.js';

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
} from './tools/study-guide-generator.js';

// Utils - Card Validator
export { isValidFeishuCard, getCardValidationError } from './utils/card-validator.js';

// Utils - Feishu API
export {
  sendMessageToFeishu,
  replyInThread,
  getThreads,
  getThreadMessages,
} from './utils/feishu-api.js';

export type {
  SendMessageResult as FeishuSendMessageResult,
  ReplyInThreadResult,
  ThreadItem,
  GetThreadsResult,
  ThreadMessageItem,
  GetThreadMessagesResult,
} from './utils/feishu-api.js';

// IPC Client (Issue #1042: Migrated from src/ipc/)
export {
  UnixSocketIpcClient,
  getIpcClient,
  resetIpcClient,
  type IpcAvailabilityStatus,
  type IpcUnavailableReason,
} from './ipc-client/index.js';

// Unified Messaging MCP (Issue #1042: Migrated from src/mcp/)
export {
  send_message as unified_send_message,
  detectChannel,
  createUnifiedMessagingMcpServer,
  unifiedMessagingToolDefinitions,
  setMessageSentCallback as unifiedSetMessageSentCallback,
  type ChannelType,
  type SendMessageResult as UnifiedSendMessageResult,
  type MessageSentCallback as UnifiedMessageSentCallback,
} from './unified-messaging-mcp.js';

// Feishu Context MCP Server (Issue #1042: Migrated from src/mcp/)
export {
  feishuContextTools,
  feishuToolDefinitions,
  feishuSdkTools,
  createFeishuSdkMcpServer,
} from './feishu-context-mcp.js';

// Version
export const MCP_SERVER_VERSION = '0.0.1';
