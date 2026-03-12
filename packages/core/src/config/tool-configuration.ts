/**
 * Tool configuration for Claude Agent SDK.
 *
 * This module defines the allowed tools and agent subagents for SDK integration.
 *
 * NOTE: MCP tools (e.g., Playwright, Feishu context) are NOT included here.
 * MCP servers should be configured via disclaude.config.yaml under tools.mcpServers.
 */

/**
 * All default SDK tools enabled for agents except browser/OCR MCP tools
 * which are configured separately by agents that need them.
 * (e.g., Playwright, Feishu context).
 */
export const ALLOWED_TOOLS = [
  // Skills & Agents
  'Skill',
  'Task',
  'ExitPlanMode',

  // Web & Network
  'WebSearch',
  'WebFetch',

  // File Operations
  'Read',
  'Write',
  'Edit',

  // Search & Navigation
  'Glob',
  'Grep',
  'LSP',

  // Execution
  'Bash',

  // Jupyter Notebooks
  'NotebookEdit',

  // User Interaction
  'TodoWrite',
] as const;

/**
 * Type for allowed tool names.
 */
export type AllowedToolName = (typeof ALLOWED_TOOLS)[number];
