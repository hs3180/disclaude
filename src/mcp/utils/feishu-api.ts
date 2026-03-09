/**
 * Feishu API utilities for sending messages and thread operations.
 *
 * @module mcp/utils/feishu-api
 *
 * @deprecated Import from @disclaude/mcp-server instead.
 * This file re-exports from @disclaude/mcp-server for backward compatibility.
 */

export {
  sendMessageToFeishu,
  replyInThread,
  getThreads,
  getThreadMessages,
} from '@disclaude/mcp-server';

export type {
  SendMessageResult as FeishuSendMessageResult,
  ReplyInThreadResult,
  ThreadItem,
  GetThreadsResult,
  ThreadMessageItem,
  GetThreadMessagesResult,
} from '@disclaude/mcp-server';
