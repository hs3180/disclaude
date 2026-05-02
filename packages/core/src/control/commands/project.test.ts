/**
 * Tests for /project command handler.
 *
 * @see Issue #1916
 */

import { describe, it, expect } from 'vitest';
import { handleProject } from './project.js';
import type { ControlCommand } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';
import { ProjectManager } from '../../project/project-manager.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function createTestContext(pm?: ProjectManager): ControlHandlerContext {
  return {
    agentPool: {
      reset: () => {},
      stop: () => false,
    },
    node: {
      nodeId: 'test-node',
      getDebugGroup: () => null,
      setDebugGroup: () => {},
      clearDebugGroup: () => null,
    },
    projectManager: pm,
  };
}

function createCommand(
  chatId: string,
  subcommand: string,
  data?: Record<string, unknown>,
): ControlCommand {
  return {
    type: 'project',
    chatId,
    data: { subcommand, ...data },
  };
}

function createPM(): ProjectManager {
  const tmpDir = mkdtempSync(join(tmpdir(), 'disclaude-test-'));
  return new ProjectManager({
    workspaceDir: tmpDir,
    packageDir: tmpDir,
    templatesConfig: {
      research: { displayName: '研究模式', description: '专注研究的独立空间' },
      dev: { displayName: '开发模式' },
    },
  });
}

describe('handleProject', () => {
  it('returns error when ProjectManager is not configured', () => {
    const ctx = createTestContext();
    const cmd = createCommand('chat-1', 'list');
    const result = handleProject(cmd, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain('ProjectManager 未配置');
  });

  it('returns error for unknown subcommand', () => {
    const pm = createPM();
    const ctx = createTestContext(pm);
    const cmd = createCommand('chat-1', 'unknown');
    const result = handleProject(cmd, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain('未知子命令');
  });

  describe('list', () => {
    it('lists available templates', () => {
      const pm = createPM();
      const ctx = createTestContext(pm);
      const cmd = createCommand('chat-1', 'list');
      const result = handleProject(cmd, ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('research');
      expect(result.message).toContain('研究模式');
      expect(result.message).toContain('dev');
    });
  });

  describe('create', () => {
    it('returns error when template is missing', () => {
      const pm = createPM();
      const ctx = createTestContext(pm);
      const cmd = createCommand('chat-1', 'create', { name: 'my-research' });
      const result = handleProject(cmd, ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('缺少模板名称');
    });

    it('returns error when name is missing', () => {
      const pm = createPM();
      const ctx = createTestContext(pm);
      const cmd = createCommand('chat-1', 'create', { template: 'research' });
      const result = handleProject(cmd, ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('缺少实例名称');
    });

    it('creates a project instance', () => {
      const pm = createPM();
      const ctx = createTestContext(pm);
      const cmd = createCommand('chat-1', 'create', {
        template: 'research',
        name: 'my-research',
      });
      const result = handleProject(cmd, ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('my-research');
      expect(result.message).toContain('research');
    });

    it('rejects duplicate names', () => {
      const pm = createPM();
      const ctx = createTestContext(pm);

      // First create
      const cmd1 = createCommand('chat-1', 'create', {
        template: 'research',
        name: 'dup',
      });
      void handleProject(cmd1, ctx);

      // Second create with same name
      const cmd2 = createCommand('chat-2', 'create', {
        template: 'dev',
        name: 'dup',
      });
      const result = handleProject(cmd2, ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('已存在');
    });
  });

  describe('use', () => {
    it('returns error when name is missing', () => {
      const pm = createPM();
      const ctx = createTestContext(pm);
      const cmd = createCommand('chat-1', 'use');
      const result = handleProject(cmd, ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('缺少实例名称');
    });

    it('switches to an existing instance', () => {
      const pm = createPM();
      const ctx = createTestContext(pm);

      // Create instance first
      const createCmd = createCommand('chat-1', 'create', {
        template: 'research',
        name: 'proj-1',
      });
      void handleProject(createCmd, ctx);

      // Use it from another chat
      const useCmd = createCommand('chat-2', 'use', { name: 'proj-1' });
      const result = handleProject(useCmd, ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('proj-1');
    });

    it('returns error for non-existent instance', () => {
      const pm = createPM();
      const ctx = createTestContext(pm);
      const cmd = createCommand('chat-1', 'use', { name: 'nonexistent' });
      const result = handleProject(cmd, ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('不存在');
    });
  });

  describe('reset', () => {
    it('resets to default workspace', () => {
      const pm = createPM();
      let resetCalled = false;
      const ctx: ControlHandlerContext = {
        agentPool: {
          reset: () => { resetCalled = true; },
          stop: () => false,
        },
        node: {
          nodeId: 'test-node',
          getDebugGroup: () => null,
          setDebugGroup: () => {},
          clearDebugGroup: () => null,
        },
        projectManager: pm,
      };

      // Create and use a project first
      const createCmd = createCommand('chat-1', 'create', {
        template: 'research',
        name: 'proj-1',
      });
      void handleProject(createCmd, ctx);

      // Reset
      const resetCmd = createCommand('chat-1', 'reset');
      const result = handleProject(resetCmd, ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('重置为默认');
      expect(resetCalled).toBe(true);
    });
  });

  describe('info', () => {
    it('shows default context when no project is bound', () => {
      const pm = createPM();
      const ctx = createTestContext(pm);
      const cmd = createCommand('chat-1', 'info');
      const result = handleProject(cmd, ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('default');
    });

    it('shows project context when bound', () => {
      const pm = createPM();
      const ctx = createTestContext(pm);

      // Create project
      const createCmd = createCommand('chat-1', 'create', {
        template: 'research',
        name: 'my-project',
      });
      void handleProject(createCmd, ctx);

      // Check info
      const infoCmd = createCommand('chat-1', 'info');
      const result = handleProject(infoCmd, ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('my-project');
      expect(result.message).toContain('research');
    });
  });
});
