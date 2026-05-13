/**
 * Unit tests for /project command handler.
 *
 * Tests cover:
 * - Subcommand dispatching
 * - `use <workingDir>` — bind chat to a working directory or instance
 * - `create <template> <name>` — create instance from template
 * - `list` — list templates and instances
 * - `reset` — reset chat to default workspace
 * - `info` — show current chat's active project info
 * - Error cases (no ProjectManager, unknown subcommand, missing args)
 *
 * @see Issue #3519 (simplify /project command)
 * @see Issue #1916 (template/instance model)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ControlCommand } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';
import { handleProject } from './project.js';
import { ProjectManager } from '../../project/project-manager.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Fixtures
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cmd-project-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
  tempDirs.length = 0;
});

/** Create a packageDir with a template CLAUDE.md */
function createPackageDir(templateName = 'research'): string {
  const packageDir = createTempDir();
  const templateDir = join(packageDir, 'templates', templateName);
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(join(templateDir, 'CLAUDE.md'), '# Research Mode\n\nYou are in research mode.');
  return packageDir;
}

function createTestContext(overrides?: Partial<ControlHandlerContext>): ControlHandlerContext {
  const workspaceDir = createTempDir();

  const pm = new ProjectManager({
    workspaceDir,
  });

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
    ...overrides,
  };
}

