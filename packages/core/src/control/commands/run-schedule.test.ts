/**
 * Tests for /run-schedule command handler (Issue #3249).
 *
 * Verifies manual schedule trigger via control command:
 * - No arguments: list active tasks
 * - With task ID: trigger the task
 * - Error handling: scheduler not initialized, task not found
 */

import { describe, it, expect, vi } from 'vitest';
import type { ControlCommand } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';
import { handleRunSchedule } from './run-schedule.js';

function createMockContext(scheduler?: ControlHandlerContext['scheduler']): ControlHandlerContext {
  return {
    agentPool: {
      reset: vi.fn(),
      stop: vi.fn(),
    },
    node: {
      nodeId: 'test-node',
      getDebugGroup: vi.fn().mockReturnValue(null),
      setDebugGroup: vi.fn(),
      clearDebugGroup: vi.fn().mockReturnValue(null),
    },
    scheduler,
  };
}

describe('handleRunSchedule', () => {
  it('should return error when scheduler is not initialized', async () => {
    const context = createMockContext(undefined);
    const command: ControlCommand = {
      type: 'run-schedule',
      chatId: 'test-chat',
      data: { args: ['task-1'] },
    };

    const result = await handleRunSchedule(command, context);

    expect(result.success).toBe(false);
    expect(result.message).toContain('调度器未初始化');
  });

  it('should list active tasks when no argument provided', async () => {
    const scheduler = {
      triggerTask: vi.fn().mockResolvedValue(true),
      getActiveJobs: vi.fn().mockReturnValue([
        { taskId: 'pr-scanner', task: { name: 'PR Scanner' } },
        { taskId: 'daily-review', task: { name: 'Daily Review' } },
      ]),
    };
    const context = createMockContext(scheduler);
    const command: ControlCommand = {
      type: 'run-schedule',
      chatId: 'test-chat',
      data: { args: [] },
    };

    const result = await handleRunSchedule(command, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('活跃定时任务');
    expect(result.message).toContain('PR Scanner');
    expect(result.message).toContain('Daily Review');
    expect(scheduler.triggerTask).not.toHaveBeenCalled();
  });

  it('should show empty message when no active tasks', async () => {
    const scheduler = {
      triggerTask: vi.fn().mockResolvedValue(true),
      getActiveJobs: vi.fn().mockReturnValue([]),
    };
    const context = createMockContext(scheduler);
    const command: ControlCommand = {
      type: 'run-schedule',
      chatId: 'test-chat',
      data: { args: [] },
    };

    const result = await handleRunSchedule(command, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('没有活跃的定时任务');
  });

  it('should trigger a task when task ID is provided', async () => {
    const scheduler = {
      triggerTask: vi.fn().mockResolvedValue(true),
      getActiveJobs: vi.fn().mockReturnValue([]),
    };
    const context = createMockContext(scheduler);
    const command: ControlCommand = {
      type: 'run-schedule',
      chatId: 'test-chat',
      data: { args: ['pr-scanner'] },
    };

    const result = await handleRunSchedule(command, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('已触发');
    expect(scheduler.triggerTask).toHaveBeenCalledWith('pr-scanner');
  });

  it('should return failure when task not found or disabled', async () => {
    const scheduler = {
      triggerTask: vi.fn().mockResolvedValue(false),
      getActiveJobs: vi.fn().mockReturnValue([]),
    };
    const context = createMockContext(scheduler);
    const command: ControlCommand = {
      type: 'run-schedule',
      chatId: 'test-chat',
      data: { args: ['nonexistent-task'] },
    };

    const result = await handleRunSchedule(command, context);

    expect(result.success).toBe(false);
    expect(result.message).toContain('未找到或已禁用');
    expect(result.message).toContain('nonexistent-task');
  });

  it('should handle missing data.args gracefully', async () => {
    const scheduler = {
      triggerTask: vi.fn().mockResolvedValue(true),
      getActiveJobs: vi.fn().mockReturnValue([]),
    };
    const context = createMockContext(scheduler);
    const command: ControlCommand = {
      type: 'run-schedule',
      chatId: 'test-chat',
    };

    const result = await handleRunSchedule(command, context);

    // No args → list mode
    expect(result.success).toBe(true);
    expect(result.message).toContain('没有活跃的定时任务');
  });
});
