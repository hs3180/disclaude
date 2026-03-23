/**
 * Tests for Scheduler (packages/core/src/scheduling/scheduler.ts)
 *
 * Tests the Scheduler class which manages cron-based task execution.
 * Uses dependency injection for the executor function and callbacks.
 *
 * Uses vi.mock for ESM module mocking.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Use vi.hoisted to define mock functions referenced in vi.mock factory
const { mockLogger, mockCooldownIsInCooldown, mockCooldownGetCooldownStatus, mockCooldownRecordExecution, mockCooldownClearCooldown } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  mockCooldownIsInCooldown: vi.fn().mockResolvedValue(false),
  mockCooldownGetCooldownStatus: vi.fn().mockResolvedValue({
    isInCooldown: false,
    lastExecutionTime: null,
    cooldownEndsAt: null,
    remainingMs: 0,
  }),
  mockCooldownRecordExecution: vi.fn().mockResolvedValue(undefined),
  mockCooldownClearCooldown: vi.fn().mockResolvedValue(true),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue(mockLogger),
}));

vi.mock('./cooldown-manager.js', () => ({
  CooldownManager: vi.fn().mockImplementation(() => ({
    isInCooldown: mockCooldownIsInCooldown,
    getCooldownStatus: mockCooldownGetCooldownStatus,
    recordExecution: mockCooldownRecordExecution,
    clearCooldown: mockCooldownClearCooldown,
  })),
}));

import { Scheduler } from './scheduler.js';
import type { ScheduledTask } from './scheduled-task.js';

// ============================================================================
// Helpers
// ============================================================================

/** Create a mock ScheduleManager. */
function createMockScheduleManager() {
  return {
    listEnabled: vi.fn().mockResolvedValue([]),
  };
}

/** Create a mock callbacks object. */
function createMockCallbacks() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

/** Create a mock executor function. */
function createMockExecutor() {
  return vi.fn().mockResolvedValue(undefined);
}

/** Create a mock CooldownManager. */
function createMockCooldownManager() {
  return {
    isInCooldown: mockCooldownIsInCooldown,
    getCooldownStatus: mockCooldownGetCooldownStatus,
    recordExecution: mockCooldownRecordExecution,
    clearCooldown: mockCooldownClearCooldown,
  };
}

/** Create a valid task for testing. */
function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'schedule-daily-report',
    name: 'Daily Report',
    cron: '* * * * *',
    prompt: 'Execute the daily report task.',
    chatId: 'oc_test123',
    enabled: true,
    blocking: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ============================================================================
// Scheduler Tests
// ============================================================================

