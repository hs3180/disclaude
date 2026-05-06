/**
 * Unit tests for project management control commands.
 *
 * @see Issue #3335 (Phase 5: Project state persistence and admin commands)
 */

import { describe, it, expect, vi } from 'vitest';
import { handleProjectStatus, handleProjectTrigger, handleProjectStop, handleProjectList } from './project.js';
import type { ControlHandlerContext } from '../types.js';

function createMockContext(overrides?: Partial<ControlHandlerContext>): ControlHandlerContext {
  return {
    agentPool: { reset: vi.fn(), stop: vi.fn().mockReturnValue(true) },
    node: {
      nodeId: 'test-node-id',
      getDebugGroup: vi.fn().mockReturnValue(null),
      setDebugGroup: vi.fn(),
      clearDebugGroup: vi.fn().mockReturnValue(null),
    },
    ...overrides,
  };
}

function createMockProjectContext(): NonNullable<ControlHandlerContext['project']> {
  return {
    listProjects: vi.fn().mockReturnValue([
      { key: 'owner/repo', chatId: 'oc_123', workingDir: '.', modelTier: 'low', idleTimeoutMs: 1800000 },
    ]),
    getProjectStatus: vi.fn().mockReturnValue('📁 **项目**: owner/repo\n🕐 **最后活跃**: 2026-05-06'),
    triggerProject: vi.fn().mockReturnValue('✅ 已触发 owner/repo 的任务'),
    stopProject: vi.fn().mockReturnValue('✅ 已停止 owner/repo 的 Agent'),
  };
}

// ───────────────────────────────────────────
// handleProjectStatus
// ───────────────────────────────────────────

describe('handleProjectStatus', () => {
  it('should return error when project context is not available', async () => {
    const context = createMockContext();
    const result = await handleProjectStatus(
      { type: 'project-status', chatId: 'chat-1' },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('未启用');
  });

  it('should return project status when project context is available', async () => {
    const project = createMockProjectContext();
    const context = createMockContext({ project });

    const result = await handleProjectStatus(
      { type: 'project-status', chatId: 'chat-1' },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('owner/repo');
    expect(project.getProjectStatus).toHaveBeenCalledWith(undefined);
  });

  it('should pass projectKey to getProjectStatus when provided', async () => {
    const project = createMockProjectContext();
    const context = createMockContext({ project });

    const result = await handleProjectStatus(
      { type: 'project-status', chatId: 'chat-1', data: { projectKey: 'owner/repo' } },
      context,
    );

    expect(result.success).toBe(true);
    expect(project.getProjectStatus).toHaveBeenCalledWith('owner/repo');
  });

  it('should return error when getProjectStatus throws', async () => {
    const project = createMockProjectContext();
    project.getProjectStatus = vi.fn().mockImplementation(() => {
      throw new Error('State read failed');
    });
    const context = createMockContext({ project });

    const result = await handleProjectStatus(
      { type: 'project-status', chatId: 'chat-1' },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('State read failed');
  });
});

// ───────────────────────────────────────────
// handleProjectTrigger
// ───────────────────────────────────────────

describe('handleProjectTrigger', () => {
  it('should return error when project context is not available', async () => {
    const context = createMockContext();
    const result = await handleProjectTrigger(
      { type: 'project-trigger', chatId: 'chat-1' },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('未启用');
  });

  it('should return error when projectKey is not provided', async () => {
    const project = createMockProjectContext();
    const context = createMockContext({ project });

    const result = await handleProjectTrigger(
      { type: 'project-trigger', chatId: 'chat-1' },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('用法');
  });

  it('should trigger project when projectKey is provided', async () => {
    const project = createMockProjectContext();
    const context = createMockContext({ project });

    const result = await handleProjectTrigger(
      { type: 'project-trigger', chatId: 'chat-1', data: { projectKey: 'owner/repo' } },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('已触发');
    expect(project.triggerProject).toHaveBeenCalledWith('owner/repo');
  });

  it('should return error when triggerProject throws', async () => {
    const project = createMockProjectContext();
    project.triggerProject = vi.fn().mockImplementation(() => {
      throw new Error('Trigger failed');
    });
    const context = createMockContext({ project });

    const result = await handleProjectTrigger(
      { type: 'project-trigger', chatId: 'chat-1', data: { projectKey: 'owner/repo' } },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Trigger failed');
  });
});

// ───────────────────────────────────────────
// handleProjectStop
// ───────────────────────────────────────────

describe('handleProjectStop', () => {
  it('should return error when project context is not available', async () => {
    const context = createMockContext();
    const result = await handleProjectStop(
      { type: 'project-stop', chatId: 'chat-1' },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('未启用');
  });

  it('should return error when projectKey is not provided', async () => {
    const project = createMockProjectContext();
    const context = createMockContext({ project });

    const result = await handleProjectStop(
      { type: 'project-stop', chatId: 'chat-1' },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('用法');
  });

  it('should stop project when projectKey is provided', async () => {
    const project = createMockProjectContext();
    const context = createMockContext({ project });

    const result = await handleProjectStop(
      { type: 'project-stop', chatId: 'chat-1', data: { projectKey: 'owner/repo' } },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('已停止');
    expect(project.stopProject).toHaveBeenCalledWith('owner/repo');
  });

  it('should return error when stopProject throws', async () => {
    const project = createMockProjectContext();
    project.stopProject = vi.fn().mockImplementation(() => {
      throw new Error('Stop failed');
    });
    const context = createMockContext({ project });

    const result = await handleProjectStop(
      { type: 'project-stop', chatId: 'chat-1', data: { projectKey: 'owner/repo' } },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Stop failed');
  });
});

// ───────────────────────────────────────────
// handleProjectList
// ───────────────────────────────────────────

describe('handleProjectList', () => {
  it('should return error when project context is not available', async () => {
    const context = createMockContext();
    const result = await handleProjectList(
      { type: 'project-list', chatId: 'chat-1' },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('未启用');
  });

  it('should return empty message when no projects configured', async () => {
    const project = createMockProjectContext();
    project.listProjects = vi.fn().mockReturnValue([]);
    const context = createMockContext({ project });

    const result = await handleProjectList(
      { type: 'project-list', chatId: 'chat-1' },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('没有配置任何项目');
  });

  it('should list all configured projects', async () => {
    const project = createMockProjectContext();
    const context = createMockContext({ project });

    const result = await handleProjectList(
      { type: 'project-list', chatId: 'chat-1' },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('已配置的项目');
    expect(result.message).toContain('owner/repo');
    expect(result.message).toContain('oc_123');
    expect(result.message).toContain('low');
  });

  it('should include idle timeout when configured', async () => {
    const project = createMockProjectContext();
    const context = createMockContext({ project });

    const result = await handleProjectList(
      { type: 'project-list', chatId: 'chat-1' },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('30 分钟');
  });

  it('should handle minimal project config', async () => {
    const project = createMockProjectContext();
    project.listProjects = vi.fn().mockReturnValue([
      { key: 'minimal/project' },
    ]);
    const context = createMockContext({ project });

    const result = await handleProjectList(
      { type: 'project-list', chatId: 'chat-1' },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('minimal/project');
  });

  it('should return error when listProjects throws', async () => {
    const project = createMockProjectContext();
    project.listProjects = vi.fn().mockImplementation(() => {
      throw new Error('List failed');
    });
    const context = createMockContext({ project });

    const result = await handleProjectList(
      { type: 'project-list', chatId: 'chat-1' },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('List failed');
  });
});
