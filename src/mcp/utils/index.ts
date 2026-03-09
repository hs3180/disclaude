/**
 * Utility functions for Feishu MCP.
 *
 * @module mcp/utils
 *
 * @deprecated Import from @disclaude/mcp-server instead.
 * This file re-exports from @disclaude/mcp-server for backward compatibility.
 */

export { isValidFeishuCard, getCardValidationError } from '@disclaude/mcp-server';
export {
  sendMessageToFeishu,
  replyInThread,
  getThreads,
  getThreadMessages,
} from '@disclaude/mcp-server';
