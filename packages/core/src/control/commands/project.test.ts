/**
 * Tests for /project command handler.
 *
 * @see Issue #1916 Phase 2 — unified ProjectContext system
 */

import { describe, it, expect, vi } from 'vitest';
import { handleProject } from './project.js';
import type { ControlCommand } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';
import type { ProjectContextConfig, ProjectResult, ProjectTemplate, InstanceInfo } from '../../project/types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Mock factories
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function createMockProjectManager(overrides?: {
  templates?: ProjectTemplate[];
  instances?: InstanceInfo[];
  active?: ProjectContextConfig;
}) {
  const templates = overrides?.templates ?? [
    { name: 'research', displayName: '研究模式', description: '专注研究' },
    { name: 'book-reader', displayName: '读书助手' },
  ];
  const instances = overrides?.instances ?? [];
  const active = overrides?.active ?? { name: 'default', workingDir: '/workspace' };

  return {
    getActive: vi.fn<(chatId: string) => ProjectContextConfig>().mockReturnValue(active),
    create: vi.fn<(chatId: string, templateName: string, name: string) => ProjectResult<ProjectContextConfig>>()
      .mockImplementation((_chatId, templateName, name) => ({
        ok: true as const,
        data: { name, templateName, workingDir: `/workspace/projects/${name}` },
      })),
    use: vi.fn<(chatId: string, name: string) => ProjectResult<ProjectContextConfig>>()
      .mockImplementation((_chatId, name) => ({
        ok: true as const,
        data: { name, templateName: 'research', workingDir: `/workspace/projects/${name}` },
      })),
    reset: vi.fn<(chatId: string) => ProjectResult<ProjectContextConfig>>()
      .mockReturnValue({ ok: true as const, data: { name: 'default', workingDir: '/workspace' } }),
    listTemplates: vi.fn<() => ProjectTemplate[]>().mockReturnValue(templates),
    listInstances: vi.fn<() => InstanceInfo[]>().mockReturnValue(instances),
  };
}

function createMockContext(pm?: ReturnType<typeof createMockProjectManager>): ControlHandlerContext {
  return {
    agentPool: {
      reset: vi.fn(),
      stop: vi.fn().mockReturnValue(true),
    },
    node: {
      nodeId: 'test-node',
      getDebugGroup: vi.fn().mockReturnValue(null),
      setDebugGroup: vi.fn(),
      clearDebugGroup: vi.fn().mockReturnValue(null),
    },
    projectManager: pm,
  };
}

