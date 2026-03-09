/**
 * @disclaude/mcp-server
 *
 * MCP Server process for disclaude.
 *
 * This package contains:
 * - MCP tools types
 * - MCP utilities
 * - IPC client (to be migrated)
 * - MCP resources (to be migrated)
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

// Version
export const MCP_SERVER_VERSION = '0.0.1';
