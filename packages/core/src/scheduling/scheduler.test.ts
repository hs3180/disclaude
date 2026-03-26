/**
 * Tests for Scheduler (packages/core/src/scheduling/scheduler.ts)
 *
 * Tests the core scheduling logic including:
 * - Task scheduling with cron jobs
 * - Task execution lifecycle
 * - Blocking mechanism (skip if previous still running)
 * - Cooldown integration
 * - Anti-recursion prompt wrapping
 * - Scheduler start/stop/reload
 *
 * Issue #1617 Phase 2: Agent layer + scheduling tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mock Definitions (all inside vi.hoisted to avoid hoisting issues)
// ============================================================================

const { mockCronStop, mockCronJob, mockIsInCooldown, mockGetCooldownStatus, mockRecordExecution, mockClearCooldown, mockListEnabled } = vi.hoisted(() => {
  const mockCronStop = vi.fn();
  const mockCronJob = vi.fn().mockImplementation(() => ({
    stop: mockCronStop,
  }));

  return {
    mockCronStop,
    mockCronJob,
    mockIsInCooldown: vi.fn().mockResolvedValue(false),
    mockGetCooldownStatus: vi.fn().mockResolvedValue({
      isInCooldown: false,
      lastExecutionTime: null,
      cooldownEndsAt: null,
      remainingMs: 0,
    }),
    mockRecordExecution: vi.fn().mockResolvedValue(undefined),
    mockClearCooldown: vi.fn().mockResolvedValue(true),
    mockListEnabled: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('cron', () => ({
  CronJob: mockCronJob,
}));

vi.mock('./cooldown-manager.js', () => ({
  CooldownManager: vi.fn().mockImplementation(() => ({
    isInCooldown: mockIsInCooldown,
    getCooldownStatus: mockGetCooldownStatus,
    recordExecution: mockRecordExecution,
    clearCooldown: mockClearCooldown,
  })),
}));

vi.mock('./schedule-manager.js', () => ({
  ScheduleManager: vi.fn().mockImplementation(() => ({
    listEnabled: mockListEnabled,
  })),
}));

// Import after mocks
import { Scheduler } from './scheduler.js';
import type { ScheduledTask } from './scheduled-task.js';

// ============================================================================
// Helpers
// ============================================================================

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'schedule-test-task',
    name: 'Test Task',
    cron: '0 9 * * *',
    prompt: 'Execute test task',
    chatId: 'oc_test123',
    enabled: true,
    blocking: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const mockScheduleManager = {
  listEnabled: mockListEnabled,
} as any;

const mockCallbacks = {
  sendMessage: vi.fn().mockResolvedValue(undefined),
};

const mockExecutor = vi.fn().mockResolvedValue(undefined);

// ============================================================================
// Tests
// ============================================================================

describe('Scheduler', () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply mock implementations after clearAllMocks
    mockCronJob.mockImplementation(() => ({ stop: mockCronStop }));
    mockIsInCooldown.mockResolvedValue(false);
    mockGetCooldownStatus.mockResolvedValue({
      isInCooldown: false,
      lastExecutionTime: null,
      cooldownEndsAt: null,
      remainingMs: 0,
    });
    mockRecordExecution.mockResolvedValue(undefined);
    mockClearCooldown.mockResolvedValue(true);
    mockListEnabled.mockResolvedValue([]);
    mockExecutor.mockResolvedValue(undefined);
    mockCallbacks.sendMessage.mockResolvedValue(undefined);

    scheduler = new Scheduler({
      scheduleManager: mockScheduleManager,
      callbacks: mockCallbacks,
      executor: mockExecutor,
    });
  });

  describe('constructor', () => {
    it('should create a scheduler with required options', () => {
      expect(scheduler).toBeDefined();
      expect(scheduler.isRunning()).toBe(false);
    });

    it('should accept optional cooldownManager', () => {
      const s = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        executor: mockExecutor,
        cooldownManager: {} as any,
      });
      expect(s).toBeDefined();
    });
  });

  describe('start', () => {
    it('should start and schedule all enabled tasks', async () => {
      const task = createTask();
      mockListEnabled.mockResolvedValue([task]);

      await scheduler.start();

      expect(scheduler.isRunning()).toBe(true);
      expect(mockCronJob).toHaveBeenCalledTimes(1);
      expect(mockCronJob).toHaveBeenCalledWith(
        task.cron,
        expect.any(Function),
        null,
        true,
        'Asia/Shanghai',
      );
    });

    it('should not start twice', async () => {
      await scheduler.start();
      await scheduler.start();

      expect(scheduler.isRunning()).toBe(true);
      // Only one start log warning
    });

    it('should handle empty task list', async () => {
      mockListEnabled.mockResolvedValue([]);

      await scheduler.start();

      expect(scheduler.isRunning()).toBe(true);
      expect(mockCronJob).not.toHaveBeenCalled();
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should not schedule disabled tasks', async () => {
      const task = createTask({ enabled: false });
      mockListEnabled.mockResolvedValue([task]);

      await scheduler.start();

      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should handle multiple enabled tasks', async () => {
      const tasks = [
        createTask({ id: 'task-1', name: 'Task 1' }),
        createTask({ id: 'task-2', name: 'Task 2', cron: '0 18 * * *' }),
      ];
      mockListEnabled.mockResolvedValue(tasks);

      await scheduler.start();

      expect(scheduler.getActiveJobs()).toHaveLength(2);
    });

    it('should handle invalid cron expression gracefully', async () => {
      const task = createTask({ cron: 'invalid-cron' });
      mockListEnabled.mockResolvedValue([task]);
      mockCronJob.mockImplementationOnce(() => {
        throw new Error('Invalid cron expression');
      });

      await scheduler.start();

      // Should not throw, just skip the invalid task
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });
  });

  describe('stop', () => {
    it('should stop all active cron jobs', async () => {
      const task = createTask();
      mockListEnabled.mockResolvedValue([task]);

      await scheduler.start();
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      scheduler.stop();

      expect(scheduler.isRunning()).toBe(false);
      expect(mockCronStop).toHaveBeenCalled();
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should be safe to call stop when not running', () => {
      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
    });
  });

  describe('addTask', () => {
    it('should create a cron job for an enabled task', () => {
      const task = createTask();

      scheduler.addTask(task);

      expect(scheduler.getActiveJobs()).toHaveLength(1);
      expect(mockCronJob).toHaveBeenCalledWith(
        task.cron,
        expect.any(Function),
        null,
        true,
        'Asia/Shanghai',
      );
    });

    it('should not schedule a disabled task', () => {
      const task = createTask({ enabled: false });

      scheduler.addTask(task);

      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should replace existing task with same ID', () => {
      const task1 = createTask({ id: 'task-1', cron: '0 9 * * *' });
      const task2 = createTask({ id: 'task-1', cron: '0 18 * * *' });

      scheduler.addTask(task1);
      scheduler.addTask(task2);

      expect(scheduler.getActiveJobs()).toHaveLength(1);
      // CronJob should have been called twice (once for each add)
      // First job should be stopped, second created
      expect(mockCronStop).toHaveBeenCalledTimes(1);
    });

    it('should handle invalid cron expression', () => {
      const task = createTask({ cron: 'bad' });
      mockCronJob.mockImplementationOnce(() => {
        throw new Error('Invalid');
      });

      scheduler.addTask(task);

      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });
  });

  describe('removeTask', () => {
    it('should remove an existing task', () => {
      const task = createTask();
      scheduler.addTask(task);
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      scheduler.removeTask(task.id);

      expect(scheduler.getActiveJobs()).toHaveLength(0);
      expect(mockCronStop).toHaveBeenCalled();
    });

    it('should handle removing non-existent task gracefully', () => {
      scheduler.removeTask('non-existent');
      // Should not throw
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });
  });

  describe('executeTask (via CronJob callback)', () => {
    it('should execute task with wrapped prompt', async () => {
      const task = createTask();
      let cronCallback: (() => void) | undefined;

      mockCronJob.mockImplementationOnce((_cron: string, cb: () => void) => {
        cronCallback = cb;
        return { stop: mockCronStop };
      });

      scheduler.addTask(task);
      expect(cronCallback).toBeDefined();

      // Execute the cron callback
      await (cronCallback as () => Promise<void>)();

      expect(mockExecutor).toHaveBeenCalledTimes(1);
      const [chatId, prompt, userId] = mockExecutor.mock.calls[0];
      expect(chatId).toBe(task.chatId);
      expect(prompt).toContain('⚠️ **Scheduled Task Execution Context**');
      expect(prompt).toContain(task.name);
      expect(prompt).toContain('Do NOT create new scheduled tasks');
      expect(prompt).toContain(task.prompt);
      expect(userId).toBe(task.createdBy);
    });

    it('should send start notification before execution', async () => {
      const task = createTask();
      let cronCallback: (() => void) | undefined;

      mockCronJob.mockImplementationOnce((_: string, cb: () => void) => {
        cronCallback = cb;
        return { stop: mockCronStop };
      });

      scheduler.addTask(task);
      await (cronCallback as () => Promise<void>)();

      // Check that sendMessage was called with start notification
      const calls = mockCallbacks.sendMessage.mock.calls;
      expect(calls[0][1]).toContain('开始执行');
    });

    it('should send error notification on failure', async () => {
      const task = createTask();
      let cronCallback: (() => void) | undefined;

      mockExecutor.mockRejectedValueOnce(new Error('Execution failed'));
      mockCronJob.mockImplementationOnce((_: string, cb: () => void) => {
        cronCallback = cb;
        return { stop: mockCronStop };
      });

      scheduler.addTask(task);
      await (cronCallback as () => Promise<void>)();

      // Check error notification
      const calls = mockCallbacks.sendMessage.mock.calls;
      const errorCall = calls.find((c: any[]) => c[1].includes('执行失败'));
      expect(errorCall).toBeDefined();
      expect(errorCall![1]).toContain('Execution failed');
    });

    it('should handle non-Error thrown values', async () => {
      const task = createTask();
      let cronCallback: (() => void) | undefined;

      mockExecutor.mockRejectedValueOnce('string error');
      mockCronJob.mockImplementationOnce((_: string, cb: () => void) => {
        cronCallback = cb;
        return { stop: mockCronStop };
      });

      scheduler.addTask(task);
      await (cronCallback as () => Promise<void>)();

      const calls = mockCallbacks.sendMessage.mock.calls;
      const errorCall = calls.find((c: any[]) => c[1].includes('执行失败'));
      expect(errorCall).toBeDefined();
      expect(errorCall![1]).toContain('string error');
    });

    it('should clean up running task after execution completes', async () => {
      const task = createTask({ blocking: true });
      let cronCallback: (() => void) | undefined;

      mockCronJob.mockImplementationOnce((_: string, cb: () => void) => {
        cronCallback = cb;
        return { stop: mockCronStop };
      });

      scheduler.addTask(task);
      expect(scheduler.isTaskRunning(task.id)).toBe(false);

      const executionPromise = (cronCallback as () => Promise<void>)();
      expect(scheduler.isTaskRunning(task.id)).toBe(true);

      await executionPromise;
      expect(scheduler.isTaskRunning(task.id)).toBe(false);
    });

    it('should clean up running task even after failure', async () => {
      const task = createTask({ blocking: true });
      let cronCallback: (() => void) | undefined;

      mockExecutor.mockRejectedValueOnce(new Error('fail'));
      mockCronJob.mockImplementationOnce((_: string, cb: () => void) => {
        cronCallback = cb;
        return { stop: mockCronStop };
      });

      scheduler.addTask(task);
      await (cronCallback as () => Promise<void>)();
      expect(scheduler.isTaskRunning(task.id)).toBe(false);
    });

    it('should pass model override to executor (Issue #1338)', async () => {
      const task = createTask({ model: 'claude-sonnet-4-20250514' });
      let cronCallback: (() => void) | undefined;

      mockCronJob.mockImplementationOnce((_: string, cb: () => void) => {
        cronCallback = cb;
        return { stop: mockCronStop };
      });

      scheduler.addTask(task);
      await (cronCallback as () => Promise<void>)();

      const [, , , model] = mockExecutor.mock.calls[0];
      expect(model).toBe('claude-sonnet-4-20250514');
    });
  });

  describe('blocking mechanism', () => {
    it('should skip task if previous execution is still running', async () => {
      const task = createTask({ blocking: true });
      let cronCallback: (() => void) | undefined;

      // Make executor hang
      let resolveExecution: () => void;
      mockExecutor.mockReturnValueOnce(new Promise<void>((resolve) => {
        resolveExecution = resolve;
      }));

      mockCronJob.mockImplementationOnce((_: string, cb: () => void) => {
        cronCallback = cb;
        return { stop: mockCronStop };
      });

      scheduler.addTask(task);

      // Start first execution (it hangs)
      const exec1 = (cronCallback as () => Promise<void>)();

      // Verify task is running
      expect(scheduler.isTaskRunning(task.id)).toBe(true);
      expect(scheduler.isAnyTaskRunning()).toBe(true);
      expect(scheduler.getRunningTaskIds()).toEqual([task.id]);

      // Second execution should be skipped
      await (cronCallback as () => Promise<void>)();
      expect(mockExecutor).toHaveBeenCalledTimes(1); // Only called once

      // Resolve the hanging execution
      resolveExecution!();
      await exec1;
      expect(scheduler.isTaskRunning(task.id)).toBe(false);
    });

    it('should allow non-blocking tasks to execute when already running', async () => {
      const task = createTask({ blocking: false });
      let cronCallback: (() => void) | undefined;

      let executionCount = 0;
      let resolveExecution!: () => void;
      mockExecutor.mockImplementation(() => {
        executionCount++;
        return new Promise<void>((resolve) => {
          // Only the first call hangs, the rest resolve immediately
          if (executionCount === 1) {
            resolveExecution = resolve;
          } else {
            resolve();
          }
        });
      });

      mockCronJob.mockImplementationOnce((_: string, cb: () => void) => {
        cronCallback = cb;
        return { stop: mockCronStop };
      });

      scheduler.addTask(task);

      // Start first execution (hangs)
      const exec1 = (cronCallback as () => Promise<void>)();

      // Wait for microtasks to process (sendMessage + executor start)
      await new Promise(resolve => setTimeout(resolve, 10));

      // Verify first execution started
      expect(scheduler.isTaskRunning(task.id)).toBe(true);

      // Start second execution - should NOT be skipped for non-blocking
      const exec2 = (cronCallback as () => Promise<void>)();

      // Wait for microtasks
      await new Promise(resolve => setTimeout(resolve, 10));

      // Executor should have been called twice
      expect(executionCount).toBe(2);

      // Clean up
      resolveExecution();
      await Promise.all([exec1, exec2]);
    }, 15000);
  });

  describe('cooldown integration', () => {
    beforeEach(() => {
      // Add cooldownManager
      scheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        executor: mockExecutor,
        cooldownManager: {
          isInCooldown: mockIsInCooldown,
          getCooldownStatus: mockGetCooldownStatus,
          recordExecution: mockRecordExecution,
          clearCooldown: mockClearCooldown,
        } as any,
      });
    });

    it('should skip task when in cooldown period', async () => {
      const task = createTask({ cooldownPeriod: 300000 });
      let cronCallback: (() => void) | undefined;

      mockIsInCooldown.mockResolvedValue(true);
      mockGetCooldownStatus.mockResolvedValue({
        isInCooldown: true,
        lastExecutionTime: new Date('2026-01-01T09:00:00Z'),
        cooldownEndsAt: new Date('2026-01-01T09:05:00Z'),
        remainingMs: 180000,
      });

      mockCronJob.mockImplementationOnce((_: string, cb: () => void) => {
        cronCallback = cb;
        return { stop: mockCronStop };
      });

      scheduler.addTask(task);
      await (cronCallback as () => Promise<void>)();

      // Executor should NOT be called
      expect(mockExecutor).not.toHaveBeenCalled();

      // Should send cooldown notification
      const calls = mockCallbacks.sendMessage.mock.calls;
      const cooldownCall = calls.find((c: any[]) => c[1].includes('冷静期'));
      expect(cooldownCall).toBeDefined();
      expect(cooldownCall![1]).toContain('冷静期');
      expect(cooldownCall![1]).toContain('剩余时间');
    });

    it('should not check cooldown when task has no cooldownPeriod', async () => {
      const task = createTask({ cooldownPeriod: undefined });
      let cronCallback: (() => void) | undefined;

      mockCronJob.mockImplementationOnce((_: string, cb: () => void) => {
        cronCallback = cb;
        return { stop: mockCronStop };
      });

      scheduler.addTask(task);
      await (cronCallback as () => Promise<void>)();

      expect(mockIsInCooldown).not.toHaveBeenCalled();
      expect(mockExecutor).toHaveBeenCalledTimes(1);
    });

    it('should record execution after task completes', async () => {
      const task = createTask({ cooldownPeriod: 300000 });
      let cronCallback: (() => void) | undefined;

      mockCronJob.mockImplementationOnce((_: string, cb: () => void) => {
        cronCallback = cb;
        return { stop: mockCronStop };
      });

      scheduler.addTask(task);
      await (cronCallback as () => Promise<void>)();

      expect(mockRecordExecution).toHaveBeenCalledWith(task.id, task.cooldownPeriod);
    });

    it('should record execution even when task fails', async () => {
      const task = createTask({ cooldownPeriod: 300000 });
      let cronCallback: (() => void) | undefined;

      mockExecutor.mockRejectedValueOnce(new Error('fail'));
      mockCronJob.mockImplementationOnce((_: string, cb: () => void) => {
        cronCallback = cb;
        return { stop: mockCronStop };
      });

      scheduler.addTask(task);
      await (cronCallback as () => Promise<void>)();

      expect(mockRecordExecution).toHaveBeenCalledWith(task.id, task.cooldownPeriod);
    });

    it('should not record execution when no cooldownManager', async () => {
      const schedulerNoCooldown = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        executor: mockExecutor,
      });

      const task = createTask({ cooldownPeriod: 300000 });
      let cronCallback: (() => void) | undefined;

      mockCronJob.mockImplementationOnce((_: string, cb: () => void) => {
        cronCallback = cb;
        return { stop: mockCronStop };
      });

      schedulerNoCooldown.addTask(task);
      await (cronCallback as () => Promise<void>)();

      expect(mockRecordExecution).not.toHaveBeenCalled();
    });
  });

  describe('getCooldownStatus / clearCooldown delegation', () => {
    it('should return null when no cooldownManager', async () => {
      const result = await scheduler.getCooldownStatus('task-1');
      expect(result).toBeNull();
    });

    it('should delegate getCooldownStatus to cooldownManager', async () => {
      const schedulerWithCooldown = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        executor: mockExecutor,
        cooldownManager: {
          isInCooldown: mockIsInCooldown,
          getCooldownStatus: mockGetCooldownStatus,
          recordExecution: mockRecordExecution,
          clearCooldown: mockClearCooldown,
        } as any,
      });

      mockGetCooldownStatus.mockResolvedValue({
        isInCooldown: true,
        lastExecutionTime: new Date(),
        cooldownEndsAt: new Date(),
        remainingMs: 5000,
      });

      const result = await schedulerWithCooldown.getCooldownStatus('task-1', 60000);
      expect(result).not.toBeNull();
      expect(mockGetCooldownStatus).toHaveBeenCalledWith('task-1', 60000);
    });

    it('should return false when clearing cooldown without cooldownManager', async () => {
      const result = await scheduler.clearCooldown('task-1');
      expect(result).toBe(false);
    });

    it('should delegate clearCooldown to cooldownManager', async () => {
      const schedulerWithCooldown = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        executor: mockExecutor,
        cooldownManager: {
          isInCooldown: mockIsInCooldown,
          getCooldownStatus: mockGetCooldownStatus,
          recordExecution: mockRecordExecution,
          clearCooldown: mockClearCooldown,
        } as any,
      });

      mockClearCooldown.mockResolvedValue(true);
      const result = await schedulerWithCooldown.clearCooldown('task-1');
      expect(result).toBe(true);
      expect(mockClearCooldown).toHaveBeenCalledWith('task-1');
    });
  });

  describe('reload', () => {
    it('should stop and restart with fresh task list', async () => {
      const task1 = createTask({ id: 'task-1' });
      const task2 = createTask({ id: 'task-2' });

      mockListEnabled
        .mockResolvedValueOnce([task1])
        .mockResolvedValueOnce([task2]);

      await scheduler.start();
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      await scheduler.reload();

      expect(scheduler.isRunning()).toBe(true);
      expect(scheduler.getActiveJobs()).toHaveLength(1);
      // CronJob called twice total (once for each start)
      expect(mockCronJob).toHaveBeenCalledTimes(2);
    });
  });

  describe('running task tracking', () => {
    it('should track multiple running tasks', async () => {
      const task1 = createTask({ id: 'task-1' });
      const task2 = createTask({ id: 'task-2' });

      let cb1: (() => void) | undefined;
      let cb2: (() => void) | undefined;

      const pendingResolves: Array<() => void> = [];
      mockExecutor.mockImplementation(() => new Promise<void>((resolve) => {
        pendingResolves.push(resolve);
      }));

      mockCronJob.mockImplementation((_: string, cb: () => void) => {
        if (!cb1) {
          cb1 = cb;
        } else {
          cb2 = cb;
        }
        return { stop: mockCronStop };
      });

      scheduler.addTask(task1);
      scheduler.addTask(task2);

      // Start both
      const exec1 = (cb1 as () => Promise<void>)();
      const exec2 = (cb2 as () => Promise<void>)();

      // Wait for microtasks
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(scheduler.isTaskRunning('task-1')).toBe(true);
      expect(scheduler.isTaskRunning('task-2')).toBe(true);
      expect(scheduler.isAnyTaskRunning()).toBe(true);
      expect(scheduler.getRunningTaskIds()).toHaveLength(2);

      // Resolve all pending executor promises
      pendingResolves.forEach(r => r());
      await Promise.all([exec1, exec2]);

      expect(scheduler.isAnyTaskRunning()).toBe(false);
      expect(scheduler.getRunningTaskIds()).toHaveLength(0);
    });
  });

  describe('getActiveJobs', () => {
    it('should return all active jobs', () => {
      const task1 = createTask({ id: 'task-1' });
      const task2 = createTask({ id: 'task-2' });

      scheduler.addTask(task1);
      scheduler.addTask(task2);

      const jobs = scheduler.getActiveJobs();
      expect(jobs).toHaveLength(2);
      expect(jobs[0].taskId).toBe('task-1');
      expect(jobs[1].taskId).toBe('task-2');
    });

    it('should return empty array when no jobs', () => {
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });
  });
});
