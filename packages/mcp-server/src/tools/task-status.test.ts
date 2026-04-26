/**
 * Tests for get_task_status MCP tool (Issue #857).
 *
 * @module mcp-server/tools/task-status.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Test workspace directory (set in beforeEach)
let testWorkspaceDir: string;

// Mock @disclaude/core — TaskContext is the only import used by task-status.ts
vi.mock('@disclaude/core', () => ({
  TaskContext: {
    load: vi.fn(async (options: { workspaceDir: string }, taskId: string) => {
      const tasksDir = path.join(options.workspaceDir, 'tasks');
      const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const contextPath = path.join(tasksDir, sanitized, 'context.md');
      try {
        const content = await fs.readFile(contextPath, 'utf-8');
        if (!content.includes('**Task ID**')) {return null;}

        const titleMatch = content.match(/^# Task Context: (.+)$/m);
        const taskIdMatch = content.match(/\*\*Task ID\*\*: (.+)$/m);
        const chatIdMatch = content.match(/\*\*Chat ID\*\*: (.+)$/m);
        const statusMatch = content.match(/\*\*Status\*\*: (.+)$/m);
        const createdMatch = content.match(/\*\*Created\*\*: (.+)$/m);
        const startedMatch = content.match(/\*\*Started\*\*: (.+)$/m);
        const completedMatch = content.match(/\*\*Completed\*\*: (.+)$/m);
        const currentMatch = content.match(/\*\*Current Operation\*\*: (.+)$/m);
        const errorMatch = content.match(/\*\*Error\*\*: (.+)$/m);

        const steps: Array<{ description: string; status: string; startedAt?: string; completedAt?: string }> = [];
        const stepPattern = /^(?:✅|🔄|⏭️|⬜) (\d+)\. (.+) \[(\w+)\](?: \(started: ([^)]+)\))?(?: \(completed: ([^)]+)\))?$/gm;
        let stepMatch;
        while ((stepMatch = stepPattern.exec(content)) !== null) {
          steps.push({
            description: stepMatch[2],
            status: stepMatch[3],
            startedAt: stepMatch[4] || undefined,
            completedAt: stepMatch[5] || undefined,
          });
        }

        const data = {
          taskId: taskIdMatch?.[1] || '',
          chatId: chatIdMatch?.[1] || '',
          status: statusMatch?.[1] || 'pending',
          title: titleMatch?.[1] || '',
          steps,
          createdAt: createdMatch?.[1] || '',
          startedAt: startedMatch?.[1],
          completedAt: completedMatch?.[1],
          currentOperation: currentMatch?.[1],
          errorMessage: errorMatch?.[1],
        };

        const completedSteps = steps.filter(s => s.status === 'completed').length;
        const totalSteps = steps.length;
        const parts: string[] = [];
        parts.push(`**Task**: ${data.title}`);
        const statusMap: Record<string, string> = {
          pending: '⬜ 等待中', running: '🔄 执行中',
          completed: '✅ 已完成', failed: '❌ 失败',
        };
        parts.push(`**Status**: ${statusMap[data.status] || data.status}`);
        if (totalSteps > 0) {parts.push(`**Progress**: ${completedSteps}/${totalSteps} steps completed`);}
        if (data.currentOperation) {parts.push(`**Current**: ${data.currentOperation}`);}
        if (data.errorMessage) {parts.push(`**Error**: ${data.errorMessage}`);}
        const summary = parts.join('\n');

        return { getData: () => data, getSummary: () => summary };
      } catch {
        return null;
      }
    }),
  },
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('./credentials.js', () => ({
  getFeishuCredentials: () => ({ appId: 'test', appSecret: 'test' }),
  getWorkspaceDir: () => testWorkspaceDir,
}));

import { get_task_status } from './task-status.js';

describe('get_task_status', () => {
  beforeEach(async () => {
    testWorkspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-status-test-'));
  });

  afterEach(async () => {
    await fs.rm(testWorkspaceDir, { recursive: true, force: true });
  });

  it('should return error when taskId is missing', async () => {
    // @ts-expect-error - testing missing param
    const result = await get_task_status({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('taskId is required');
  });

  it('should return error when no task context exists', async () => {
    const result = await get_task_status({ taskId: 'non-existent' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No task context found');
  });

  it('should return task status for existing task', async () => {
    const tasksDir = path.join(testWorkspaceDir, 'tasks', 'test-task-1');
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(tasksDir, 'context.md'), [
      '# Task Context: Test Task',
      '',
      '**Task ID**: test-task-1',
      '**Chat ID**: oc_chat',
      '**Status**: running',
      '**Created**: 2026-01-01T00:00:00.000Z',
      '**Started**: 2026-01-01T00:01:00.000Z',
      '**Current Operation**: Reading files',
      '',
      '## Steps',
      '',
      '✅ 0. Read requirements [completed] (started: 2026-01-01T00:01:00.000Z) (completed: 2026-01-01T00:02:00.000Z)',
      '🔄 1. Implement changes [running] (started: 2026-01-01T00:02:00.000Z)',
      '⬜ 2. Run tests [pending]',
      '',
    ].join('\n'), 'utf-8');

    const result = await get_task_status({ taskId: 'test-task-1' });

    expect(result.success).toBe(true);
    expect(result.message).toContain('Test Task');
    expect(result.message).toContain('执行中');
    expect(result.message).toContain('Read requirements');
    expect(result.message).toContain('Implement changes');
    expect(result.message).toContain('Run tests');
    expect(result.message).toContain('Reporting Guidance');
  });

  it('should report completed task status', async () => {
    const tasksDir = path.join(testWorkspaceDir, 'tasks', 'done-task');
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(tasksDir, 'context.md'), [
      '# Task Context: Done Task',
      '',
      '**Task ID**: done-task',
      '**Chat ID**: oc_chat',
      '**Status**: completed',
      '**Created**: 2026-01-01T00:00:00.000Z',
      '**Started**: 2026-01-01T00:01:00.000Z',
      '**Completed**: 2026-01-01T00:05:00.000Z',
      '',
      '## Steps',
      '',
      '✅ 0. Do the work [completed]',
      '',
    ].join('\n'), 'utf-8');

    const result = await get_task_status({ taskId: 'done-task' });

    expect(result.success).toBe(true);
    expect(result.message).toContain('completed');
    expect(result.message).toContain('completion card');
  });

  it('should report failed task status', async () => {
    const tasksDir = path.join(testWorkspaceDir, 'tasks', 'fail-task');
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(tasksDir, 'context.md'), [
      '# Task Context: Fail Task',
      '',
      '**Task ID**: fail-task',
      '**Chat ID**: oc_chat',
      '**Status**: failed',
      '**Created**: 2026-01-01T00:00:00.000Z',
      '**Started**: 2026-01-01T00:01:00.000Z',
      '**Completed**: 2026-01-01T00:03:00.000Z',
      '**Error**: Build failed with exit code 1',
      '',
    ].join('\n'), 'utf-8');

    const result = await get_task_status({ taskId: 'fail-task' });

    expect(result.success).toBe(true);
    expect(result.message).toContain('failed');
    expect(result.message).toContain('error notification');
  });
});