function createCommand(chatId: string, args?: string | string[]): ControlCommand {
  return {
    type: 'project',
    chatId,
    data: args ? { args } : undefined,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('/project command', () => {
  describe('argument parsing', () => {
    it('should show usage help when no sub-command is given', async () => {
      const result = await handleProject(createCommand('chat_1'), createMockContext());
      expect(result.success).toBe(false);
      expect(result.message).toContain('无效的 /project 子命令');
      expect(result.message).toContain('/project list');
      expect(result.message).toContain('/project create');
      expect(result.message).toContain('/project use');
      expect(result.message).toContain('/project info');
      expect(result.message).toContain('/project reset');
    });

    it('should show usage help for unrecognized sub-command', async () => {
      const result = await handleProject(createCommand('chat_1', 'unknown'), createMockContext());
      expect(result.success).toBe(false);
      expect(result.message).toContain('无效的 /project 子命令');
    });

    it('should parse args from string', async () => {
      const pm = createMockProjectManager();
      const ctx = createMockContext(pm);
      const result = await handleProject(createCommand('chat_1', 'info'), ctx);
      // Should dispatch to handleInfo, not fail on parsing
      expect(result.success).toBe(true);
    });

    it('should parse args from string[]', async () => {
      const pm = createMockProjectManager();
      const ctx = createMockContext(pm);
      const result = await handleProject(createCommand('chat_1', ['info']), ctx);
      expect(result.success).toBe(true);
    });

    it('should handle empty string args', async () => {
      const result = await handleProject(createCommand('chat_1', ''), createMockContext());
      expect(result.success).toBe(false);
      expect(result.message).toContain('无效的 /project 子命令');
    });

    it('should handle empty array args', async () => {
      const result = await handleProject(createCommand('chat_1', []), createMockContext());
      expect(result.success).toBe(false);
      expect(result.message).toContain('无效的 /project 子命令');
    });
  });

  describe('/project list', () => {
    it('should list templates and instances', async () => {
      const pm = createMockProjectManager({
        instances: [
          {
            name: 'my-research',
            templateName: 'research',
            chatIds: ['chat_1'],
            workingDir: '/workspace/projects/my-research',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      });
      const ctx = createMockContext(pm);
      const result = await handleProject(createCommand('chat_1', 'list'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Project 列表');
      expect(result.message).toContain('research');
      expect(result.message).toContain('研究模式');
      expect(result.message).toContain('my-research');
      expect(result.message).toContain('1 个绑定');
    });

    it('should show no templates and no instances', async () => {
      const pm = createMockProjectManager({ templates: [], instances: [] });
      const ctx = createMockContext(pm);
      const result = await handleProject(createCommand('chat_1', 'list'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('可用模板:** 无');
      expect(result.message).toContain('已创建实例:** 无');
    });

    it('should return error when projectManager is not available', async () => {
      const ctx = createMockContext(undefined);
      const result = await handleProject(createCommand('chat_1', 'list'), ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Project 功能未启用');
    });
  });

  describe('/project create', () => {
    it('should create a project instance and reset agent session', async () => {
      const pm = createMockProjectManager();
      const ctx = createMockContext(pm);
      const result = await handleProject(createCommand('chat_1', ['create', 'research', 'my-proj']), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Project 实例已创建');
      expect(result.message).toContain('my-proj');
      expect(pm.create).toHaveBeenCalledWith('chat_1', 'research', 'my-proj');
      expect(ctx.agentPool.reset).toHaveBeenCalledWith('chat_1');
    });

    it('should return error when missing arguments', async () => {
      const pm = createMockProjectManager();
      const ctx = createMockContext(pm);
      const result = await handleProject(createCommand('chat_1', ['create', 'research']), ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('用法');
      expect(result.message).toContain('/project create');
    });

    it('should return error when missing all arguments', async () => {
      const pm = createMockProjectManager();
      const ctx = createMockContext(pm);
      const result = await handleProject(createCommand('chat_1', ['create']), ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('用法');
    });

    it('should handle create failure from ProjectManager', async () => {
      const pm = createMockProjectManager();
      pm.create.mockReturnValue({ ok: false, error: '模板 "nonexistent" 不存在' });
      const ctx = createMockContext(pm);
      const result = await handleProject(createCommand('chat_1', ['create', 'nonexistent', 'test']), ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('创建失败');
      expect(result.message).toContain('nonexistent');
    });

    it('should return error when projectManager is not available', async () => {
      const ctx = createMockContext(undefined);
      const result = await handleProject(createCommand('chat_1', ['create', 'research', 'test']), ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Project 功能未启用');
    });
  });

  describe('/project use', () => {
    it('should switch to an existing instance and reset agent session', async () => {
      const pm = createMockProjectManager();
      const ctx = createMockContext(pm);
      const result = await handleProject(createCommand('chat_1', ['use', 'my-research']), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('已切换到 Project 实例');
      expect(result.message).toContain('my-research');
      expect(pm.use).toHaveBeenCalledWith('chat_1', 'my-research');
      expect(ctx.agentPool.reset).toHaveBeenCalledWith('chat_1');
    });

    it('should return error when missing name argument', async () => {
      const pm = createMockProjectManager();
      const ctx = createMockContext(pm);
      const result = await handleProject(createCommand('chat_1', ['use']), ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('用法');
      expect(result.message).toContain('/project use');
    });

    it('should handle use failure from ProjectManager', async () => {
      const pm = createMockProjectManager();
      pm.use.mockReturnValue({ ok: false, error: '实例 "nonexistent" 不存在' });
      const ctx = createMockContext(pm);
      const result = await handleProject(createCommand('chat_1', ['use', 'nonexistent']), ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('切换失败');
    });
  });

  describe('/project info', () => {
    it('should show current project when bound to an instance', async () => {
      const pm = createMockProjectManager({
        active: { name: 'my-research', templateName: 'research', workingDir: '/workspace/projects/my-research' },
      });
      const ctx = createMockContext(pm);
      const result = await handleProject(createCommand('chat_1', 'info'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('当前 Project');
      expect(result.message).toContain('my-research');
      expect(result.message).toContain('research');
    });

    it('should show default project when not bound', async () => {
      const pm = createMockProjectManager({
        active: { name: 'default', workingDir: '/workspace' },
      });
      const ctx = createMockContext(pm);
      const result = await handleProject(createCommand('chat_1', 'info'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('default');
      expect(result.message).toContain('/project list');
    });

    it('should return error when projectManager is not available', async () => {
      const ctx = createMockContext(undefined);
      const result = await handleProject(createCommand('chat_1', 'info'), ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Project 功能未启用');
    });
  });

  describe('/project reset', () => {
    it('should reset to default project and reset agent session', async () => {
      const pm = createMockProjectManager();
      const ctx = createMockContext(pm);
      const result = await handleProject(createCommand('chat_1', 'reset'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('已重置为默认 Project');
      expect(pm.reset).toHaveBeenCalledWith('chat_1');
      expect(ctx.agentPool.reset).toHaveBeenCalledWith('chat_1');
    });

    it('should handle reset failure from ProjectManager', async () => {
      const pm = createMockProjectManager();
      pm.reset.mockReturnValue({ ok: false, error: 'chatId 不能为空' });
      const ctx = createMockContext(pm);
      const result = await handleProject(createCommand('chat_1', 'reset'), ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('重置失败');
    });

    it('should return error when projectManager is not available', async () => {
      const ctx = createMockContext(undefined);
      const result = await handleProject(createCommand('chat_1', 'reset'), ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Project 功能未启用');
    });
  });

  describe('case insensitivity', () => {
    it('should handle uppercase sub-commands', async () => {
      const pm = createMockProjectManager();
      const ctx = createMockContext(pm);
      const result = await handleProject(createCommand('chat_1', ['LIST']), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Project 列表');
    });

    it('should handle mixed case sub-commands', async () => {
      const pm = createMockProjectManager();
      const ctx = createMockContext(pm);
      const result = await handleProject(createCommand('chat_1', ['Info']), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('当前 Project');
    });
  });
});
