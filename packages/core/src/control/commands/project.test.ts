/**
 * Tests for /project command handler.
 *
 * @see Issue #1916 (unified ProjectContext system)
 */

import { describe, it, expect } from 'vitest';
import { handleProject } from './project.js';
import type { ControlHandlerContext } from '../types.js';

function createMockContext(overrides?: Partial<ControlHandlerContext['projectManager']>): ControlHandlerContext {
  const resetCalls: string[] = [];

  return {
    agentPool: {
      reset: (chatId: string) => { resetCalls.push(chatId); },
      stop: () => false,
    },
    node: {
      nodeId: 'test-node',
      getExecNodes: () => [],
      getDebugGroup: () => null,
      setDebugGroup: () => {},
      clearDebugGroup: () => null,
    },
    projectManager: {
      getActive: (_chatId: string) => ({ name: 'default', workingDir: '/workspace' }),
      create: (_chatId: string, _templateName: string, name: string) => ({ ok: true, data: { name, templateName: _templateName, workingDir: `/workspace/projects/${name}` } }),
      use: (_chatId: string, name: string) => ({ ok: true, data: { name, templateName: 'research', workingDir: `/workspace/projects/${name}` } }),
      reset: (_chatId: string) => ({ ok: true, data: { name: 'default', workingDir: '/workspace' } }),
      delete: (_name: string) => ({ ok: true, data: undefined }),
      listTemplates: () => [
        { name: 'research', displayName: '研究模式', description: '专注研究的独立空间' },
        { name: 'book-reader', displayName: '读书助手' },
      ],
      listInstances: () => [
        { name: 'my-research', templateName: 'research', chatIds: ['chat-1'], workingDir: '/workspace/projects/my-research', createdAt: '2026-04-23T00:00:00.000Z' },
      ],
      ...overrides,
    },
    resetCalls,
  } as unknown as ControlHandlerContext;
}

function createCommand(chatId: string, args: string[] = []) {
  return {
    type: 'project' as const,
    chatId,
    data: { args },
  };
}

describe('handleProject', () => {
  describe('project create', () => {
    it('should create a project and reset session', async () => {
      const ctx = createMockContext();
      const result = await handleProject(createCommand('chat-1', ['create', 'research', 'my-research']), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('my-research');
      expect((ctx as unknown as { resetCalls: string[] }).resetCalls).toContain('chat-1');
    });

    it('should fail with missing arguments', async () => {
      const ctx = createMockContext();
      const result = await handleProject(createCommand('chat-1', ['create', 'research']), ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('用法');
    });

    it('should fail when ProjectManager is not initialized', async () => {
      const ctx: ControlHandlerContext = {
        agentPool: { reset: () => {}, stop: () => false },
        node: { nodeId: 'test', getExecNodes: () => [], getDebugGroup: () => null, setDebugGroup: () => {}, clearDebugGroup: () => null },
      };
      const result = await handleProject(createCommand('chat-1', ['create', 'research', 'my-research']), ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('未初始化');
    });
  });

  describe('project use', () => {
    it('should bind to existing instance and reset session', async () => {
      const ctx = createMockContext();
      const result = await handleProject(createCommand('chat-1', ['use', 'my-research']), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('my-research');
    });

    it('should fail with missing name', async () => {
      const ctx = createMockContext();
      const result = await handleProject(createCommand('chat-1', ['use']), ctx);

      expect(result.success).toBe(false);
    });
  });

  describe('project reset', () => {
    it('should reset to default and reset session', async () => {
      const ctx = createMockContext();
      const result = await handleProject(createCommand('chat-1', ['reset']), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('默认');
    });
  });

  describe('project list', () => {
    it('should list templates and instances', async () => {
      const ctx = createMockContext();
      const result = await handleProject(createCommand('chat-1', ['list']), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('research');
      expect(result.message).toContain('my-research');
    });
  });

  describe('project info', () => {
    it('should show default project info', async () => {
      const ctx = createMockContext();
      const result = await handleProject(createCommand('chat-1', ['info']), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('default');
    });
  });

  describe('project delete', () => {
    it('should delete an instance', async () => {
      const ctx = createMockContext();
      const result = await handleProject(createCommand('chat-1', ['delete', 'my-research']), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('my-research');
    });

    it('should fail with missing name', async () => {
      const ctx = createMockContext();
      const result = await handleProject(createCommand('chat-1', ['delete']), ctx);

      expect(result.success).toBe(false);
    });
  });

  describe('project (no subcommand)', () => {
    it('should show help when no subcommand given', async () => {
      const ctx = createMockContext();
      const result = await handleProject(createCommand('chat-1'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('list');
      expect(result.message).toContain('create');
      expect(result.message).toContain('use');
      expect(result.message).toContain('info');
      expect(result.message).toContain('reset');
      expect(result.message).toContain('delete');
    });
  });

  describe('error handling', () => {
    it('should show error for unknown subcommand', async () => {
      const ctx = createMockContext();
      const result = await handleProject(createCommand('chat-1', ['foobar']), ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('foobar');
    });

    it('should propagate create errors', async () => {
      const ctx = createMockContext({
        create: () => ({ ok: false, error: '模板不存在' }),
      });
      const result = await handleProject(createCommand('chat-1', ['create', 'nonexistent', 'test']), ctx);

      expect(result.success).toBe(false);
      expect(result.message).toBe('模板不存在');
    });
  });
});
