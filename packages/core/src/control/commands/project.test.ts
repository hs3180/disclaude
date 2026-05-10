/**
 * Unit tests for /project command handler.
 *
 * Tests cover:
 * - Subcommand dispatching (via parseArgs / data.args)
 * - `list` — list all instances
 * - `info` — show current chat's active project
 * - `templates` — list available templates
 * - `create` — create instance from template
 * - `use` — switch to an existing instance
 * - `reset` — revert to default project
 * - `status` — show detailed status for a project
 * - Error cases (no ProjectManager, unknown subcommand, missing instance)
 *
 * @see Issue #3335 (Project state persistence)
 * @see Issue #1916 Phase 2 (ProjectManager integration)
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

/**
 * Build a /project command using the data.args format.
 * parseArgs reads `command.data?.args` — either a string or string[].
 */
function makeCommand(
  chatId: string,
  args?: string | string[],
): ControlCommand {
  return {
    type: 'project',
    chatId,
    data: args !== null && args !== undefined ? { args } : undefined,
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
      expect(result.message).toContain('未知子命令');
    });
  });

  describe('no ProjectManager', () => {
    it('should return error when projectManager is not configured', async () => {
      const ctx = createTestContext();
      delete (ctx as Partial<ControlHandlerContext>).projectManager;

      const result = await invoke(makeCommand('chat-1', 'list'), ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('不可用');
    });
  });

  describe('/project (default → info)', () => {
    it('should default to "info" when no args specified', async () => {
      const ctx = createTestContext();
      const cmd: ControlCommand = { type: 'project', chatId: 'chat-1' };
      const result = await invoke(cmd, ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('default');
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

  describe('/project templates', () => {
    it('should list available templates', async () => {
      const ctx = createTestContext();
      const result = await invoke(makeCommand('chat-1', 'templates'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('test-tpl');
    });
  });

  describe('/project create', () => {
    it('should create instance from template', async () => {
      const ctx = createTestContext();

      const result = await invoke(makeCommand('chat-1', ['create', 'test-tpl', 'new-proj']), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('new-proj');
      expect(result.message).toContain('已创建');
    });

    it('should return error for missing arguments', async () => {
      const ctx = createTestContext();

      const result = await invoke(makeCommand('chat-1', ['create', 'test-tpl']), ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('用法');
    });

    it('should return error for duplicate name', async () => {
      const ctx = createTestContext();
      ctx.projectManager!.create('chat-1', 'test-tpl', 'dup-name');

      const result = await invoke(makeCommand('chat-1', ['create', 'test-tpl', 'dup-name']), ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('创建失败');
    });
  });

  describe('/project use', () => {
    it('should switch to an existing instance', async () => {
      const ctx = createTestContext();
      ctx.projectManager!.create('chat-1', 'test-tpl', 'target-proj');

      const result = await invoke(makeCommand('chat-2', ['use', 'target-proj']), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('target-proj');
      expect(result.message).toContain('已切换');
    });

    it('should return error for missing instance name', async () => {
      const ctx = createTestContext();

      const result = await invoke(makeCommand('chat-1', ['use']), ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('用法');
    });

    it('should return error for non-existent instance', async () => {
      const ctx = createTestContext();

      const result = await invoke(makeCommand('chat-1', ['use', 'no-such']), ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('切换失败');
    });
  });

  describe('/project reset', () => {
    it('should reset to default project', async () => {
      const ctx = createTestContext();
      ctx.projectManager!.create('chat-1', 'test-tpl', 'some-proj');

      const result = await invoke(makeCommand('chat-1', 'reset'), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('default');
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

      const result = await invoke(makeCommand('chat-2', ['status', 'target-project']), ctx);

      expect(result.success).toBe(true);
      expect(result.message).toContain('target-project');
    });

    it('should return error for non-existent project name', async () => {
      const ctx = createTestContext();

      const result = await invoke(makeCommand('chat-1', ['status', 'non-existent']), ctx);

      expect(result.success).toBe(false);
      expect(result.message).toContain('不存在');
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
});
