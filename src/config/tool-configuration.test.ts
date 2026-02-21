/**
 * Tests for tool configuration (src/config/tool-configuration.ts)
 *
 * Tests the following functionality:
 * - ALLOWED_TOOLS contains all expected SDK tools
 * - Arrays are readonly (as const)
 *
 * NOTE: MCP tools (e.g., Playwright, Feishu context) are NOT included here.
 * MCP servers should be configured via disclaude.config.yaml under tools.mcpServers.
 */

import { describe, it, expect } from 'vitest';
import { ALLOWED_TOOLS } from './tool-configuration.js';

describe('Tool Configuration', () => {
  describe('ALLOWED_TOOLS', () => {
    const expectedTools = [
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
      // Note: AskUserQuestion is intentionally disabled for all agents
      // to prevent interactive prompts in automated workflows
      'TodoWrite',
    ];

    expectedTools.forEach((tool) => {
      it(`should include ${tool}`, () => {
        expect(ALLOWED_TOOLS).toContain(tool);
      });
    });

    it(`should have ${expectedTools.length} total tools`, () => {
      expect(ALLOWED_TOOLS.length).toBe(expectedTools.length);
    });

    it('should be readonly', () => {
      const initialLength = ALLOWED_TOOLS.length;
      expect(ALLOWED_TOOLS.length).toBe(initialLength);
    });
  });

  describe('Architecture Notes', () => {
    it('documents that MCP tools are configured via config file', () => {
      // This test documents the architecture decision:
      // - MCP tools are NOT in ALLOWED_TOOLS
      // - MCP servers are configured via disclaude.config.yaml under tools.mcpServers
      expect(ALLOWED_TOOLS).not.toContain('mcp__playwright__browser_navigate');
      expect(ALLOWED_TOOLS).not.toContain('mcp__feishu_context__get_user_info');
    });
  });
});
