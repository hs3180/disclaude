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
 * MCP tools can have prefixed names like "feishu-context-mcp__send_user_feedback".
 * This function extracts the base tool name after the "__" separator.
 *
 * @param toolName - The full tool name (possibly prefixed)
 * @returns The base tool name, or empty string if input is falsy
 *
 * @example
 * parseBaseToolName("feishu-context-mcp__send_user_feedback") // "send_user_feedback"
 * parseBaseToolName("task_done") // "task_done"
 * parseBaseToolName("") // ""
 */
export function parseBaseToolName(toolName: string): string {
  if (!toolName) return '';
  return toolName.includes('__')
    ? toolName.split('__').pop() || toolName
    : toolName;
}

/**
 * Check if a message represents a task_done tool call.
 *
 * @param msg - The agent message to check
 * @returns true if the message is a task_done tool call
 */
export function isTaskDoneTool(msg: AgentMessage): boolean {
  return msg.messageType === 'tool_use' &&
    parseBaseToolName(msg.metadata?.toolName || '') === 'task_done';
}

/**
 * Check if a message represents a send_user_feedback tool call.
 *
 * @param msg - The agent message to check
 * @returns true if the message is a send_user_feedback tool call
 */
export function isUserFeedbackTool(msg: AgentMessage): boolean {
  return msg.messageType === 'tool_use' &&
    parseBaseToolName(msg.metadata?.toolName || '') === 'send_user_feedback';
}
