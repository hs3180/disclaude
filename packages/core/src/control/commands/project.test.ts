/**
 * Unit tests for /project control command.
 *
 * @see Issue #1916
 */

import { describe, it, expect, vi } from 'vitest';
import { handleProject } from './project.js';
import type { ControlHandlerContext } from '../types.js';

function createMockContext(overrides?: Partial<ControlHandlerContext>): ControlHandlerContext {
  return {
    agentPool: { reset: vi.fn(), stop: vi.fn().mockReturnValue(true) },
    node: {
      nodeId: 'node-1',
      getExecNodes: vi.fn().mockReturnValue([]),
      getDebugGroup: vi.fn().mockReturnValue(null),
      clearDebugGroup: vi.fn(),
    },
    ...overrides,
  };
}

function createMockProjectManager() {
  const instances: Map<string, { templateName: string; workingDir: string }> = new Map();
  const bindings = new Map<string, string>();

  return {
    getActive: vi.fn((chatId: string) => {
      const name = bindings.get(chatId);
      if (name && instances.has(name)) {
        return instances.get(name)!;
      }
      return { name: 'default', workingDir: '/workspace' };
    }),
    create: vi.fn((chatId: string, templateName: string, name: string) => {
      const inst = { name, templateName, workingDir: `/workspace/projects/${name}` };
      instances.set(name, inst);
      bindings.set(chatId, name);
      return { ok: true, data: inst };
    }),
    use: vi.fn((chatId: string, name: string) => {
      if (!instances.has(name)) {
        return { ok: false, error: `实例 "${name}" 不存在` };
      }
      bindings.set(chatId, name);
      return { ok: true, data: instances.get(name)! };
    }),
    reset: vi.fn((chatId: string) => {
      bindings.delete(chatId);
      return { ok: true, data: { name: 'default', workingDir: '/workspace' } };
    }),
    listTemplates: vi.fn(() => [
      { name: 'research', displayName: '研究模式', description: '专注研究' },
    ]),
    listInstances: vi.fn(() => Array.from(instances.values()).map(inst => ({
      ...inst,
      chatIds: Array.from(bindings.entries())
        .filter(([, n]) => n === inst.name)
        .map(([id]) => id),
      createdAt: new Date().toISOString(),
    }))),
  };
}

describe('handleProject', () => {
  describe('without ProjectManager', () => {
    it('should return error when ProjectManager is not configured', () => {
      const context = createMockContext();
      const result = handleProject(
        { type: 'project', chatId: 'chat-1', data: { args: ['list'] } },
        context,
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('未初始化');
    });
  });

  describe('/project list', () => {
    it('should list templates and instances', () => {
      const pm = createMockProjectManager();
      const context = createMockContext({ projectManager: pm });
      const result = handleProject(
        { type: 'project', chatId: 'chat-1', data: { args: ['list'] } },
        context,
      );
      expect(result.success).toBe(true);
      expect(result.message).toContain('可用模板');
      expect(result.message).toContain('research');
      expect(result.message).toContain('已创建实例');
    });
  });

  describe('/project create', () => {
    it('should create project and reset session', () => {
      const pm = createMockProjectManager();
      const context = createMockContext({ projectManager: pm });
      const result = handleProject(
        { type: 'project', chatId: 'chat-1', data: { args: ['create', 'research', 'my-research'] } },
        context,
      );
      expect(result.success).toBe(true);
      expect(pm.create).toHaveBeenCalledWith('chat-1', 'research', 'my-research');
      expect(context.agentPool.reset).toHaveBeenCalledWith('chat-1');
      expect(result.message).toContain('my-research');
    });

    it('should return error for missing arguments', () => {
      const pm = createMockProjectManager();
      const context = createMockContext({ projectManager: pm });
      const result = handleProject(
        { type: 'project', chatId: 'chat-1', data: { args: ['create', 'research'] } },
        context,
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('用法');
    });
  });

  describe('/project use', () => {
    it('should bind to instance and reset session', () => {
      const pm = createMockProjectManager();
      // Pre-create an instance so 'use' can find it
      pm.create('chat-0', 'research', 'my-research');
      const context = createMockContext({ projectManager: pm });
      const result = handleProject(
        { type: 'project', chatId: 'chat-1', data: { args: ['use', 'my-research'] } },
        context,
      );
      expect(result.success).toBe(true);
      expect(pm.use).toHaveBeenCalledWith('chat-1', 'my-research');
      expect(context.agentPool.reset).toHaveBeenCalledWith('chat-1');
    });

    it('should return error for non-existent instance', () => {
      const pm = createMockProjectManager();
      const context = createMockContext({ projectManager: pm });
      const result = handleProject(
        { type: 'project', chatId: 'chat-1', data: { args: ['use', 'nonexistent'] } },
        context,
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('不存在');
    });
  });

  describe('/project reset', () => {
    it('should reset to default and reset session', () => {
      const pm = createMockProjectManager();
      const context = createMockContext({ projectManager: pm });
      const result = handleProject(
        { type: 'project', chatId: 'chat-1', data: { args: ['reset'] } },
        context,
      );
      expect(result.success).toBe(true);
      expect(pm.reset).toHaveBeenCalledWith('chat-1');
      expect(context.agentPool.reset).toHaveBeenCalledWith('chat-1');
    });
  });

  describe('/project info', () => {
    it('should show current project info', () => {
      const pm = createMockProjectManager();
      const context = createMockContext({ projectManager: pm });
      const result = handleProject(
        { type: 'project', chatId: 'chat-1', data: { args: ['info'] } },
        context,
      );
      expect(result.success).toBe(true);
      expect(result.message).toContain('当前项目');
    });
  });

  describe('no subcommand', () => {
    it('should show usage help', () => {
      const pm = createMockProjectManager();
      const context = createMockContext({ projectManager: pm });
      const result = handleProject(
        { type: 'project', chatId: 'chat-1', data: {} },
        context,
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('用法');
    });
  });

  describe('unknown subcommand', () => {
    it('should return error for unknown subcommand', () => {
      const pm = createMockProjectManager();
      const context = createMockContext({ projectManager: pm });
      const result = handleProject(
        { type: 'project', chatId: 'chat-1', data: { args: ['unknown'] } },
        context,
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('未知子命令');
    });
  });
});
