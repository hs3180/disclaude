/**
 * Unit tests for /project control command handler.
 *
 * Issue #1916 Phase 2: Tests for project context switching command.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleProject } from './project.js';
import type { ControlHandlerContext } from '../types.js';
import type { ControlCommand } from '../../types/channel.js';
import type { ProjectResult, ProjectContextConfig, ProjectTemplate, InstanceInfo } from '../../project/types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Mock Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function createMockProjectManager(overrides?: {
  templates?: ProjectTemplate[];
  instances?: InstanceInfo[];
  active?: ProjectContextConfig;
  createResult?: ProjectResult<ProjectContextConfig>;
  useResult?: ProjectResult<ProjectContextConfig>;
  resetResult?: ProjectResult<ProjectContextConfig>;
}) {
  return {
    getActive: vi.fn().mockReturnValue(overrides?.active ?? { name: 'default', workingDir: '/workspace' }),
    create: vi.fn().mockReturnValue(
      overrides?.createResult ?? { ok: true, data: { name: 'test-project', templateName: 'research', workingDir: '/workspace/projects/test-project' } },
    ),
    use: vi.fn().mockReturnValue(
      overrides?.useResult ?? { ok: true, data: { name: 'test-project', templateName: 'research', workingDir: '/workspace/projects/test-project' } },
    ),
    reset: vi.fn().mockReturnValue(
      overrides?.resetResult ?? { ok: true, data: { name: 'default', workingDir: '/workspace' } },
    ),
    listTemplates: vi.fn().mockReturnValue(overrides?.templates ?? []),
    listInstances: vi.fn().mockReturnValue(overrides?.instances ?? []),
  };
}

function createMockContext(pmOverrides?: Parameters<typeof createMockProjectManager>[0]): ControlHandlerContext {
  return {
    agentPool: { reset: vi.fn(), stop: vi.fn().mockReturnValue(true) },
    node: {
      nodeId: 'node-1',
      getDebugGroup: vi.fn().mockReturnValue(null),
      setDebugGroup: vi.fn(),
      clearDebugGroup: vi.fn().mockReturnValue(null),
    },
    projectManager: createMockProjectManager(pmOverrides),
  };
}

function makeCommand(chatId: string, ...args: string[]): ControlCommand {
  return {
    type: 'project',
    chatId,
    data: { args },
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('handleProject', () => {
  describe('when ProjectManager is not initialized', () => {
    it('should return error when projectManager is missing', async () => {
      const context = createMockContext();
      delete (context as Partial<ControlHandlerContext>).projectManager;

      const result = await handleProject(makeCommand('chat-1', 'list'), context);

      expect(result.success).toBe(false);
      expect(result.message).toContain('ProjectManager 未初始化');
    });
  });

  describe('/project list', () => {
    it('should list available templates and instances', async () => {
      const context = createMockContext({
        templates: [
          { name: 'research', displayName: '研究模式', description: '专注研究' },
          { name: 'book-reader', displayName: '读书助手' },
        ],
        instances: [
          { name: 'my-research', templateName: 'research', chatIds: ['chat-1'], workingDir: '/workspace/projects/my-research', createdAt: '2026-01-01T00:00:00Z' },
        ],
      });

      const result = await handleProject(makeCommand('chat-1', 'list'), context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('research');
      expect(result.message).toContain('book-reader');
      expect(result.message).toContain('my-research');
    });

    it('should show empty state when no templates or instances', async () => {
      const context = createMockContext({
        templates: [],
        instances: [],
      });

      const result = await handleProject(makeCommand('chat-1', 'list'), context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('无');
    });
  });

  describe('/project create', () => {
    it('should create instance and reset session', async () => {
      const context = createMockContext();

      const result = await handleProject(makeCommand('chat-1', 'create', 'research', 'my-research'), context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('my-research');
      expect(context.projectManager!.create).toHaveBeenCalledWith('chat-1', 'research', 'my-research');
      expect(context.agentPool.reset).toHaveBeenCalledWith('chat-1');
    });

    it('should require both template and name arguments', async () => {
      const context = createMockContext();

      const result = await handleProject(makeCommand('chat-1', 'create', 'research'), context);

      expect(result.success).toBe(false);
      expect(result.message).toContain('用法');
    });

    it('should handle create failure gracefully', async () => {
      const context = createMockContext({
        createResult: { ok: false, error: '模板 "nonexistent" 不存在' },
      });

      const result = await handleProject(makeCommand('chat-1', 'create', 'nonexistent', 'test'), context);

      expect(result.success).toBe(false);
      expect(result.message).toContain('不存在');
      expect(context.agentPool.reset).not.toHaveBeenCalled();
    });
  });

  describe('/project use', () => {
    it('should bind to existing instance and reset session', async () => {
      const context = createMockContext();

      const result = await handleProject(makeCommand('chat-1', 'use', 'my-research'), context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('my-research');
      expect(context.projectManager!.use).toHaveBeenCalledWith('chat-1', 'my-research');
      expect(context.agentPool.reset).toHaveBeenCalledWith('chat-1');
    });

    it('should require name argument', async () => {
      const context = createMockContext();

      const result = await handleProject(makeCommand('chat-1', 'use'), context);

      expect(result.success).toBe(false);
      expect(result.message).toContain('用法');
    });

    it('should handle use failure gracefully', async () => {
      const context = createMockContext({
        useResult: { ok: false, error: '实例 "nonexistent" 不存在' },
      });

      const result = await handleProject(makeCommand('chat-1', 'use', 'nonexistent'), context);

      expect(result.success).toBe(false);
      expect(result.message).toContain('不存在');
      expect(context.agentPool.reset).not.toHaveBeenCalled();
    });
  });

  describe('/project info', () => {
    it('should show current project info for default', async () => {
      const context = createMockContext({
        active: { name: 'default', workingDir: '/workspace' },
      });

      const result = await handleProject(makeCommand('chat-1', 'info'), context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('default');
      expect(result.message).toContain('/workspace');
      expect(result.message).toContain('默认项目');
      expect(context.projectManager!.getActive).toHaveBeenCalledWith('chat-1');
    });

    it('should show template name for non-default project', async () => {
      const context = createMockContext({
        active: { name: 'my-research', templateName: 'research', workingDir: '/workspace/projects/my-research' },
      });

      const result = await handleProject(makeCommand('chat-1', 'info'), context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('my-research');
      expect(result.message).toContain('research');
      expect(result.message).toContain('/workspace/projects/my-research');
    });
  });

  describe('/project reset', () => {
    it('should reset to default and reset agent session', async () => {
      const context = createMockContext();

      const result = await handleProject(makeCommand('chat-1', 'reset'), context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('重置为默认');
      expect(context.projectManager!.reset).toHaveBeenCalledWith('chat-1');
      expect(context.agentPool.reset).toHaveBeenCalledWith('chat-1');
    });

    it('should handle reset failure', async () => {
      const context = createMockContext({
        resetResult: { ok: false, error: '持久化失败' },
      });

      const result = await handleProject(makeCommand('chat-1', 'reset'), context);

      expect(result.success).toBe(false);
      expect(result.message).toContain('持久化失败');
      expect(context.agentPool.reset).not.toHaveBeenCalled();
    });
  });

  describe('unknown sub-command', () => {
    it('should show usage help', async () => {
      const context = createMockContext();

      const result = await handleProject(makeCommand('chat-1', 'unknown'), context);

      expect(result.success).toBe(false);
      expect(result.message).toContain('未知子命令');
      expect(result.message).toContain('/project list');
      expect(result.message).toContain('/project create');
      expect(result.message).toContain('/project use');
      expect(result.message).toContain('/project info');
      expect(result.message).toContain('/project reset');
    });

    it('should show usage help when no sub-command', async () => {
      const context = createMockContext();

      const result = await handleProject(makeCommand('chat-1'), context);

      expect(result.success).toBe(false);
      expect(result.message).toContain('未知子命令');
    });
  });
});