function createTestContextWithTemplates(): ControlHandlerContext {
  const workspaceDir = createTempDir();
  const packageDir = createPackageDir();

  const pm = new ProjectManager({
    workspaceDir,
    packageDir,
    projectTemplates: {
      research: { displayName: 'Research', description: 'Research mode' },
    },
  });

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

function makeCommand(
  chatId: string,
  subcommand: string,
  data?: Record<string, unknown>,
): ControlCommand<'project'> {
  return {
    type: 'project',
    chatId,
    data: { subcommand, ...data } as ControlCommand<'project'>['data'],
  };
}

/** Resolve the possibly-async handler result */
async function invoke(
  cmd: ControlCommand<'project'>,
  ctx: ControlHandlerContext,
): Promise<{ success: boolean; message?: string; error?: string }> {
  return await handleProject(cmd, ctx);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('handleProject', () => {
  describe('unknown subcommand', () => {
    it('should return error for unknown subcommand', async () => {
      const ctx = createTestContext();
      const result = await invoke(makeCommand('chat-1', 'unknown-sub'), ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('未知子命令');
    });
  });

  describe('no ProjectManager', () => {
    it('should return error when projectManager is not configured', async () => {
      const ctx = createTestContext();
      delete (ctx as Partial<ControlHandlerContext>).projectManager;

      const result = await invoke(makeCommand('chat-1', 'info'), ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('ProjectManager 未配置');
    });
  });

  describe('/project info', () => {
    it('should show default project when no binding', async () => {
      const ctx = createTestContext();
      const result = await invoke(makeCommand('chat-1', 'info'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('default');
    });

    it('should show bound working directory', async () => {
      const ctx = createTestContext();
      const projectDir = join(ctx.projectManager!.getWorkspaceDir(), 'my-project');
      mkdirSync(projectDir, { recursive: true });
      ctx.projectManager!.use('chat-1', projectDir);

      const result = await invoke(makeCommand('chat-1', 'info'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('my-project');
    });

    it('should include template info for instance-based binding', async () => {
      const ctx = createTestContextWithTemplates();
      ctx.projectManager!.create('chat-1', 'research', 'my-research');

      const result = await invoke(makeCommand('chat-1', 'info'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('模板');
      expect(result.message).toContain('research');
    });

    it('should include state summary when project state exists', async () => {
      const ctx = createTestContext();
      const projectDir = join(ctx.projectManager!.getWorkspaceDir(), 'my-project');
      mkdirSync(projectDir, { recursive: true });
      ctx.projectManager!.use('chat-1', projectDir);

      // Create a project state file
      const stateDir = join(projectDir, '.disclaude');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'project-state.json'), JSON.stringify({
        version: 1,
        projectKey: 'test/repo',
        lastActive: '2026-05-10T10:00:00Z',
        sync: { issues: '2026-05-10T09:00:00Z' },
        issues: {
          '42': { title: 'Bug', state: 'open', triageStatus: 'triaged', labels: ['bug'] },
        },
        prs: {
          '15': { title: 'Fix', reviewStatus: 'pending' },
        },
      }));

      const result = await invoke(makeCommand('chat-1', 'info'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('1 个已追踪');
    });
  });

  describe('default subcommand', () => {
    it('should default to "info" when no subcommand specified', async () => {
      const ctx = createTestContext();
      const cmd: ControlCommand<'project'> = { type: 'project', chatId: 'chat-1' };
      const result = await invoke(cmd, ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('default');
    });
  });

  describe('/project list', () => {
    it('should list available templates and instances', async () => {
      const ctx = createTestContextWithTemplates();

      const result = await invoke(makeCommand('chat-1', 'list'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('research');
      expect(result.message).toContain('Research');
      expect(result.message).toContain('模板');
    });

    it('should show no templates message when none configured', async () => {
      const ctx = createTestContext();

      const result = await invoke(makeCommand('chat-1', 'list'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('无');
    });

    it('should show created instances', async () => {
      const ctx = createTestContextWithTemplates();
      ctx.projectManager!.create('chat-1', 'research', 'my-research');

      const result = await invoke(makeCommand('chat-1', 'list'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('my-research');
      expect(result.message).toContain('已创建实例');
    });
  });

  describe('/project create', () => {
    it('should create instance from template', async () => {
      const resetCalls: string[] = [];
      const ctx = createTestContextWithTemplates();
      (ctx.agentPool as { reset: (id: string) => void }).reset = (id: string) => { resetCalls.push(id); };

      const result = await invoke(
        makeCommand('chat-1', 'create', { templateName: 'research', instanceName: 'my-research' }),
        ctx,
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('my-research');
      expect(result.message).toContain('research');
      expect(result.message).toContain('已创建');
      expect(resetCalls).toContain('chat-1');
    });

    it('should return error when templateName missing', async () => {
      const ctx = createTestContextWithTemplates();

      const result = await invoke(
        makeCommand('chat-1', 'create', { instanceName: 'my-research' }),
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('template');
    });

    it('should return error when instanceName missing', async () => {
      const ctx = createTestContextWithTemplates();

      const result = await invoke(
        makeCommand('chat-1', 'create', { templateName: 'research' }),
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('name');
    });

    it('should return error for unknown template', async () => {
      const ctx = createTestContextWithTemplates();

      const result = await invoke(
        makeCommand('chat-1', 'create', { templateName: 'nonexistent', instanceName: 'my-inst' }),
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('不存在');
    });

    it('should return error for duplicate instance name', async () => {
      const ctx = createTestContextWithTemplates();
      ctx.projectManager!.create('chat-1', 'research', 'my-research');

      const result = await invoke(
        makeCommand('chat-2', 'create', { templateName: 'research', instanceName: 'my-research' }),
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('已存在');
    });
  });

  describe('/project use', () => {
    it('should bind chat to a working directory', async () => {
      const resetCalls: string[] = [];
      const ctx = createTestContext({
        agentPool: {
          reset: (chatId: string) => { resetCalls.push(chatId); },
          stop: () => false,
        },
      });

      const projectDir = join(ctx.projectManager!.getWorkspaceDir(), 'my-project');
      mkdirSync(projectDir, { recursive: true });

      const result = await invoke(
        makeCommand('chat-1', 'use', { workingDir: projectDir }),
        ctx,
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('my-project');
      expect(result.message).toContain('已切换');
      expect(resetCalls).toContain('chat-1');
    });

    it('should bind to existing instance by name', async () => {
      const resetCalls: string[] = [];
      const ctx = createTestContextWithTemplates();
      (ctx.agentPool as { reset: (id: string) => void }).reset = (id: string) => { resetCalls.push(id); };

      ctx.projectManager!.create('chat-1', 'research', 'my-research');

      const result = await invoke(
        makeCommand('chat-2', 'use', { workingDir: 'my-research' }),
        ctx,
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('my-research');
      expect(resetCalls).toContain('chat-2');
    });

    it('should bind to relative path resolved against workspace', async () => {
      const ctx = createTestContext();
      const projectDir = join(ctx.projectManager!.getWorkspaceDir(), 'projects', 'my-app');
      mkdirSync(projectDir, { recursive: true });

      const result = await invoke(
        makeCommand('chat-1', 'use', { workingDir: 'projects/my-app' }),
        ctx,
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('projects/my-app');
    });

    it('should return error when workingDir is missing', async () => {
      const ctx = createTestContext();
      const result = await invoke(makeCommand('chat-1', 'use'), ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('实例名');
    });

    it('should return error for path traversal', async () => {
      const ctx = createTestContext();
      const result = await invoke(
        makeCommand('chat-1', 'use', { workingDir: '../etc/passwd' }),
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('路径遍历');
    });

    it('should accept pre-normalized data (simulating message-handler flow)', async () => {
      const ctx = createTestContext();
      const projectDir = join(ctx.projectManager!.getWorkspaceDir(), 'my-project');
      mkdirSync(projectDir, { recursive: true });

      // After Issue #3529: data is normalized before reaching the handler.
      // message-handler sends { args: ['use', 'my-project'] },
      // normalizeCommandData converts to { subcommand: 'use', workingDir: 'my-project' }
      const result = await invoke(
        makeCommand('chat-1', 'use', { workingDir: 'my-project' }),
        ctx,
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('my-project');
      expect(result.message).toContain('已切换');
    });

    it('should accept multi-segment path', async () => {
      const ctx = createTestContext();
      const projectDir = join(ctx.projectManager!.getWorkspaceDir(), 'projects', 'my-app');
      mkdirSync(projectDir, { recursive: true });

      const result = await invoke(
        makeCommand('chat-1', 'use', { workingDir: 'projects/my-app' }),
        ctx,
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('projects/my-app');
    });
  });

  describe('/project reset', () => {
    it('should reset chat to default project', async () => {
      const resetCalls: string[] = [];
      const ctx = createTestContext({
        agentPool: {
          reset: (chatId: string) => { resetCalls.push(chatId); },
          stop: () => false,
        },
      });

      const projectDir = join(ctx.projectManager!.getWorkspaceDir(), 'project');
      mkdirSync(projectDir, { recursive: true });
      ctx.projectManager!.use('chat-1', projectDir);

      const result = await invoke(makeCommand('chat-1', 'reset'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('已重置');
      expect(resetCalls).toContain('chat-1');

      // Verify binding was removed
      const active = ctx.projectManager!.getActive('chat-1');
      expect(active.name).toBe('default');
    });

    it('should reset template-based binding', async () => {
      const ctx = createTestContextWithTemplates();
      ctx.projectManager!.create('chat-1', 'research', 'my-research');

      const result = await invoke(makeCommand('chat-1', 'reset'), ctx);

      expect(result.success).toBe(true);
      expect(ctx.projectManager!.getActive('chat-1').name).toBe('default');
    });

    it('should succeed even when already on default', async () => {
      const ctx = createTestContext();
      const result = await invoke(makeCommand('chat-1', 'reset'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('已重置');
    });
  });
});
