/**
 * Tests for /research command handler.
 *
 * Issue #1709: Research Mode — Phase 1
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { handleResearch } from './research.js';
import { ResearchModeManager } from '../../modes/agent-mode.js';
import type { ControlCommand } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';

describe('handleResearch', () => {
  let tempDir: string;
  let manager: ResearchModeManager;
  let context: ControlHandlerContext;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-cmd-test-'));
    manager = new ResearchModeManager();
    context = {
      agentPool: { reset: () => {}, stop: () => false },
      node: {
        nodeId: 'test-node',
        getExecNodes: () => [],
        getDebugGroup: () => null,
        clearDebugGroup: () => {},
      },
      researchMode: manager,
    };
  });

  afterEach(async () => {
    manager.clearAll();
    // Clean up research workspaces created during tests
    try {
      const researchDir = path.join(tempDir, 'research');
      await fs.rm(researchDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function createCommand(chatId: string, args?: string | string[]): ControlCommand {
    return {
      type: 'research',
      chatId,
      data: args !== undefined ? { args } : undefined,
    };
  }

  describe('without research mode manager', () => {
    it('should return error when research mode is not available', async () => {
      const noResearchContext: ControlHandlerContext = {
        ...context,
        researchMode: undefined,
      };

      const result = await handleResearch(
        createCommand('chat-1', 'Test Topic'),
        noResearchContext
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('not available');
    });
  });

  describe('entering research mode', () => {
    it('should enter research mode with a topic', async () => {
      const result = await handleResearch(
        createCommand('chat-1', 'AI Safety'),
        context
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Research 模式');
      expect(result.message).toContain('AI Safety');
      expect(manager.isResearchMode('chat-1')).toBe(true);
    });

    it('should handle empty topic gracefully', async () => {
      const result = await handleResearch(
        createCommand('chat-1', ''),
        context
      );

      // Empty topic should show status, not error
      expect(result.success).toBe(true);
    });
  });

  describe('exiting research mode', () => {
    it('should exit research mode with "off" argument', async () => {
      // Enter first
      await manager.enterResearchMode('chat-1', {
        topic: 'Test',
        workspaceBaseDir: tempDir,
      });

      const result = await handleResearch(
        createCommand('chat-1', 'off'),
        context
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('退出');
      expect(manager.isResearchMode('chat-1')).toBe(false);
    });

    it('should handle "off" when not in research mode', async () => {
      const result = await handleResearch(
        createCommand('chat-1', 'off'),
        context
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('不在');
    });
  });

  describe('showing status', () => {
    it('should show active research mode status', async () => {
      await manager.enterResearchMode('chat-1', {
        topic: 'Test Topic',
        workspaceBaseDir: tempDir,
      });

      const result = await handleResearch(
        createCommand('chat-1'),
        context
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('已激活');
      expect(result.message).toContain('Test Topic');
    });

    it('should show usage when not in research mode and no args', async () => {
      const result = await handleResearch(
        createCommand('chat-1'),
        context
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('用法');
    });
  });
});
