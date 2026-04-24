/**
 * Unit tests for /project control command handler.
 *
 * Issue #1916 Phase 2: Tests for project context management command.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleProject } from './project.js';
import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';
import type { ProjectResult, ProjectContextConfig, ProjectTemplate, InstanceInfo } from '../../project/types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Create a control command with the given args */
function createCommand(args?: string | string[], chatId = 'test-chat-id'): ControlCommand {
  return {
    type: 'project',
    chatId,
    data: args !== undefined ? { args } : undefined,
  };
}

/** Create a mock ProjectManager */
function createMockProjectManager(overrides?: {
  templates?: ProjectTemplate[];
  instances?: InstanceInfo[];
  active?: ProjectContextConfig;
}) {
  const templates = overrides?.templates ?? [];
  const instances = overrides?.instances ?? [];
  let active: ProjectContextConfig = overrides?.active ?? { name: 'default', workingDir: '/workspace' };

  return {
    getActive: vi.fn((_chatId: string) => active),
    create: vi.fn((_chatId: string, _templateName: string, _name: string): ProjectResult<ProjectContextConfig> => {
      return { ok: true, data: active };
    }),
    use: vi.fn((_chatId: string, _name: string): ProjectResult<ProjectContextConfig> => {
      return { ok: true, data: active };
    }),
    reset: vi.fn((_chatId: string): ProjectResult<ProjectContextConfig> => {
      active = { name: 'default', workingDir: '/workspace' };
      return { ok: true, data: active };
    }),
    listTemplates: vi.fn(() => templates),
    listInstances: vi.fn(() => instances),
    // Allow tests to override the active project
    _setActive: (newActive: ProjectContextConfig) => { active = newActive; },
  };
}

