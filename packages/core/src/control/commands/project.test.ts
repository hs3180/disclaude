/**
 * Unit tests for /project command handler.
 *
 * Tests cover:
 * - Subcommand dispatching
 * - `use <workingDir>` — bind chat to a working directory
 * - `reset` — reset chat to default workspace
 * - `info` — show current chat's active project info
 * - Error cases (no ProjectManager, unknown subcommand, missing args)
 *
 * @see Issue #3519 (simplify /project command)
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
      expect(result.error).toContain('workingDir');
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

  describe('/project list', () => {
    it('should show empty message when no bindings exist', async () => {
      const ctx = createTestContext();
      const result = await invoke(makeCommand('chat-1', 'list'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('无活跃项目绑定');
    });

    it('should list all active bindings', async () => {
      const ctx = createTestContext();
      const wsDir = ctx.projectManager!.getWorkspaceDir();

      const projectDirA = join(wsDir, 'project-a');
      const projectDirB = join(wsDir, 'project-b');
      mkdirSync(projectDirA, { recursive: true });
      mkdirSync(projectDirB, { recursive: true });

      ctx.projectManager!.use('chat-1', projectDirA);
      ctx.projectManager!.use('chat-2', projectDirB);

      const result = await invoke(makeCommand('chat-1', 'list'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('2 个');
      expect(result.message).toContain('chat-1');
      expect(result.message).toContain('project-a');
      expect(result.message).toContain('chat-2');
      expect(result.message).toContain('project-b');
    });

    it('should return error when projectManager is not configured', async () => {
      const ctx = createTestContext();
      delete (ctx as Partial<ControlHandlerContext>).projectManager;

      const result = await invoke(makeCommand('chat-1', 'list'), ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('ProjectManager 未配置');
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

    it('should succeed even when already on default', async () => {
      const ctx = createTestContext();
      const result = await invoke(makeCommand('chat-1', 'reset'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('已重置');
    });
  });
});