describe('Scheduler', () => {
  let scheduler: Scheduler;
  let scheduleManager: ReturnType<typeof createMockScheduleManager>;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let executor: ReturnType<typeof createMockExecutor>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    scheduleManager = createMockScheduleManager();
    callbacks = createMockCallbacks();
    executor = createMockExecutor();
    scheduler = new Scheduler({
      scheduleManager: scheduleManager as any,
      callbacks: callbacks as any,
      executor,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should create a Scheduler with the given options', () => {
      expect(scheduler).toBeInstanceOf(Scheduler);
    });

    it('should log creation message', () => {
      expect(mockLogger.info).toHaveBeenCalledWith('Scheduler created');
    });

    it('should not be running after construction', () => {
      expect(scheduler.isRunning()).toBe(false);
    });

    it('should have no active jobs after construction', () => {
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });
  });

  describe('start', () => {
    it('should load enabled tasks and schedule them', async () => {
      const task1 = makeTask({ id: 'schedule-task-1' });
      const task2 = makeTask({ id: 'schedule-task-2' });
      scheduleManager.listEnabled.mockResolvedValue([task1, task2]);

      await scheduler.start();

      expect(scheduleManager.listEnabled).toHaveBeenCalledTimes(1);
      expect(scheduler.isRunning()).toBe(true);
      expect(scheduler.getActiveJobs()).toHaveLength(2);
    });

    it('should not start if already running', async () => {
      scheduleManager.listEnabled.mockResolvedValue([]);

      await scheduler.start();
      await scheduler.start();

      expect(scheduleManager.listEnabled).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith('Scheduler already running');
    });

    it('should schedule zero tasks when none are enabled', async () => {
      scheduleManager.listEnabled.mockResolvedValue([]);

      await scheduler.start();

      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should log task count after starting', async () => {
      const task = makeTask({ id: 'schedule-task-1' });
      scheduleManager.listEnabled.mockResolvedValue([task]);

      await scheduler.start();

      expect(mockLogger.info).toHaveBeenCalledWith(
        { taskCount: 1 },
        'Scheduler started'
      );
    });
  });

  describe('stop', () => {
    it('should stop all active cron jobs', async () => {
      const task = makeTask({ id: 'schedule-task-1' });
      scheduleManager.listEnabled.mockResolvedValue([task]);

      await scheduler.start();
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      scheduler.stop();
      expect(scheduler.getActiveJobs()).toHaveLength(0);
      expect(scheduler.isRunning()).toBe(false);
    });

    it('should log stop message', async () => {
      scheduleManager.listEnabled.mockResolvedValue([]);

      await scheduler.start();
      scheduler.stop();

      expect(mockLogger.info).toHaveBeenCalledWith('Scheduler stopped');
    });

    it('should be safe to call stop when not running', () => {
      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });
  });

  describe('addTask', () => {
    it('should create a cron job for an enabled task', () => {
      const task = makeTask({ id: 'schedule-task-1' });

      scheduler.addTask(task);

      expect(scheduler.getActiveJobs()).toHaveLength(1);
      expect(scheduler.getActiveJobs()[0].taskId).toBe('schedule-task-1');
    });

    it('should not create a cron job for a disabled task', () => {
      const task = makeTask({ id: 'schedule-task-1', enabled: false });

      scheduler.addTask(task);

      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should log when skipping a disabled task', () => {
      const task = makeTask({ id: 'schedule-task-1', enabled: false });

      scheduler.addTask(task);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        { taskId: 'schedule-task-1' },
        'Task is disabled, not scheduling'
      );
    });

    it('should replace an existing job when adding a task with the same ID', () => {
      const task1 = makeTask({ id: 'schedule-task-1', cron: '* * * * *' });
      const task2 = makeTask({ id: 'schedule-task-1', cron: '0 9 * * *', name: 'Updated Task' });

      scheduler.addTask(task1);
      scheduler.addTask(task2);

      expect(scheduler.getActiveJobs()).toHaveLength(1);
      expect(scheduler.getActiveJobs()[0].task.name).toBe('Updated Task');
    });

    it('should handle invalid cron expressions gracefully', () => {
      const task = makeTask({ id: 'schedule-task-1', cron: 'invalid-cron' });

      // Should not throw
      scheduler.addTask(task);

      expect(scheduler.getActiveJobs()).toHaveLength(0);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'schedule-task-1', cron: 'invalid-cron' }),
        'Invalid cron expression'
      );
    });

    it('should log when a task is scheduled', () => {
      const task = makeTask({ id: 'schedule-task-1' });

      scheduler.addTask(task);

      expect(mockLogger.info).toHaveBeenCalledWith(
        { taskId: 'schedule-task-1', cron: '* * * * *', name: 'Daily Report' },
        'Scheduled task'
      );
    });
  });

  describe('removeTask', () => {
    it('should remove an active job', () => {
      const task = makeTask({ id: 'schedule-task-1' });

      scheduler.addTask(task);
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      scheduler.removeTask('schedule-task-1');
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should do nothing when removing a non-existent task', () => {
      scheduler.removeTask('schedule-nonexistent');
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should log when a task is removed', () => {
      const task = makeTask({ id: 'schedule-task-1' });

      scheduler.addTask(task);
      scheduler.removeTask('schedule-task-1');

      expect(mockLogger.info).toHaveBeenCalledWith(
        { taskId: 'schedule-task-1' },
        'Removed scheduled task'
      );
    });
  });

  describe('executeTask (via cron trigger)', () => {
    it('should call the executor with wrapped prompt', async () => {
      const task = makeTask({ id: 'schedule-task-1', createdBy: 'ou_user' });

      scheduler.addTask(task);
      await scheduler.start();

      // Fire the cron callback
      const activeJob = scheduler.getActiveJobs()[0];
      const cronCallback = (activeJob.job as any)._callbacks[0];
      await cronCallback();

      expect(executor).toHaveBeenCalledTimes(1);
      const [chatId, prompt, userId] = executor.mock.calls[0];
      expect(chatId).toBe('oc_test123');
      expect(prompt).toContain('Scheduled Task Execution Context');
      expect(prompt).toContain('Daily Report');
      expect(prompt).toContain('Execute the daily report task.');
      expect(prompt).toContain('Do NOT create new scheduled tasks');
      expect(userId).toBe('ou_user');
    });

    it('should send start notification before executing', async () => {
      const task = makeTask({ id: 'schedule-task-1' });

      scheduler.addTask(task);
      await scheduler.start();

      const activeJob = scheduler.getActiveJobs()[0];
      const cronCallback = (activeJob.job as any)._callbacks[0];
      await cronCallback();

      const sendMessageCalls = callbacks.sendMessage.mock.calls;
      expect(sendMessageCalls.length).toBeGreaterThanOrEqual(1);
      expect(sendMessageCalls[0][1]).toContain('Daily Report');
      expect(sendMessageCalls[0][1]).toContain('开始执行');
    });

    it('should send error notification when executor throws', async () => {
      const task = makeTask({ id: 'schedule-task-1' });
      executor.mockRejectedValueOnce(new Error('Execution failed'));

      scheduler.addTask(task);
      await scheduler.start();

      const activeJob = scheduler.getActiveJobs()[0];
      const cronCallback = (activeJob.job as any)._callbacks[0];
      await cronCallback();

      const lastCall = callbacks.sendMessage.mock.calls.at(-1);
      expect(lastCall![1]).toContain('执行失败');
      expect(lastCall![1]).toContain('Execution failed');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'schedule-task-1' }),
        'Scheduled task failed'
      );
    });

    it('should clear running task flag after execution completes', async () => {
      const task = makeTask({ id: 'schedule-task-1' });

      scheduler.addTask(task);
      await scheduler.start();

      const activeJob = scheduler.getActiveJobs()[0];
      const cronCallback = (activeJob.job as any)._callbacks[0];

      // During execution, task should be running
      const executionPromise = cronCallback();
      expect(scheduler.isTaskRunning('schedule-task-1')).toBe(true);

      await executionPromise;
      // After execution, task should not be running
      expect(scheduler.isTaskRunning('schedule-task-1')).toBe(false);
    });

    it('should clear running task flag even when executor throws', async () => {
      const task = makeTask({ id: 'schedule-task-1' });
      executor.mockRejectedValueOnce(new Error('fail'));

      scheduler.addTask(task);
      await scheduler.start();

      const activeJob = scheduler.getActiveJobs()[0];
      const cronCallback = (activeJob.job as any)._callbacks[0];
      await cronCallback();

      expect(scheduler.isTaskRunning('schedule-task-1')).toBe(false);
    });

    it('should skip blocking task if previous execution still running', async () => {
      const task = makeTask({ id: 'schedule-task-1', blocking: true });

      scheduler.addTask(task);
      await scheduler.start();

      const activeJob = scheduler.getActiveJobs()[0];
      const cronCallback = (activeJob.job as any)._callbacks[0];

      // First execution - does not resolve yet
      const firstExecution = cronCallback();

      // Second execution while first is still running
      const secondExecution = cronCallback();

      // Complete the first execution
      await firstExecution;
      await secondExecution;

      // Executor should only be called once
      expect(executor).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        { taskId: 'schedule-task-1', name: 'Daily Report' },
        'Task skipped - previous execution still running'
      );
    });
  });

  describe('executeTask with cooldown', () => {
    it('should skip task execution when in cooldown period', async () => {
      const task = makeTask({ id: 'schedule-task-1', cooldownPeriod: 3600000 });
      mockCooldownIsInCooldown.mockResolvedValue(true);
      mockCooldownGetCooldownStatus.mockResolvedValue({
        isInCooldown: true,
        lastExecutionTime: new Date('2026-03-20T09:00:00Z'),
        cooldownEndsAt: new Date('2026-03-20T10:00:00Z'),
        remainingMs: 1800000,
      });

      const cooldownManager = createMockCooldownManager();
      scheduler = new Scheduler({
        scheduleManager: scheduleManager as any,
        callbacks: callbacks as any,
        executor,
        cooldownManager: cooldownManager as any,
      });

      scheduler.addTask(task);
      await scheduler.start();

      const activeJob = scheduler.getActiveJobs()[0];
      const cronCallback = (activeJob.job as any)._callbacks[0];
      await cronCallback();

      expect(executor).not.toHaveBeenCalled();
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_test123',
        expect.stringContaining('冷静期中')
      );
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_test123',
        expect.stringContaining('30 分钟')
      );
    });

    it('should record execution after task completes when cooldownPeriod is set', async () => {
      const task = makeTask({ id: 'schedule-task-1', cooldownPeriod: 3600000 });
      mockCooldownIsInCooldown.mockResolvedValue(false);

      const cooldownManager = createMockCooldownManager();
      scheduler = new Scheduler({
        scheduleManager: scheduleManager as any,
        callbacks: callbacks as any,
        executor,
        cooldownManager: cooldownManager as any,
      });

      scheduler.addTask(task);
      await scheduler.start();

      const activeJob = scheduler.getActiveJobs()[0];
      const cronCallback = (activeJob.job as any)._callbacks[0];
      await cronCallback();

      expect(mockCooldownRecordExecution).toHaveBeenCalledWith('schedule-task-1', 3600000);
    });

    it('should record execution even when task fails (for cooldown tracking)', async () => {
      const task = makeTask({ id: 'schedule-task-1', cooldownPeriod: 3600000 });
      mockCooldownIsInCooldown.mockResolvedValue(false);
      executor.mockRejectedValueOnce(new Error('fail'));

      const cooldownManager = createMockCooldownManager();
      scheduler = new Scheduler({
        scheduleManager: scheduleManager as any,
        callbacks: callbacks as any,
        executor,
        cooldownManager: cooldownManager as any,
      });

      scheduler.addTask(task);
      await scheduler.start();

      const activeJob = scheduler.getActiveJobs()[0];
      const cronCallback = (activeJob.job as any)._callbacks[0];
      await cronCallback();

      expect(mockCooldownRecordExecution).toHaveBeenCalledWith('schedule-task-1', 3600000);
    });
  });

  describe('reload', () => {
    it('should stop and restart with fresh tasks', async () => {
      const task1 = makeTask({ id: 'schedule-task-1' });
      const task2 = makeTask({ id: 'schedule-task-2' });

      scheduleManager.listEnabled
        .mockResolvedValueOnce([task1])
        .mockResolvedValueOnce([task1, task2]);

      await scheduler.start();
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      await scheduler.reload();
      expect(scheduler.getActiveJobs()).toHaveLength(2);
      expect(scheduleManager.listEnabled).toHaveBeenCalledTimes(2);
    });

    it('should log reload message', async () => {
      scheduleManager.listEnabled.mockResolvedValue([]);

      await scheduler.start();
      await scheduler.reload();

      expect(mockLogger.info).toHaveBeenCalledWith('Scheduler reloaded all tasks');
    });
  });

  describe('getActiveJobs', () => {
    it('should return empty array when no jobs are scheduled', () => {
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should return all active jobs', () => {
      const task1 = makeTask({ id: 'schedule-task-1' });
      const task2 = makeTask({ id: 'schedule-task-2' });

      scheduler.addTask(task1);
      scheduler.addTask(task2);

      const jobs = scheduler.getActiveJobs();
      expect(jobs).toHaveLength(2);
      expect(jobs[0].taskId).toBe('schedule-task-1');
      expect(jobs[1].taskId).toBe('schedule-task-2');
    });
  });

  describe('isRunning', () => {
    it('should return false before start', () => {
      expect(scheduler.isRunning()).toBe(false);
    });

    it('should return true after start', async () => {
      scheduleManager.listEnabled.mockResolvedValue([]);
      await scheduler.start();
      expect(scheduler.isRunning()).toBe(true);
    });

    it('should return false after stop', async () => {
      scheduleManager.listEnabled.mockResolvedValue([]);
      await scheduler.start();
      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
    });
  });

  describe('isTaskRunning', () => {
    it('should return false when no tasks are running', () => {
      expect(scheduler.isTaskRunning('schedule-task-1')).toBe(false);
    });

    it('should return true while a task is being executed', async () => {
      const task = makeTask({ id: 'schedule-task-1' });

      scheduler.addTask(task);
      await scheduler.start();

      const activeJob = scheduler.getActiveJobs()[0];
      const cronCallback = (activeJob.job as any)._callbacks[0];

      const executionPromise = cronCallback();
      expect(scheduler.isTaskRunning('schedule-task-1')).toBe(true);
      await executionPromise;
    });
  });

  describe('isAnyTaskRunning', () => {
    it('should return false when no tasks are running', () => {
      expect(scheduler.isAnyTaskRunning()).toBe(false);
    });

    it('should return true when at least one task is running', async () => {
      const task = makeTask({ id: 'schedule-task-1' });

      scheduler.addTask(task);
      await scheduler.start();

      const activeJob = scheduler.getActiveJobs()[0];
      const cronCallback = (activeJob.job as any)._callbacks[0];

      const executionPromise = cronCallback();
      expect(scheduler.isAnyTaskRunning()).toBe(true);
      await executionPromise;
    });
  });

  describe('getRunningTaskIds', () => {
    it('should return empty array when no tasks are running', () => {
      expect(scheduler.getRunningTaskIds()).toEqual([]);
    });

    it('should return IDs of all running tasks', async () => {
      const task1 = makeTask({ id: 'schedule-task-1' });
      const task2 = makeTask({ id: 'schedule-task-2' });

      scheduler.addTask(task1);
      scheduler.addTask(task2);
      await scheduler.start();

      const job1 = scheduler.getActiveJobs()[0];
      const cronCallback1 = (job1.job as any)._callbacks[0];

      // Start first execution - it runs because sendMessage and executor are async
      const executionPromise1 = cronCallback1();

      // Check while first is running
      const runningIds = scheduler.getRunningTaskIds();
      expect(runningIds).toHaveLength(1);
      expect(runningIds).toContain('schedule-task-1');

      await executionPromise1;

      // After completion, no tasks running
      expect(scheduler.getRunningTaskIds()).toHaveLength(0);
    });
  });

  describe('getCooldownStatus', () => {
    it('should return null when no cooldownManager is provided', async () => {
      const result = await scheduler.getCooldownStatus('schedule-task-1');
      expect(result).toBeNull();
    });

    it('should delegate to cooldownManager when provided', async () => {
      const cooldownManager = createMockCooldownManager();
      mockCooldownGetCooldownStatus.mockResolvedValue({
        isInCooldown: true,
        lastExecutionTime: new Date('2026-03-20T09:00:00Z'),
        cooldownEndsAt: new Date('2026-03-20T10:00:00Z'),
        remainingMs: 1800000,
      });

      scheduler = new Scheduler({
        scheduleManager: scheduleManager as any,
        callbacks: callbacks as any,
        executor,
        cooldownManager: cooldownManager as any,
      });

      const result = await scheduler.getCooldownStatus('schedule-task-1', 3600000);
      expect(mockCooldownGetCooldownStatus).toHaveBeenCalledWith('schedule-task-1', 3600000);
      expect(result).not.toBeNull();
      expect(result!.isInCooldown).toBe(true);
      expect(result!.remainingMs).toBe(1800000);
    });
  });

  describe('clearCooldown', () => {
    it('should return false when no cooldownManager is provided', async () => {
      const result = await scheduler.clearCooldown('schedule-task-1');
      expect(result).toBe(false);
    });

    it('should delegate to cooldownManager when provided', async () => {
      const cooldownManager = createMockCooldownManager();
      mockCooldownClearCooldown.mockResolvedValue(true);

      scheduler = new Scheduler({
        scheduleManager: scheduleManager as any,
        callbacks: callbacks as any,
        executor,
        cooldownManager: cooldownManager as any,
      });

      const result = await scheduler.clearCooldown('schedule-task-1');
      expect(mockCooldownClearCooldown).toHaveBeenCalledWith('schedule-task-1');
      expect(result).toBe(true);
    });
  });
});
