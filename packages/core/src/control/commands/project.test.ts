/**
 * Unit tests for /project command handler.
 *
 * Tests cover:
 * - Subcommand dispatching
 * - `use <workingDir>` — bind chat to a working directory
 * - `reset` — reset chat to default workspace
 * - `info` — show current chat's active project info
 * - `status` — show all configured projects and runtime state
 * - `stop <key>` — stop agent for a configured project
 * - Error cases (no ProjectManager, unknown subcommand, missing args)
 *
 * @see Issue #3519 (simplify /project command)
 * @see Issue #3329 Phase 5 (Configuration & DX)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ControlCommand } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';
import { handleProject } from './project.js';
import { ProjectManager } from '../../project/project-manager.js';
import type { ConfiguredProject } from '../../project/types.js';

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

  describe('/project status', () => {
    it('should show empty message when no projects or bindings', async () => {
      const ctx = createTestContext();
      const result = await invoke(makeCommand('chat-1', 'status'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('没有已配置的项目');
    });

    it('should show configured projects from config', async () => {
      const workspaceDir = createTempDir();
      const pm = new ProjectManager({
        workspaceDir,
        configuredProjects: [
          { key: 'owner/repo', workingDir: './repos/repo', chatId: 'oc_chat123456789', modelTier: 'low' },
        ],
      });

      const ctx: ControlHandlerContext = {
        agentPool: { reset: () => {}, stop: () => false },
        node: {
          nodeId: 'test-node',
          getDebugGroup: () => null,
          setDebugGroup: () => {},
          clearDebugGroup: () => null,
        },
        projectManager: pm,
      };

      const result = await invoke(makeCommand('chat-1', 'status'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('owner/repo');
      expect(result.message).toContain('oc_chat12345');
    });

    it('should show runtime bindings', async () => {
      const ctx = createTestContext();
      const projectDir = join(ctx.projectManager!.getWorkspaceDir(), 'my-project');
      mkdirSync(projectDir, { recursive: true });
      ctx.projectManager!.use('chat-999', projectDir);

      const result = await invoke(makeCommand('chat-1', 'status'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('my-project');
    });

    it('should show both configured and runtime bindings', async () => {
      const workspaceDir = createTempDir();
      const pm = new ProjectManager({
        workspaceDir,
        configuredProjects: [
          { key: 'owner/repo', workingDir: './repos/repo', chatId: 'oc_configured_chat' },
        ],
      });

      const projectDir = join(workspaceDir, 'runtime-project');
      mkdirSync(projectDir, { recursive: true });
      pm.use('chat-runtime', projectDir);

      const ctx: ControlHandlerContext = {
        agentPool: { reset: () => {}, stop: () => false },
        node: {
          nodeId: 'test-node',
          getDebugGroup: () => null,
          setDebugGroup: () => {},
          clearDebugGroup: () => null,
        },
        projectManager: pm,
      };

      const result = await invoke(makeCommand('chat-1', 'status'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('owner/repo');
      expect(result.message).toContain('runtime-project');
    });

    it('should return error when projectManager is not configured', async () => {
      const ctx = createTestContext();
      delete (ctx as Partial<ControlHandlerContext>).projectManager;

      const result = await invoke(makeCommand('chat-1', 'status'), ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('ProjectManager 未配置');
    });
  });

  describe('/project stop', () => {
    function createTestContextWithProjects(
      projects: ConfiguredProject[],
      stopFn?: (chatId: string) => boolean,
    ): ControlHandlerContext {
      const workspaceDir = createTempDir();
      const pm = new ProjectManager({ workspaceDir, configuredProjects: projects });

      return {
        agentPool: {
          reset: () => {},
          stop: stopFn ?? (() => false),
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

    it('should stop agent for a configured project with chatId', async () => {
      const stoppedChatIds: string[] = [];
      const ctx = createTestContextWithProjects(
        [{ key: 'owner/repo', workingDir: './repo', chatId: 'oc_target_chat' }],
        (chatId) => { stoppedChatIds.push(chatId); return true; },
      );

      const result = await invoke(
        makeCommand('chat-1', 'stop', { projectKey: 'owner/repo' }),
        ctx,
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('已停止');
      expect(stoppedChatIds).toContain('oc_target_chat');
    });

    it('should report no running agent when stop returns false', async () => {
      const ctx = createTestContextWithProjects(
        [{ key: 'owner/repo', workingDir: './repo', chatId: 'oc_target_chat' }],
        () => false,
      );

      const result = await invoke(
        makeCommand('chat-1', 'stop', { projectKey: 'owner/repo' }),
        ctx,
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('没有正在运行');
    });

    it('should return error when projectKey is missing', async () => {
      const ctx = createTestContextWithProjects([]);
      const result = await invoke(makeCommand('chat-1', 'stop'), ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('projectKey');
    });

    it('should return error for unknown project key', async () => {
      const ctx = createTestContextWithProjects(
        [{ key: 'owner/repo', workingDir: './repo', chatId: 'oc_chat' }],
      );

      const result = await invoke(
        makeCommand('chat-1', 'stop', { projectKey: 'unknown/key' }),
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('未找到项目');
      expect(result.error).toContain('owner/repo');
    });

    it('should return error when project has no chatId', async () => {
      const ctx = createTestContextWithProjects(
        [{ key: 'owner/repo', workingDir: './repo' }],
      );

      const result = await invoke(
        makeCommand('chat-1', 'stop', { projectKey: 'owner/repo' }),
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('没有绑定 chatId');
    });

    it('should return error when projectManager is not configured', async () => {
      const ctx = createTestContext();
      delete (ctx as Partial<ControlHandlerContext>).projectManager;

      const result = await invoke(
        makeCommand('chat-1', 'stop', { projectKey: 'owner/repo' }),
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('ProjectManager 未配置');
    });
  });
});
