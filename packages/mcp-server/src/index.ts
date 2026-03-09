/**
 * @disclaude/mcp-server
 *
 * MCP Server process for disclaude.
 *
 * This package contains:
 * - MCP tools types
 * - MCP utilities
 * - IPC client (for cross-process communication with Primary Node)
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

// IPC Client (Issue #1042: Migrated from src/ipc/)
export {
  UnixSocketIpcClient,
  getIpcClient,
  resetIpcClient,
  type IpcAvailabilityStatus,
  type IpcUnavailableReason,
} from './ipc-client/index.js';

// Version
export const MCP_SERVER_VERSION = '0.0.1';
