/**
 * Tests for /research command handler (packages/core/src/control/commands/research.ts)
 */

import { describe, it, expect, vi } from 'vitest';
import { handleResearch } from './research.js';
import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';

/** Create a test command */
function createCommand(args?: string | string[], chatId = 'test-chat-id'): ControlCommand {
  return {
    type: 'research',
    chatId,
    data: args !== undefined ? { args } : undefined,
  };
}

/** Create a mock research mode manager */
function createMockResearchMode() {
  return {
    activateResearch: vi.fn().mockReturnValue({
      cwd: '/workspace/research/test-project',
      created: true,
      claudeMdWritten: true,
    }),
    deactivateResearch: vi.fn().mockReturnValue('test-project'),
    listResearchProjects: vi.fn().mockReturnValue(['project-a', 'project-b']),
    isActive: vi.fn().mockReturnValue(false),
    getCurrentProject: vi.fn().mockReturnValue(null),
    getEffectiveCwd: vi.fn().mockReturnValue('/workspace'),
  };
}

/** Create a test handler context */
function createContext(overrides?: Partial<ControlHandlerContext>): ControlHandlerContext {
  return {
    agentPool: { reset: vi.fn(), stop: vi.fn() },
    node: {
      nodeId: 'test-node',
      getExecNodes: vi.fn().mockReturnValue([]),
      getDebugGroup: vi.fn().mockReturnValue(null),
      clearDebugGroup: vi.fn(),
    },
    researchMode: createMockResearchMode(),
    ...overrides,
  };
}

describe('handleResearch', () => {
  describe('researchMode not available', () => {
    it('should return failure when researchMode is undefined', () => {
      const command = createCommand();
      const mockWarn = vi.fn();
      const context = createContext({
        researchMode: undefined,
        logger: { warn: mockWarn } as unknown as ControlHandlerContext['logger'],
      });

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('不可用');
      expect(mockWarn).toHaveBeenCalledWith(
        { chatId: 'test-chat-id' },
        '/research command received but researchMode is not configured'
      );
    });
  });

  describe('status (no args)', () => {
    it('should show inactive status when not in research mode', () => {
      const command = createCommand();
      const context = createContext();

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('未激活');
    });

    it('should show active status with project name when in research mode', () => {
      const command = createCommand();
      const context = createContext();
      const { researchMode } = context;
      if (!researchMode) throw new Error('researchMode is required');
      researchMode.isActive = vi.fn().mockReturnValue(true);
      researchMode.getCurrentProject = vi.fn().mockReturnValue('my-project');
      researchMode.getEffectiveCwd = vi.fn().mockReturnValue('/workspace/research/my-project');

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已激活');
      expect(result.message).toContain('my-project');
    });

    it('should show status for empty string args', () => {
      const command = createCommand('');
      const context = createContext();

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('未激活');
    });
  });

  describe('enter subcommand', () => {
    it('should activate research mode with project name', () => {
      const command = createCommand('enter my-project');
      const context = createContext();
      const { researchMode } = context;
      if (!researchMode) throw new Error('researchMode is required');

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已进入');
      expect(result.message).toContain('my-project');
      expect(researchMode.activateResearch).toHaveBeenCalledWith('my-project');
    });

    it('should show creation status when project is new', () => {
      const command = createCommand('enter new-proj');
      const context = createContext();
      const { researchMode } = context;
      if (!researchMode) throw new Error('researchMode is required');
      researchMode.activateResearch = vi.fn().mockReturnValue({
        cwd: '/workspace/research/new-proj',
        created: true,
        claudeMdWritten: true,
      });

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('项目目录已创建');
      expect(result.message).toContain('默认 CLAUDE.md 已写入');
    });

    it('should not show creation status for existing project', () => {
      const command = createCommand('enter existing-proj');
      const context = createContext();
      const { researchMode } = context;
      if (!researchMode) throw new Error('researchMode is required');
      researchMode.activateResearch = vi.fn().mockReturnValue({
        cwd: '/workspace/research/existing-proj',
        created: false,
        claudeMdWritten: false,
      });

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).not.toContain('项目目录已创建');
    });

    it('should reject enter without project name', () => {
      const command = createCommand('enter');
      const context = createContext();

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('请指定项目名称');
    });

    it('should handle multi-word project names', () => {
      const command = createCommand('enter my research project');
      const context = createContext();
      const { researchMode } = context;
      if (!researchMode) throw new Error('researchMode is required');

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(researchMode.activateResearch).toHaveBeenCalledWith('my research project');
    });

    it('should handle activation errors gracefully', () => {
      const command = createCommand('enter ../bad-project');
      const context = createContext();
      const { researchMode } = context;
      if (!researchMode) throw new Error('researchMode is required');
      researchMode.activateResearch = vi.fn().mockImplementation(() => {
        throw new Error('Invalid project name');
      });

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid project name');
    });

    it('should handle Feishu array format args', () => {
      const command = createCommand(['enter', 'feishu-project']);
      const context = createContext();
      const { researchMode } = context;
      if (!researchMode) throw new Error('researchMode is required');

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      // When args is an array, all elements are joined with spaces
      expect(researchMode.activateResearch).toHaveBeenCalledWith('feishu-project');
    });
  });

  describe('exit subcommand', () => {
    it('should deactivate research mode', () => {
      const command = createCommand('exit');
      const context = createContext();
      const { researchMode } = context;
      if (!researchMode) throw new Error('researchMode is required');

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已退出');
      expect(result.message).toContain('test-project');
      expect(researchMode.deactivateResearch).toHaveBeenCalled();
    });

    it('should report when not in research mode', () => {
      const command = createCommand('exit');
      const context = createContext();
      const { researchMode } = context;
      if (!researchMode) throw new Error('researchMode is required');
      researchMode.deactivateResearch = vi.fn().mockReturnValue(null);

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('当前未激活');
    });
  });

  describe('list subcommand', () => {
    it('should list existing research projects', () => {
      const command = createCommand('list');
      const context = createContext();

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('project-a');
      expect(result.message).toContain('project-b');
      expect(result.message).toContain('2');
    });

    it('should show empty state when no projects exist', () => {
      const command = createCommand('list');
      const context = createContext();
      const { researchMode } = context;
      if (!researchMode) throw new Error('researchMode is required');
      researchMode.listResearchProjects = vi.fn().mockReturnValue([]);

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('暂无研究项目');
    });
  });

  describe('unknown subcommand', () => {
    it('should reject unknown subcommand', () => {
      const command = createCommand('unknown');
      const context = createContext();

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('未知子命令');
    });

    it('should show usage hint in error message', () => {
      const command = createCommand('random');
      const context = createContext();

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.message).toContain('enter');
      expect(result.message).toContain('exit');
      expect(result.message).toContain('list');
    });
  });
});
