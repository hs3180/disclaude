/**
 * Unit tests for /project command handler.
 *
 * Tests cover:
 * - Subcommand dispatching
 * - `list` — list all instances
 * - `info` — show current chat's active project
 * - `status` — show detailed status for a project
 * - `stop` — stop and dispose a project agent
 * - `trigger` — trigger a task for a project agent
 * - Error cases (no ProjectManager, unknown subcommand, missing instance)
 *
 * @see Issue #3335 (Project state persistence)
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
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
  const packageDir = join(workspaceDir, 'pkg');

  // Create a template for testing
  const tplDir = join(packageDir, 'templates', 'test-tpl');
  mkdirSync(tplDir, { recursive: true });
  writeFileSync(join(tplDir, 'CLAUDE.md'), '# Test');

  const pm = new ProjectManager({
    workspaceDir,
    packageDir,
  });

  return {
    agentPool: {
      reset: () => {},
      stop: () => false,
      dispose: () => false,
      has: () => false,
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
): ControlCommand {
  return {
    type: 'project',
    chatId,
    data: { subcommand, ...data },
  };
}

/** Resolve the possibly-async handler result */
async function invoke(
  cmd: ControlCommand,
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

      const result = await invoke(makeCommand('chat-1', 'list'), ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('ProjectManager 未配置');
    });
  });

  describe('/project list', () => {
    it('should show empty list message when no instances', async () => {
      const ctx = createTestContext();
      const result = await invoke(makeCommand('chat-1', 'list'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('暂无项目实例');
    });

    it('should list existing instances', async () => {
      const ctx = createTestContext();
      ctx.projectManager!.create('chat-1', 'test-tpl', 'my-project');

      const result = await invoke(makeCommand('chat-1', 'list'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('my-project');
      expect(result.message).toContain('test-tpl');
    });
  });

  describe('/project info', () => {
    it('should show default project when no binding', async () => {
      const ctx = createTestContext();
      const result = await invoke(makeCommand('chat-1', 'info'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('default');
    });

    it('should show active project info', async () => {
      const ctx = createTestContext();
      const createResult = ctx.projectManager!.create('chat-1', 'test-tpl', 'my-project');
      expect(createResult.ok).toBe(true);

      const result = await invoke(makeCommand('chat-1', 'info'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('my-project');
      expect(result.message).toContain('test-tpl');
    });

    it('should include state summary when project state exists', async () => {
      const ctx = createTestContext();
      const createResult = ctx.projectManager!.create('chat-1', 'test-tpl', 'my-project');
      expect(createResult.ok).toBe(true);

      const workingDir = createResult.ok ? createResult.data.workingDir : '';

      // Create a project state file
      const stateDir = join(workingDir, '.disclaude');
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

  describe('/project status', () => {
    it('should show status for current project when no name given', async () => {
      const ctx = createTestContext();
      const createResult = ctx.projectManager!.create('chat-1', 'test-tpl', 'my-project');
      expect(createResult.ok).toBe(true);

      const result = await invoke(makeCommand('chat-1', 'status'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('my-project');
    });

    it('should show status for named project', async () => {
      const ctx = createTestContext();
      const createResult = ctx.projectManager!.create('chat-1', 'test-tpl', 'target-project');
      expect(createResult.ok).toBe(true);

      const result = await invoke(makeCommand('chat-2', 'status', { name: 'target-project' }), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('target-project');
    });

    it('should return error for non-existent project name', async () => {
      const ctx = createTestContext();

      const result = await invoke(makeCommand('chat-1', 'status', { name: 'non-existent' }), ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('不存在');
    });

    it('should show default message when unbound chat queries status', async () => {
      const ctx = createTestContext();

      const result = await invoke(makeCommand('chat-1', 'status'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('未绑定');
    });

    it('should show state details when project state exists', async () => {
      const ctx = createTestContext();
      const createResult = ctx.projectManager!.create('chat-1', 'test-tpl', 'stateful-project');
      expect(createResult.ok).toBe(true);

      const workingDir = createResult.ok ? createResult.data.workingDir : '';
      const stateDir = join(workingDir, '.disclaude');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'project-state.json'), JSON.stringify({
        version: 1,
        projectKey: 'test/repo',
        lastActive: '2026-05-10T10:00:00Z',
        sync: { issues: '2026-05-10T09:00:00Z', prs: '2026-05-10T08:00:00Z' },
        issues: {
          '1': { title: 'First', state: 'open', triageStatus: 'triaged', labels: [] },
          '2': { title: 'Second', state: 'closed', triageStatus: 'resolved', labels: ['bug'] },
        },
        prs: {
          '10': { title: 'PR One', reviewStatus: 'approved', issueNumber: 1 },
        },
      }));

      const result = await invoke(makeCommand('chat-1', 'status'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('First');
      expect(result.message).toContain('Second');
      expect(result.message).toContain('PR One');
      expect(result.message).toContain('test/repo');
    });
  });

  describe('default subcommand', () => {
    it('should default to "info" when no subcommand specified', async () => {
      const ctx = createTestContext();
      const cmd: ControlCommand = { type: 'project', chatId: 'chat-1' };
      const result = await invoke(cmd, ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('default');
    });
  });

  describe('/project stop', () => {
    it('should return error when no name provided', async () => {
      const ctx = createTestContext();
      const result = await invoke(makeCommand('chat-1', 'stop'), ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('请指定项目名称');
    });

    it('should return error for non-existent project', async () => {
      const ctx = createTestContext();
      const result = await invoke(makeCommand('chat-1', 'stop', { name: 'no-such-project' }), ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('不存在');
    });

    it('should dispose agents for project with active agents', async () => {
      const disposeFn = vi.fn().mockReturnValue(true);
      const hasFn = vi.fn().mockReturnValue(true);
      const ctx = createTestContext({
        agentPool: {
          reset: () => {},
          stop: () => false,
          dispose: disposeFn,
          has: hasFn,
        },
      });
      ctx.projectManager!.create('chat-1', 'test-tpl', 'my-project');

      const result = await invoke(makeCommand('chat-1', 'stop', { name: 'my-project' }), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('已停止');
      expect(result.message).toContain('已释放 1 个 Agent 会话');
      expect(disposeFn).toHaveBeenCalledWith('chat-1');
    });

    it('should report skipped chatIds with no active agent', async () => {
      const hasFn = vi.fn().mockReturnValue(false);
      const disposeFn = vi.fn().mockReturnValue(false);
      const ctx = createTestContext({
        agentPool: {
          reset: () => {},
          stop: () => false,
          dispose: disposeFn,
          has: hasFn,
        },
      });
      ctx.projectManager!.create('chat-1', 'test-tpl', 'idle-project');

      const result = await invoke(makeCommand('chat-1', 'stop', { name: 'idle-project' }), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('1 个会话无活跃 Agent');
      expect(disposeFn).not.toHaveBeenCalled();
    });
  });

  describe('/project trigger', () => {
    it('should return error when no name provided', async () => {
      const ctx = createTestContext();
      const result = await invoke(makeCommand('chat-1', 'trigger'), ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('请指定项目名称');
    });

    it('should return error when triggerAgent is not configured', async () => {
      const ctx = createTestContext();
      ctx.projectManager!.create('chat-1', 'test-tpl', 'my-project');

      const result = await invoke(makeCommand('chat-1', 'trigger', { name: 'my-project' }), ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('triggerAgent 未配置');
    });

    it('should return error for project with no bound chatIds', async () => {
      const triggerFn = vi.fn().mockResolvedValue(undefined);
      const ctx = createTestContext({ triggerAgent: triggerFn });
      // Create project bound to chat-1 but query from chat-2 with explicit name
      // Use a separate chat so chatIds are bound correctly
      ctx.projectManager!.create('chat-1', 'test-tpl', 'bound-project');

      // Now unbind chat-1 to create a project with no chatIds
      ctx.projectManager!.reset('chat-1');

      const result = await invoke(makeCommand('chat-2', 'trigger', { name: 'bound-project' }), ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('没有绑定任何会话');
    });

    it('should trigger agent with default prompt', async () => {
      const triggerFn = vi.fn().mockResolvedValue(undefined);
      const ctx = createTestContext({ triggerAgent: triggerFn });
      ctx.projectManager!.create('chat-1', 'test-tpl', 'my-project');

      const result = await invoke(makeCommand('chat-1', 'trigger', { name: 'my-project' }), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('任务已触发');
      expect(triggerFn).toHaveBeenCalledWith('chat-1', '请检查项目状态并汇报');
    });

    it('should trigger agent with custom prompt', async () => {
      const triggerFn = vi.fn().mockResolvedValue(undefined);
      const ctx = createTestContext({ triggerAgent: triggerFn });
      ctx.projectManager!.create('chat-1', 'test-tpl', 'my-project');

      const result = await invoke(
        makeCommand('chat-1', 'trigger', { name: 'my-project', prompt: 'run tests' }),
        ctx,
      );

      expect(result.success).toBe(true);
      expect(triggerFn).toHaveBeenCalledWith('chat-1', 'run tests');
    });

    it('should return error when triggerAgent throws', async () => {
      const triggerFn = vi.fn().mockRejectedValue(new Error('Agent busy'));
      const ctx = createTestContext({ triggerAgent: triggerFn });
      ctx.projectManager!.create('chat-1', 'test-tpl', 'my-project');

      const result = await invoke(makeCommand('chat-1', 'trigger', { name: 'my-project' }), ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Agent busy');
    });
  });
});
