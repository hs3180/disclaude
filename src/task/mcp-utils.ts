/**
 * MCP (Model Context Protocol) utility functions.
 *
 * Provides common utilities for handling MCP tool calls and messages,
 * reducing code duplication across dialogue and iteration bridges.
 */

import type { AgentMessage } from '../types/agent.js';

/**
 * Parse the base tool name from an MCP tool name.
 *
 * MCP tools can have prefixed names like "context-mcp__send_message".
 * This function extracts the base tool name after the "__" separator.
 *
 * @param toolName - The full tool name (possibly prefixed)
 * @returns The base tool name, or empty string if input is falsy
 *
 * @example
 * parseBaseToolName("context-mcp__send_message") // "send_message"
 * parseBaseToolName("") // ""
 */
export function parseBaseToolName(toolName: string): string {
  if (!toolName) {
    return '';
  }
  return toolName.includes('__')
    ? toolName.split('__').pop() || toolName
    : toolName;
}

/**
 * Check if a message represents a send_message tool call.
 *
 * @param msg - The agent message to check
 * @returns true if the message is a send_message tool call
 */
export function isUserFeedbackTool(msg: AgentMessage): boolean {
  return msg.messageType === 'tool_use' &&
    parseBaseToolName(msg.metadata?.toolName || '') === 'send_message';
}
