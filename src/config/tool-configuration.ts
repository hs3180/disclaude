/**
 * Tool configuration for Claude Agent SDK.
 *
 * This module defines the allowed tools and agent subagents for SDK integration.
 */

/**
 * Core SDK tools that are always enabled
 */
export const CORE_TOOLS = [
  'Skill',
  'WebSearch',
  'Task',
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
] as const;

/**
 * Playwright MCP browser automation tools
 */
export const PLAYWRIGHT_TOOLS = [
  'mcp__playwright__browser_navigate',
  'mcp__playwright__browser_click',
  'mcp__playwright__browser_snapshot',
  'mcp__playwright__browser_run_code',
  'mcp__playwright__browser_close',
  'mcp__playwright__browser_type',
  'mcp__playwright__browser_press_key',
  'mcp__playwright__browser_hover',
  'mcp__playwright__browser_tabs',
  'mcp__playwright__browser_take_screenshot',
  'mcp__playwright__browser_wait_for',
  'mcp__playwright__browser_evaluate',
  'mcp__playwright__browser_fill_form',
  'mcp__playwright__browser_select_option',
  'mcp__playwright__browser_drag',
  'mcp__playwright__browser_handle_dialog',
  'mcp__playwright__browser_network_requests',
  'mcp__playwright__browser_console_messages',
  'mcp__playwright__browser_install',
] as const;

/**
 * All allowed tools for SDK
 */
export const ALLOWED_TOOLS = [...CORE_TOOLS, ...PLAYWRIGHT_TOOLS];

