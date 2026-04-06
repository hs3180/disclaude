/**
 * Tests for Scheduler.
 *
 * Verifies cron-based task execution, cooldown handling,
 * blocking mechanism, and lifecycle management.
 *
 * Issue #1617: Phase 2 - scheduling module test coverage.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Scheduler, type SchedulerCallbacks, type TaskExecutor } from './scheduler.js';
import type { ScheduleManager } from './schedule-manager.js';
import type { ScheduledTask } from './scheduled-task.js';
import type { CooldownManager } from './cooldown-manager.js';

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    name: 'Test Task',
    cron: '* * * * *', // every minute
    prompt: 'Run tests',
    chatId: 'oc_test',
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('Scheduler', () => {
  let mockScheduleManager: ScheduleManager;
  let mockCallbacks: SchedulerCallbacks;
  let mockExecutor: Mock<TaskExecutor>;
  let scheduler: Scheduler;

  beforeEach(() => {
    mockScheduleManager = {
      listEnabled: vi.fn().mockResolvedValue([]),
      listAll: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(undefined),
      listByChatId: vi.fn().mockResolvedValue([]),
      getFileScanner: vi.fn(),
    } as unknown as ScheduleManager;

    mockCallbacks = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };

    mockExecutor = vi.fn().mockResolvedValue(undefined);

    scheduler = new Scheduler({
      scheduleManager: mockScheduleManager,
      callbacks: mockCallbacks,
      executor: mockExecutor,
    });
  });

  describe('constructor', () => {
    it('should create scheduler with required options', () => {
      expect(scheduler).toBeInstanceOf(Scheduler);
      expect(scheduler.isRunning()).toBe(false);
    });

    it('should accept optional cooldownManager', () => {
      const mockCooldownManager = {
        isInCooldown: vi.fn().mockResolvedValue(false),
        recordExecution: vi.fn().mockResolvedValue(undefined),
        getCooldownStatus: vi.fn().mockResolvedValue(null),
        clearCooldown: vi.fn().mockResolvedValue(true),
      } as unknown as CooldownManager;

      const s = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        executor: mockExecutor,
        cooldownManager: mockCooldownManager,
      });

      expect(s).toBeInstanceOf(Scheduler);
    });
  });

  describe('start / stop', () => {
    it('should start scheduler and load enabled tasks', async () => {
      const task = createTask();
      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValue([task]);

      await scheduler.start();

      expect(scheduler.isRunning()).toBe(true);
      expect(mockScheduleManager.listEnabled).toHaveBeenCalledTimes(1);
      expect(scheduler.getActiveJobs()).toHaveLength(1);
    });

    it('should not start if already running', async () => {
      const task = createTask();
      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValue([task]);

      await scheduler.start();
      await scheduler.start(); // second start

      expect(mockScheduleManager.listEnabled).toHaveBeenCalledTimes(1);
    });

    it('should stop scheduler and clear all jobs', async () => {
      const task = createTask();
      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValue([task]);

      await scheduler.start();
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      scheduler.stop();

      expect(scheduler.isRunning()).toBe(false);
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should handle stop when not running', () => {
      expect(() => scheduler.stop()).not.toThrow();
    });

    it('should not schedule disabled tasks on start', async () => {
      const disabledTask = createTask({ enabled: false });
      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValue([disabledTask]);

      await scheduler.start();

      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should handle invalid cron expressions gracefully on start', async () => {
      const badTask = createTask({ cron: 'invalid-cron' });
      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValue([badTask]);

      // Should not throw
      await scheduler.start();

      // The task should not be scheduled (CronJob would throw)
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });
  });

  describe('addTask / removeTask', () => {
    it('should add an enabled task and create a cron job', () => {
      const task = createTask();
      scheduler.addTask(task);

      expect(scheduler.getActiveJobs()).toHaveLength(1);
      expect(scheduler.getActiveJobs()[0].taskId).toBe('task-1');
    });

    it('should not add a disabled task', () => {
      const task = createTask({ enabled: false });
      scheduler.addTask(task);

      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should replace existing task when adding with same ID', () => {
      const task1 = createTask({ id: 'task-1', cron: '* * * * *' });
      const task2 = createTask({ id: 'task-1', cron: '0 * * * *' });

      scheduler.addTask(task1);
      scheduler.addTask(task2);

      expect(scheduler.getActiveJobs()).toHaveLength(1);
    });

    it('should remove an existing task', () => {
      const task = createTask();
      scheduler.addTask(task);
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      scheduler.removeTask('task-1');

      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should handle removing non-existent task gracefully', () => {
      expect(() => scheduler.removeTask('nonexistent')).not.toThrow();
    });

    it('should handle invalid cron expression gracefully', () => {
      const task = createTask({ cron: 'bad cron' });

      expect(() => scheduler.addTask(task)).not.toThrow();
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });
  });

  describe('reload', () => {
    it('should reload all tasks from schedule manager', async () => {
      const task1 = createTask({ id: 't1' });
      const task2 = createTask({ id: 't2' });

      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValueOnce([task1]);
      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValueOnce([task1, task2]);

      await scheduler.start();
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      await scheduler.reload();
      expect(scheduler.getActiveJobs()).toHaveLength(2);
    });
  });

  describe('running task tracking', () => {
    it('should report no running tasks initially', () => {
      expect(scheduler.isAnyTaskRunning()).toBe(false);
      expect(scheduler.isTaskRunning('task-1')).toBe(false);
      expect(scheduler.getRunningTaskIds()).toEqual([]);
    });
  });

  describe('cooldown status', () => {
    it('should return null when no cooldown manager', async () => {
      const status = await scheduler.getCooldownStatus('task-1', 60000);
      expect(status).toBeNull();
    });

    it('should return false when clearing cooldown without manager', async () => {
      const result = await scheduler.clearCooldown('task-1');
      expect(result).toBe(false);
    });

    it('should delegate to cooldown manager when available', async () => {
      const mockCooldownManager = {
        isInCooldown: vi.fn().mockResolvedValue(false),
        recordExecution: vi.fn().mockResolvedValue(undefined),
        getCooldownStatus: vi.fn().mockResolvedValue({
          isInCooldown: false,
          lastExecutionTime: new Date(),
          cooldownEndsAt: null,
          remainingMs: 0,
        }),
        clearCooldown: vi.fn().mockResolvedValue(true),
      } as unknown as CooldownManager;

      const s = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        executor: mockExecutor,
        cooldownManager: mockCooldownManager,
      });

      const status = await s.getCooldownStatus('task-1', 60000);
      expect(status).toBeDefined();
      expect(status!.isInCooldown).toBe(false);
      expect(mockCooldownManager.getCooldownStatus).toHaveBeenCalledWith('task-1', 60000);

      const cleared = await s.clearCooldown('task-1');
      expect(cleared).toBe(true);
      expect(mockCooldownManager.clearCooldown).toHaveBeenCalledWith('task-1');
    });
  });

  describe('getActiveJobs', () => {
    it('should return empty array when no jobs are active', () => {
      expect(scheduler.getActiveJobs()).toEqual([]);
    });

    it('should return active jobs with task data', () => {
      const task = createTask({ id: 't1', name: 'Job 1' });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].taskId).toBe('t1');
      expect(jobs[0].task.name).toBe('Job 1');
      expect(jobs[0].job).toBeDefined();
    });
  });

  describe('executeTask (via cron job trigger)', () => {
    /** Helper: fire a cron job and wait for async side-effects via vi.waitFor */
    function fireAndWait(jobs: ReturnType<typeof scheduler.getActiveJobs>) {
      void jobs[0].job.fireOnTick();
    }

    it('should execute task and send start message', async () => {
      const task = createTask({ id: 'exec-1' });
      scheduler.addTask(task);

      // Get the cron job and trigger it manually
      const jobs = scheduler.getActiveJobs();
      expect(jobs).toHaveLength(1);

      // Fire and wait for executor to be called
      await fireAndWait(jobs);
      await vi.waitFor(() => {
        expect(mockExecutor).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      expect(mockCallbacks.sendMessage).toHaveBeenCalledWith(
        'oc_test',
        expect.stringContaining('开始执行'),
      );
      expect(mockExecutor).toHaveBeenCalledWith(
        'oc_test',
        expect.stringContaining('Run tests'),
        undefined,
        undefined,
      );
    });

    it('should pass createdBy and model to executor when set', async () => {
      const task = createTask({
        id: 'exec-2',
        createdBy: 'user-123',
        model: 'claude-3-5-sonnet-20241022',
      });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      await fireAndWait(jobs);
      await vi.waitFor(() => {
        expect(mockExecutor).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      expect(mockExecutor).toHaveBeenCalledWith(
        'oc_test',
        expect.any(String),
        'user-123',
        'claude-3-5-sonnet-20241022',
      );
    });

    it('should send error message when executor fails', async () => {
      mockExecutor.mockRejectedValueOnce(new Error('Agent crashed'));

      const task = createTask({ id: 'exec-3' });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      await fireAndWait(jobs);
      await vi.waitFor(() => {
        expect(mockCallbacks.sendMessage).toHaveBeenCalledWith(
          'oc_test',
          expect.stringContaining('执行失败'),
        );
      }, { timeout: 2000 });
    });

    it('should wrap prompt with anti-recursion instructions', async () => {
      const task = createTask({ id: 'exec-4', name: 'My Task', prompt: 'Do something' });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      await fireAndWait(jobs);
      await vi.waitFor(() => {
        expect(mockExecutor).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      // eslint-disable-next-line prefer-destructuring
      const [, promptArg] = mockExecutor.mock.calls[0];
      expect(promptArg).toContain('Scheduled Task Execution Context');
      expect(promptArg).toContain('My Task');
      expect(promptArg).toContain('Do NOT create new scheduled tasks');
      expect(promptArg).toContain('Do something');
    });

    it('should handle non-Error exceptions from executor', async () => {
      mockExecutor.mockRejectedValueOnce('string error');

      const task = createTask({ id: 'exec-5' });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      await fireAndWait(jobs);
      await vi.waitFor(() => {
        expect(mockCallbacks.sendMessage).toHaveBeenCalledWith(
          'oc_test',
          expect.stringContaining('string error'),
        );
      }, { timeout: 2000 });
    });

    it('should clear running state even when executor fails', async () => {
      mockExecutor.mockRejectedValueOnce(new Error('failure'));

      const task = createTask({ id: 'fail-clear' });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      await fireAndWait(jobs);
      await vi.waitFor(() => {
        expect(scheduler.isTaskRunning('fail-clear')).toBe(false);
      }, { timeout: 2000 });
    });
  });

  describe('executeTask with cooldown', () => {
    it('should skip task in cooldown period', async () => {
      const mockCooldownManager = {
        isInCooldown: vi.fn().mockResolvedValue(true),
        recordExecution: vi.fn().mockResolvedValue(undefined),
        getCooldownStatus: vi.fn().mockResolvedValue({
          isInCooldown: true,
          lastExecutionTime: new Date('2026-01-01T12:00:00'),
          cooldownEndsAt: new Date('2026-01-01T13:00:00'),
          remainingMs: 3600000,
        }),
        clearCooldown: vi.fn().mockResolvedValue(true),
      } as unknown as CooldownManager;

      const cooldownScheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        executor: mockExecutor,
        cooldownManager: mockCooldownManager,
      });

      const task = createTask({ id: 'cooldown-1', cooldownPeriod: 3600000 });
      cooldownScheduler.addTask(task);

      const jobs = cooldownScheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();
      await vi.waitFor(() => {
        expect(mockCallbacks.sendMessage).toHaveBeenCalledWith(
          'oc_test',
          expect.stringContaining('冷静期'),
        );
      }, { timeout: 2000 });

      // Executor should NOT be called when in cooldown
      expect(mockExecutor).not.toHaveBeenCalled();
    });

    it('should record execution after task completes with cooldown', async () => {
      const mockCooldownManager = {
        isInCooldown: vi.fn().mockResolvedValue(false),
        recordExecution: vi.fn().mockResolvedValue(undefined),
        getCooldownStatus: vi.fn().mockResolvedValue(null),
        clearCooldown: vi.fn().mockResolvedValue(true),
      } as unknown as CooldownManager;

      const cooldownScheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        executor: mockExecutor,
        cooldownManager: mockCooldownManager,
      });

      const task = createTask({ id: 'cooldown-2', cooldownPeriod: 60000 });
      cooldownScheduler.addTask(task);

      const jobs = cooldownScheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();
      await vi.waitFor(() => {
        expect(mockCooldownManager.recordExecution).toHaveBeenCalledWith('cooldown-2', 60000);
      }, { timeout: 2000 });
    });

    it('should record execution even when task fails with cooldown', async () => {
      const mockCooldownManager = {
        isInCooldown: vi.fn().mockResolvedValue(false),
        recordExecution: vi.fn().mockResolvedValue(undefined),
        getCooldownStatus: vi.fn().mockResolvedValue(null),
        clearCooldown: vi.fn().mockResolvedValue(true),
      } as unknown as CooldownManager;

      mockExecutor.mockRejectedValueOnce(new Error('task failed'));

      const cooldownScheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        executor: mockExecutor,
        cooldownManager: mockCooldownManager,
      });

      const task = createTask({ id: 'cooldown-3', cooldownPeriod: 30000 });
      cooldownScheduler.addTask(task);

      const jobs = cooldownScheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();
      await vi.waitFor(() => {
        expect(mockCooldownManager.recordExecution).toHaveBeenCalledWith('cooldown-3', 30000);
      }, { timeout: 2000 });
    });

    it('should not check cooldown when cooldownPeriod is not set', async () => {
      const mockCooldownManager = {
        isInCooldown: vi.fn().mockResolvedValue(false),
        recordExecution: vi.fn().mockResolvedValue(undefined),
        getCooldownStatus: vi.fn().mockResolvedValue(null),
        clearCooldown: vi.fn().mockResolvedValue(true),
      } as unknown as CooldownManager;

      const cooldownScheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        executor: mockExecutor,
        cooldownManager: mockCooldownManager,
      });

      // Task without cooldownPeriod
      const task = createTask({ id: 'no-cd' });
      cooldownScheduler.addTask(task);

      const jobs = cooldownScheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();
      await vi.waitFor(() => {
        expect(mockExecutor).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      // isInCooldown should not be called when no cooldownPeriod
      expect(mockCooldownManager.isInCooldown).not.toHaveBeenCalled();
    });
  });

  describe('multiple tasks', () => {
    it('should schedule and track multiple tasks', () => {
      const task1 = createTask({ id: 'multi-1', cron: '* * * * *' });
      const task2 = createTask({ id: 'multi-2', cron: '0 * * * *' });
      const task3 = createTask({ id: 'multi-3', cron: '*/5 * * * *' });

      scheduler.addTask(task1);
      scheduler.addTask(task2);
      scheduler.addTask(task3);

      expect(scheduler.getActiveJobs()).toHaveLength(3);
    });

    it('should remove individual tasks without affecting others', () => {
      const task1 = createTask({ id: 'rm-1' });
      const task2 = createTask({ id: 'rm-2' });
      const task3 = createTask({ id: 'rm-3' });

      scheduler.addTask(task1);
      scheduler.addTask(task2);
      scheduler.addTask(task3);

      scheduler.removeTask('rm-2');

      expect(scheduler.getActiveJobs()).toHaveLength(2);
      expect(scheduler.getActiveJobs().map(j => j.taskId)).not.toContain('rm-2');
    });
  });
});
