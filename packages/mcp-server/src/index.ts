/**
 * @disclaude/mcp-server
 *
 * MCP Server process for disclaude.
 *
 * This package contains:
 * - MCP tools (send_message, send_file, interactive_message, ask_user)
 * - IPC client for communication with Primary Node
 * - MCP resources
 *
 * @see Issue #1042 - Separate MCP Server code to @disclaude/mcp-server
 */

// Re-export types from @disclaude/core
export type {
  // Tool result types
  SendMessageResult,
  SendFileResult,
  SendInteractiveResult,
  AskUserResult,
  // Tool option types
  AskUserOptions,
  ActionPromptMap,
  InteractiveMessageContext,
  MessageSentCallback,
  // Server types
  McpServerConfig,
  McpToolDefinition,
  McpServerCapabilities,
} from '@disclaude/core';

// Version
export const MCP_SERVER_VERSION = '0.0.1';
