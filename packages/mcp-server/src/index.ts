/**
 * @disclaude/mcp-server
 *
 * MCP Server process for disclaude.
 *
 * This package provides:
 * - MCP tools for agent communication
 * - IPC client for Primary Node communication
 * - MCP resources
 *
 * @see Issue #1042 - Separate MCP Server code to @disclaude/mcp-server
 */

// Re-export types from @disclaude/core
export type {
  // Message types
  SendMessageResult,
  SendFileResult,
  MessageSentCallback,
  SendInteractiveResult,
  AskUserResult,
  AskUserOption,
  StudyGuideOptions,
  StudyGuideResult,

  // Interactive message types
  ActionPromptMap,
  InteractiveMessageContext,

  // MCP tool types
  McpToolDefinition,
  McpToolContext,

  // Node types
  NodeType,
  BaseNodeConfig,
  McpServerConfig,
  NodeCapabilities,
} from '@disclaude/core';

export { getNodeCapabilities } from '@disclaude/core';

// Package version
export const MCP_SERVER_VERSION = '0.0.1';
