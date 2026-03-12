/**
 * Context MCP Tools - In-process tool implementation.
 *
 * @module mcp/feishu-context-mcp
 *
 * @deprecated Import from '@disclaude/mcp-server' instead.
 * Issue #1042: MCP Server migration to @disclaude/mcp-server package.
 * This file is now a re-export wrapper for backward compatibility.
 */

// Re-export everything from @disclaude/mcp-server
export {
  feishuContextTools,
  feishuToolDefinitions,
  feishuSdkTools,
  createFeishuSdkMcpServer,
  send_message,
  send_file,
  send_interactive_message,
  setMessageSentCallback,
  generateInteractionPrompt,
  getActionPrompts,
  startIpcServer,
  stopIpcServer,
  isIpcServerRunning,
  registerFeishuHandlers,
  unregisterFeishuHandlers,
  ask_user,
} from '@disclaude/mcp-server';

export type { MessageSentCallback } from '@disclaude/mcp-server';
