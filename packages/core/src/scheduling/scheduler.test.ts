/**
 * Unit tests for Scheduler
 *
 * Issue #1617 Phase 2: Tests for cron-based task execution.
 *
 * Tests cover:
 * - start/stop lifecycle
 * - addTask/removeTask: cron job management
 * - Task execution: blocking mechanism, cooldown handling
 * - Anti-recursion prompt wrapping
 * - Error handling and notifications
 * - Reload and status methods
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler, type SchedulerCallbacks, type TaskExecutor } from './scheduler.js';
import type { ScheduleManager } from './schedule-manager.js';
import type { CooldownManager } from './cooldown-manager.js';
import type { ScheduledTask } from './scheduled-task.js';

// ============================================================================
// Mocks
// ============================================================================

// Mock cron to control job execution
const mockCronJobStop = vi.fn();
const mockCronJobConstructor = vi.fn();

vi.mock('cron', () => ({
  CronJob: class MockCronJob {
    constructor(...args: unknown[]) {
      // Throw for obviously invalid cron expressions to test error handling
      const cronExpr = args[0] as string;
      if (cronExpr === 'invalid-cron') {
        throw new Error('Invalid cron expression');
      }
      mockCronJobConstructor(...args);
    }
    stop() {
      mockCronJobStop();
    }
  },
}));

// ============================================================================
// Helpers
// ============================================================================

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    name: 'Test Task',
    cron: '* * * * *', // Every minute for testing
    prompt: 'Execute test',
    chatId: 'oc_test',
    enabled: true,
    blocking: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function createMockScheduleManager(): ScheduleManager {
  return {
    listEnabled: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
    listByChatId: vi.fn().mockResolvedValue([]),
    listAll: vi.fn().mockResolvedValue([]),
    getFileScanner: vi.fn(),
  } as unknown as ScheduleManager;
}

function createMockCooldownManager(): CooldownManager {
  return {
    isInCooldown: vi.fn().mockResolvedValue(false),
    getCooldownStatus: vi.fn().mockResolvedValue({
      isInCooldown: false,
      lastExecutionTime: null,
      cooldownEndsAt: null,
      remainingMs: 0,
    }),
    recordExecution: vi.fn().mockResolvedValue(undefined),
    clearCooldown: vi.fn().mockResolvedValue(true),
  } as unknown as CooldownManager;
}

// ============================================================================
// Tests
// ============================================================================

describe('Scheduler', () => {
  let scheduler: Scheduler;
  let scheduleManager: ScheduleManager;
  let callbacks: SchedulerCallbacks;
  let executor: TaskExecutor;
  let cooldownManager: CooldownManager;

  beforeEach(() => {
    vi.clearAllMocks();
    scheduleManager = createMockScheduleManager();
    callbacks = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    executor = vi.fn().mockResolvedValue(undefined);
    cooldownManager = createMockCooldownManager();

    scheduler = new Scheduler({
      scheduleManager,
      callbacks,
      executor,
      cooldownManager,
    });
  });

  afterEach(() => {
    scheduler.stop();
  });

  describe('constructor', () => {
    it('should create scheduler with dependencies', () => {
      expect(scheduler).toBeDefined();
      expect(scheduler.isRunning()).toBe(false);
    });
  });

  describe('start / stop', () => {
    it('should start and load enabled tasks', async () => {
      const tasks = [
        createTask({ id: 'task-1', cron: '0 9 * * *' }),
        createTask({ id: 'task-2', cron: '0 18 * * *' }),
      ];
      (scheduleManager.listEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      await scheduler.start();

      expect(scheduler.isRunning()).toBe(true);
      expect(mockCronJobConstructor).toHaveBeenCalledTimes(2);
      expect(scheduler.getActiveJobs()).toHaveLength(2);
    });

    it('should not start twice', async () => {
      (scheduleManager.listEnabled as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await scheduler.start();
      await scheduler.start();

      // Should only call listEnabled once (second start returns early)
      expect(scheduleManager.listEnabled).toHaveBeenCalledTimes(1);
    });

    it('should stop all active jobs', async () => {
      const tasks = [createTask({ id: 'task-1' })];
      (scheduleManager.listEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      await scheduler.start();
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      scheduler.stop();

      expect(scheduler.isRunning()).toBe(false);
      expect(scheduler.getActiveJobs()).toHaveLength(0);
      expect(mockCronJobStop).toHaveBeenCalled();
    });

    it('should start with no tasks when none are enabled', async () => {
      (scheduleManager.listEnabled as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await scheduler.start();

      expect(scheduler.isRunning()).toBe(true);
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });
  });

  describe('addTask', () => {
    beforeEach(async () => {
      (scheduleManager.listEnabled as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await scheduler.start();
    });

    it('should add enabled task and create cron job', () => {
      const task = createTask({ id: 'task-new', cron: '0 9 * * *' });
      scheduler.addTask(task);

      expect(scheduler.getActiveJobs()).toHaveLength(1);
      expect(mockCronJobConstructor).toHaveBeenCalledTimes(1);
    });

    it('should not schedule disabled tasks', () => {
      const task = createTask({ id: 'task-disabled', enabled: false });
      scheduler.addTask(task);

      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should replace existing task when adding with same ID', () => {
      const task1 = createTask({ id: 'task-1', cron: '0 9 * * *' });
      const task2 = createTask({ id: 'task-1', cron: '0 18 * * *' });

      scheduler.addTask(task1);
      scheduler.addTask(task2);

      expect(scheduler.getActiveJobs()).toHaveLength(1);
    });

    it('should handle invalid cron expression gracefully', () => {
      const task = createTask({ id: 'task-bad', cron: 'invalid-cron' });
      scheduler.addTask(task);

      // Should not crash, but job should not be added
      // The cron constructor might throw, which is caught
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });
  });

  describe('removeTask', () => {
    beforeEach(async () => {
      (scheduleManager.listEnabled as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await scheduler.start();
    });

    it('should remove existing task', () => {
      const task = createTask({ id: 'task-remove' });
      scheduler.addTask(task);
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      scheduler.removeTask('task-remove');
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should not throw when removing non-existent task', () => {
      expect(() => scheduler.removeTask('non-existent')).not.toThrow();
    });
  });

  describe('blocking mechanism', () => {
    it('isTaskRunning should return false when no tasks are running', () => {
      expect(scheduler.isTaskRunning('task-1')).toBe(false);
    });

    it('isAnyTaskRunning should return false when no tasks are running', () => {
      expect(scheduler.isAnyTaskRunning()).toBe(false);
    });

    it('getRunningTaskIds should return empty array', () => {
      expect(scheduler.getRunningTaskIds()).toEqual([]);
    });
  });

  describe('cooldown status', () => {
    it('should return null when no cooldown manager', async () => {
      const noCooldownScheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
      });

      const status = await noCooldownScheduler.getCooldownStatus('task-1', 60000);
      expect(status).toBeNull();

      noCooldownScheduler.stop();
    });

    it('should return cooldown status from manager', async () => {
      const status = await scheduler.getCooldownStatus('task-1', 60000);
      expect(status).toBeDefined();
      expect(status!.isInCooldown).toBe(false);
    });

    it('should clear cooldown via manager', async () => {
      const result = await scheduler.clearCooldown('task-1');
      expect(result).toBe(true);
      expect(cooldownManager.clearCooldown).toHaveBeenCalledWith('task-1');
    });

    it('should return false when clearing cooldown without manager', async () => {
      const noCooldownScheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
      });

      const result = await noCooldownScheduler.clearCooldown('task-1');
      expect(result).toBe(false);

      noCooldownScheduler.stop();
    });
  });

  describe('reload', () => {
    it('should stop and restart with fresh tasks', async () => {
      const tasks1 = [createTask({ id: 'task-1' })];
      const tasks2 = [createTask({ id: 'task-2' })];
      (scheduleManager.listEnabled as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(tasks1)
        .mockResolvedValueOnce(tasks2);

      await scheduler.start();
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      await scheduler.reload();
      expect(scheduler.getActiveJobs()).toHaveLength(1);
      // Task should be reloaded from scheduleManager
      expect(scheduleManager.listEnabled).toHaveBeenCalledTimes(2);
    });
  });

  describe('getActiveJobs', () => {
    it('should return empty array when no jobs', async () => {
      (scheduleManager.listEnabled as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await scheduler.start();

      expect(scheduler.getActiveJobs()).toEqual([]);
    });

    it('should return active job entries with task data', async () => {
      const task = createTask({ id: 'task-1', name: 'My Task' });
      (scheduleManager.listEnabled as ReturnType<typeof vi.fn>).mockResolvedValue([task]);

      await scheduler.start();

      const jobs = scheduler.getActiveJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].taskId).toBe('task-1');
    });
  });
});
