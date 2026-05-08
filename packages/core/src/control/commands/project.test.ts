/**
 * Tests for /project command handler.
 *
 * @see Issue #3335 (Project state persistence and admin commands)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ControlCommand } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';
import { handleProject } from './project.js';
import { ProjectManager } from '../../project/project-manager.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function createMockContext(overrides?: Partial<ControlHandlerContext>): ControlHandlerContext {
  return {
    agentPool: {
      reset: vi.fn(),
      stop: vi.fn(),
    },
    node: {
      nodeId: 'test-node',
      getDebugGroup: vi.fn().mockReturnValue(null),
      setDebugGroup: vi.fn(),
      clearDebugGroup: vi.fn().mockReturnValue(null),
    },
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    } as any,
    ...overrides,
  };
}

function createCommand(subcommand: string, args: string[] = [], chatId = 'oc_test123'): ControlCommand {
  return {
    type: 'project',
    chatId,
    data: { args: [subcommand, ...args] },
  };
}

/**
 * Helper to resolve the CommandHandler result (sync or async).
 */
async function invoke(
  command: ControlCommand,
  context: ControlHandlerContext,
) {
  return await handleProject(command, context);
}

describe('handleProject', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'project-cmd-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('without ProjectManager', () => {
    it('should return error for list when projectManager not available', async () => {
      const context = createMockContext();
      const result = await invoke(createCommand('list'), context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('ProjectManager 未初始化');
    });

    it('should return error for status when projectManager not available', async () => {
      const context = createMockContext();
      const result = await invoke(createCommand('status'), context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('ProjectManager 未初始化');
    });
  });

  describe('/project list', () => {
    it('should show empty message when no projects exist', async () => {
      const pm = new ProjectManager({
        workspaceDir: tempDir,
        packageDir: tempDir,
      });
      const context = createMockContext({ projectManager: pm });
      const result = await invoke(createCommand('list'), context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('暂无项目模板或实例');
    });

    it('should list project instances', async () => {
      const pm = new ProjectManager({
        workspaceDir: tempDir,
        packageDir: tempDir,
        templatesConfig: {
          research: { displayName: '研究模式' },
        },
      });

      // Create an instance
      pm.create('oc_chat1', 'research', 'my-research');

      const context = createMockContext({ projectManager: pm });
      const result = await invoke(createCommand('list'), context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('可用模板');
      expect(result.message).toContain('research');
      expect(result.message).toContain('活跃实例');
      expect(result.message).toContain('my-research');
    });

    it('should support "ls" alias', async () => {
      const pm = new ProjectManager({
        workspaceDir: tempDir,
        packageDir: tempDir,
      });
      const context = createMockContext({ projectManager: pm });
      const result = await invoke(createCommand('ls'), context);

      expect(result.success).toBe(true);
    });
  });

  describe('/project status', () => {
    it('should show default project when no instance bound', async () => {
      const pm = new ProjectManager({
        workspaceDir: tempDir,
        packageDir: tempDir,
      });
      const context = createMockContext({ projectManager: pm });
      const result = await invoke(createCommand('status'), context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('default');
      expect(result.message).toContain('工作目录');
    });

    it('should show current project when instance is bound', async () => {
      const pm = new ProjectManager({
        workspaceDir: tempDir,
        packageDir: tempDir,
        templatesConfig: {
          research: { displayName: '研究模式' },
        },
      });

      pm.create('oc_chat1', 'research', 'my-research');

      const context = createMockContext({ projectManager: pm });
      const result = await invoke(createCommand('status', [], 'oc_chat1'), context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('my-research');
      expect(result.message).toContain('← 当前');
    });

    it('should support "info" alias', async () => {
      const pm = new ProjectManager({
        workspaceDir: tempDir,
        packageDir: tempDir,
      });
      const context = createMockContext({ projectManager: pm });
      const result = await invoke(createCommand('info'), context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('项目状态');
    });
  });

  describe('/project stop', () => {
    it('should return error when no instance name provided', async () => {
      const pm = new ProjectManager({
        workspaceDir: tempDir,
        packageDir: tempDir,
      });
      const context = createMockContext({ projectManager: pm });
      const result = await invoke(createCommand('stop'), context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('用法');
    });

    it('should return error when instance not found', async () => {
      const pm = new ProjectManager({
        workspaceDir: tempDir,
        packageDir: tempDir,
      });
      const context = createMockContext({ projectManager: pm });
      const result = await invoke(createCommand('stop', ['nonexistent']), context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('不存在');
    });

    it('should reset agent for all bound chats', async () => {
      const pm = new ProjectManager({
        workspaceDir: tempDir,
        packageDir: tempDir,
        templatesConfig: {
          research: { displayName: '研究模式' },
        },
      });

      pm.create('oc_chat1', 'research', 'my-research');

      const mockReset = vi.fn();
      const context = createMockContext({
        projectManager: pm,
        agentPool: {
          reset: mockReset,
          stop: vi.fn(),
        },
      });

      const result = await invoke(createCommand('stop', ['my-research']), context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('已停止项目实例');
      expect(mockReset).toHaveBeenCalledWith('oc_chat1');
    });

    it('should support "dispose" alias', async () => {
      const pm = new ProjectManager({
        workspaceDir: tempDir,
        packageDir: tempDir,
        templatesConfig: {
          research: { displayName: '研究模式' },
        },
      });

      pm.create('oc_chat1', 'research', 'my-research');

      const context = createMockContext({ projectManager: pm });
      const result = await invoke(createCommand('dispose', ['my-research']), context);

      expect(result.success).toBe(true);
    });
  });

  describe('/project trigger', () => {
    it('should return error when no instance name provided', async () => {
      const context = createMockContext();
      const result = await invoke(createCommand('trigger'), context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('用法');
    });

    it('should explain NonUserMessage dependency', async () => {
      const context = createMockContext();
      const result = await invoke(createCommand('trigger', ['my-research']), context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('NonUserMessage');
      expect(result.error).toContain('#3331');
    });

    it('should support "run" alias', async () => {
      const context = createMockContext();
      const result = await invoke(createCommand('run', ['my-research']), context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('NonUserMessage');
    });
  });

  describe('unknown subcommand', () => {
    it('should show help message for unknown subcommand', async () => {
      const context = createMockContext();
      const result = await invoke(createCommand('unknown'), context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('未知子命令');
      expect(result.error).toContain('/project list');
      expect(result.error).toContain('/project status');
      expect(result.error).toContain('/project stop');
      expect(result.error).toContain('/project trigger');
    });
  });
});