/** Create a mock handler context */
function createContext(overrides?: Partial<ControlHandlerContext> & { projectManager?: ReturnType<typeof createMockProjectManager> | undefined }): ControlHandlerContext {
  const { projectManager, ...rest } = overrides ?? {};
  const ctx: ControlHandlerContext = {
    agentPool: { reset: vi.fn(), stop: vi.fn().mockReturnValue(true) },
    node: {
      nodeId: 'test-node',
      getExecNodes: vi.fn().mockReturnValue([]),
      getDebugGroup: vi.fn().mockReturnValue(null),
      setDebugGroup: vi.fn(),
      clearDebugGroup: vi.fn().mockReturnValue(null),
    },
    projectManager: projectManager ?? createMockProjectManager(),
    ...rest,
  };
  // If projectManager was explicitly set to undefined, remove it
  if (overrides && 'projectManager' in overrides && overrides.projectManager === undefined) {
    delete ctx.projectManager;
  }
  return ctx;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('handleProject (Issue #1916 Phase 2)', () => {

  // ─── Unavailable ──────────────────────────
  describe('projectManager not available', () => {
    it('should return failure when projectManager is undefined', () => {
      const command = createCommand();
      const mockWarn = vi.fn();
      const context = createContext({
        projectManager: undefined,
        logger: { warn: mockWarn } as unknown as ControlHandlerContext['logger'],
      });

      const result = handleProject(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('不可用');
      expect(mockWarn).toHaveBeenCalledWith(
        { chatId: 'test-chat-id' },
        '/project command received but projectManager is not configured',
      );
    });
  });

  // ─── Sub-command parsing ──────────────────
  describe('sub-command parsing', () => {
    it('should default to "info" when no args provided', () => {
      const command = createCommand();
      const pm = createMockProjectManager();
      const context = createContext({ projectManager: pm });

      const result = handleProject(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(pm.getActive).toHaveBeenCalledWith('test-chat-id');
    });

    it('should parse string args (REST API format)', () => {
      const command = createCommand('list');
      const pm = createMockProjectManager();
      const context = createContext({ projectManager: pm });

      const result = handleProject(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(pm.listTemplates).toHaveBeenCalled();
    });

    it('should parse array args (Feishu format)', () => {
      const command = createCommand(['list']);
      const pm = createMockProjectManager();
      const context = createContext({ projectManager: pm });

      const result = handleProject(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(pm.listTemplates).toHaveBeenCalled();
    });

    it('should return error for unknown sub-command', () => {
      const command = createCommand('foobar');
      const pm = createMockProjectManager();
      const context = createContext({ projectManager: pm });

      const result = handleProject(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('未知子命令');
      expect(result.message).toContain('foobar');
      expect(result.message).toContain('/project list');
    });
  });

  // ─── list ─────────────────────────────────
  describe('/project list', () => {
    it('should list templates and instances', () => {
      const pm = createMockProjectManager({
        templates: [
          { name: 'research', displayName: '研究模式', description: '专注研究' },
        ],
        instances: [
          { name: 'my-research', templateName: 'research', chatIds: ['chat-1'], workingDir: '/ws/projects/my-research', createdAt: '2026-01-01T00:00:00Z' },
        ],
      });
      const context = createContext({ projectManager: pm });
      const command = createCommand('list');

      const result = handleProject(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('research');
      expect(result.message).toContain('研究模式');
      expect(result.message).toContain('my-research');
      expect(result.message).toContain('1 个绑定');
    });

    it('should show no-templates message when empty', () => {
      const pm = createMockProjectManager({ templates: [], instances: [] });
      const context = createContext({ projectManager: pm });
      const command = createCommand('list');

      const result = handleProject(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('未配置');
    });
  });

  // ─── create ───────────────────────────────
  describe('/project create', () => {
    it('should create instance and reset session', () => {
      const pm = createMockProjectManager();
      const context = createContext({ projectManager: pm });
      const command = createCommand(['create', 'research', 'my-proj']);

      const result = handleProject(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已创建');
      expect(pm.create).toHaveBeenCalledWith('test-chat-id', 'research', 'my-proj');
      expect(context.agentPool.reset).toHaveBeenCalledWith('test-chat-id');
    });

    it('should return error when missing arguments', () => {
      const pm = createMockProjectManager();
      const context = createContext({ projectManager: pm });
      const command = createCommand(['create', 'research']);

      const result = handleProject(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('/project create');
      expect(pm.create).not.toHaveBeenCalled();
    });

    it('should return error when ProjectManager.create fails', () => {
      const pm = createMockProjectManager();
      pm.create = vi.fn(() => ({ ok: false, error: '模板 "xxx" 不存在' }));
      const context = createContext({ projectManager: pm });
      const command = createCommand(['create', 'xxx', 'my-proj']);

      const result = handleProject(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('创建失败');
      expect(result.message).toContain('xxx');
      expect(context.agentPool.reset).not.toHaveBeenCalled();
    });
  });

  // ─── use ──────────────────────────────────
  describe('/project use', () => {
    it('should switch to existing instance and reset session', () => {
      const pm = createMockProjectManager();
      const context = createContext({ projectManager: pm });
      const command = createCommand(['use', 'my-research']);

      const result = handleProject(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已切换');
      expect(pm.use).toHaveBeenCalledWith('test-chat-id', 'my-research');
      expect(context.agentPool.reset).toHaveBeenCalledWith('test-chat-id');
    });

    it('should return error when missing instance name', () => {
      const pm = createMockProjectManager();
      const context = createContext({ projectManager: pm });
      const command = createCommand(['use']);

      const result = handleProject(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('/project use');
      expect(pm.use).not.toHaveBeenCalled();
    });

    it('should return error when instance not found', () => {
      const pm = createMockProjectManager();
      pm.use = vi.fn(() => ({ ok: false, error: '实例 "xxx" 不存在' }));
      const context = createContext({ projectManager: pm });
      const command = createCommand(['use', 'xxx']);

      const result = handleProject(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('切换失败');
      expect(context.agentPool.reset).not.toHaveBeenCalled();
    });
  });

  // ─── info ─────────────────────────────────
  describe('/project info', () => {
    it('should show default project when no binding', () => {
      const pm = createMockProjectManager({
        active: { name: 'default', workingDir: '/workspace' },
      });
      const context = createContext({ projectManager: pm });
      const command = createCommand('info');

      const result = handleProject(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('default');
      expect(result.message).toContain('/workspace');
    });

    it('should show active project when bound', () => {
      const pm = createMockProjectManager({
        active: { name: 'my-research', templateName: 'research', workingDir: '/ws/projects/my-research' },
      });
      const context = createContext({ projectManager: pm });
      const command = createCommand('info');

      const result = handleProject(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('my-research');
      expect(result.message).toContain('research');
    });

    it('should default to info when no args', () => {
      const pm = createMockProjectManager();
      const context = createContext({ projectManager: pm });
      const command = createCommand();

      const result = handleProject(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(pm.getActive).toHaveBeenCalled();
    });
  });

  // ─── reset ────────────────────────────────
  describe('/project reset', () => {
    it('should reset to default and reset session', () => {
      const pm = createMockProjectManager();
      const context = createContext({ projectManager: pm });
      const command = createCommand('reset');

      const result = handleProject(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已重置');
      expect(pm.reset).toHaveBeenCalledWith('test-chat-id');
      expect(context.agentPool.reset).toHaveBeenCalledWith('test-chat-id');
    });

    it('should return error when reset fails', () => {
      const pm = createMockProjectManager();
      pm.reset = vi.fn(() => ({ ok: false, error: 'chatId 不能为空' }));
      const context = createContext({ projectManager: pm });
      const command = createCommand('reset');

      const result = handleProject(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('重置失败');
      expect(context.agentPool.reset).not.toHaveBeenCalled();
    });
  });
});
