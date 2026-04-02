/**
 * Tests for Scheduler (packages/core/src/scheduling/scheduler.ts)
 *
 * Issue #1617 Phase 2: Tests for cron-based task execution engine.
 * Covers lifecycle management, task execution, cooldown, blocking, and error handling.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Scheduler } from './scheduler.js';
import type { SchedulerCallbacks, TaskExecutor } from './scheduler.js';
import type { ScheduleManager } from './schedule-manager.js';
import type { ScheduledTask } from './scheduled-task.js';
import type { CooldownManager } from './cooldown-manager.js';

// ============================================================================
// Helpers
// ============================================================================

/** Create a mock ScheduleManager. */
function createMockScheduleManager(tasks: ScheduledTask[] = []): ScheduleManager {
  return {
    listEnabled: vi.fn().mockResolvedValue(tasks),
    listAll: vi.fn().mockResolvedValue(tasks),
    get: vi.fn().mockImplementation(async (id: string) => tasks.find(t => t.id === id)),
    listByChatId: vi.fn().mockResolvedValue(tasks),
    getFileScanner: vi.fn().mockReturnValue({}),
  } as unknown as ScheduleManager;
}

/** Create a mock CooldownManager. */
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

/** Create a valid ScheduledTask. */
function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'schedule-test-task',
    name: 'Test Task',
    cron: '* * * * *', // every minute for testing
    prompt: 'Execute something',
    chatId: 'oc_test_chat',
    createdBy: 'ou_test_user',
    enabled: true,
    blocking: false,
    cooldownPeriod: 300000,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Create mock callbacks. */
function createMockCallbacks(): SchedulerCallbacks {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Scheduler', () => {
  let scheduleManager: ScheduleManager;
  let callbacks: SchedulerCallbacks;
  let executor: TaskExecutor;
  let cooldownManager: CooldownManager;

  beforeEach(() => {
    scheduleManager = createMockScheduleManager();
    callbacks = createMockCallbacks();
    executor = vi.fn().mockResolvedValue(undefined);
    cooldownManager = createMockCooldownManager();
  });

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------
  describe('constructor', () => {
    it('should create a scheduler with required options', () => {
      const scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
      });
      expect(scheduler).toBeDefined();
      expect(scheduler.isRunning()).toBe(false);
    });

    it('should create a scheduler with cooldown manager', () => {
      const scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
        cooldownManager,
      });
      expect(scheduler).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // start / stop lifecycle
  // -------------------------------------------------------------------------
  describe('start / stop', () => {
    it('should start and load enabled tasks', async () => {
      const task = makeTask({ id: 'task-1', name: 'Task 1', cron: '0 9 * * *' });
      scheduleManager = createMockScheduleManager([task]);

      const scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
      });

      await scheduler.start();
      expect(scheduler.isRunning()).toBe(true);

      const jobs = scheduler.getActiveJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].taskId).toBe('task-1');

      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should not start twice (idempotent)', async () => {
      const scheduler = new Scheduler({
        scheduleManager: createMockScheduleManager(),
        callbacks,
        executor,
      });

      await scheduler.start();
      await scheduler.start(); // Second call should be no-op

      expect(scheduler.isRunning()).toBe(true);
      scheduler.stop();
    });

    it('should start multiple enabled tasks', async () => {
      const tasks = [
        makeTask({ id: 'task-a', name: 'A', cron: '0 8 * * *' }),
        makeTask({ id: 'task-b', name: 'B', cron: '0 9 * * *' }),
        makeTask({ id: 'task-c', name: 'C', cron: '0 10 * * *' }),
      ];
      scheduleManager = createMockScheduleManager(tasks);

      const scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
      });

      await scheduler.start();
      expect(scheduler.getActiveJobs()).toHaveLength(3);

      scheduler.stop();
    });

    it('should stop all cron jobs', async () => {
      const tasks = [
        makeTask({ id: 't1', cron: '0 8 * * *' }),
        makeTask({ id: 't2', cron: '0 9 * * *' }),
      ];
      scheduleManager = createMockScheduleManager(tasks);

      const scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
      });

      await scheduler.start();
      expect(scheduler.getActiveJobs()).toHaveLength(2);

      scheduler.stop();
      expect(scheduler.getActiveJobs()).toHaveLength(0);
      expect(scheduler.isRunning()).toBe(false);
    });

    it('should handle stop when not running', () => {
      const scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
      });

      expect(() => scheduler.stop()).not.toThrow();
      expect(scheduler.isRunning()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // addTask / removeTask
  // -------------------------------------------------------------------------
  describe('addTask / removeTask', () => {
    it('should add a task and create a cron job', () => {
      const scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
      });

      const task = makeTask({ id: 'dynamic-task', cron: '*/5 * * * *' });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].taskId).toBe('dynamic-task');
      expect(jobs[0].task.name).toBe('Test Task');

      scheduler.stop();
    });

    it('should not add disabled tasks', () => {
      const scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
      });

      const task = makeTask({ id: 'disabled-task', enabled: false });
      scheduler.addTask(task);

      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should replace existing job when adding the same task ID', () => {
      const scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
      });

      const task = makeTask({ id: 'replace-task', cron: '0 8 * * *' });
      scheduler.addTask(task);
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      // Add again with same ID — should replace, not duplicate
      scheduler.addTask({ ...task, cron: '0 20 * * *' });
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      scheduler.stop();
    });

    it('should remove a task and stop its cron job', () => {
      const scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
      });

      const task = makeTask({ id: 'removable-task' });
      scheduler.addTask(task);
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      scheduler.removeTask('removable-task');
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should handle removing non-existent task gracefully', () => {
      const scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
      });

      expect(() => scheduler.removeTask('nonexistent')).not.toThrow();
    });

    it('should handle invalid cron expression gracefully', () => {
      const scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
      });

      const task = makeTask({ id: 'invalid-cron', cron: 'invalid-expression' });
      expect(() => scheduler.addTask(task)).not.toThrow();
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // reload
  // -------------------------------------------------------------------------
  describe('reload', () => {
    it('should stop all jobs and re-start with fresh tasks', async () => {
      const task = makeTask({ id: 'reload-task', cron: '0 9 * * *' });
      scheduleManager = createMockScheduleManager([task]);

      const scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
      });

      await scheduler.start();
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      await scheduler.reload();
      expect(scheduler.getActiveJobs()).toHaveLength(1); // Re-scheduled
      expect(scheduler.isRunning()).toBe(true);

      scheduler.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Task execution tracking (running tasks)
  // -------------------------------------------------------------------------
  describe('task execution tracking', () => {
    it('should report no running tasks initially', () => {
      const scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
      });

      expect(scheduler.isAnyTaskRunning()).toBe(false);
      expect(scheduler.getRunningTaskIds()).toEqual([]);
      expect(scheduler.isTaskRunning('any-task')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Cooldown delegation
  // -------------------------------------------------------------------------
  describe('cooldown delegation', () => {
    it('should return null when no cooldown manager is configured', async () => {
      const scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
      });

      const status = await scheduler.getCooldownStatus('any-task', 300000);
      expect(status).toBeNull();
    });

    it('should delegate getCooldownStatus to cooldown manager', async () => {
      const mockStatus = {
        isInCooldown: true,
        lastExecutionTime: new Date('2026-04-01T09:00:00Z'),
        cooldownEndsAt: new Date('2026-04-01T09:05:00Z'),
        remainingMs: 120000,
      };
      (cooldownManager.getCooldownStatus as ReturnType<typeof vi.fn>).mockResolvedValue(mockStatus);

      const scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
        cooldownManager,
      });

      const status = await scheduler.getCooldownStatus('task-1', 300000);
      expect(status).toEqual(mockStatus);
      expect(cooldownManager.getCooldownStatus).toHaveBeenCalledWith('task-1', 300000);
    });

    it('should delegate clearCooldown to cooldown manager', async () => {
      const scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
        cooldownManager,
      });

      const result = await scheduler.clearCooldown('task-1');
      expect(result).toBe(true);
      expect(cooldownManager.clearCooldown).toHaveBeenCalledWith('task-1');
    });

    it('should return false for clearCooldown when no cooldown manager', async () => {
      const scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
      });

      const result = await scheduler.clearCooldown('task-1');
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getActiveJobs
  // -------------------------------------------------------------------------
  describe('getActiveJobs', () => {
    it('should return empty array when no tasks are scheduled', () => {
      const scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
      });

      expect(scheduler.getActiveJobs()).toEqual([]);
    });

    it('should return job entries with task and taskId', () => {
      const scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
      });

      const task = makeTask({ id: 'job-task' });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].taskId).toBe('job-task');
      expect(jobs[0].task).toBe(task);
      expect(jobs[0].job).toBeDefined();

      scheduler.stop();
    });
  });

  // -------------------------------------------------------------------------
  // isRunning
  // -------------------------------------------------------------------------
  describe('isRunning', () => {
    it('should return false before start', () => {
      const scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
      });
      expect(scheduler.isRunning()).toBe(false);
    });

    it('should return true after start', async () => {
      const scheduler = new Scheduler({
        scheduleManager: createMockScheduleManager(),
        callbacks,
        executor,
      });

      await scheduler.start();
      expect(scheduler.isRunning()).toBe(true);
      scheduler.stop();
    });

    it('should return false after stop', async () => {
      const scheduler = new Scheduler({
        scheduleManager: createMockScheduleManager(),
        callbacks,
        executor,
      });

      await scheduler.start();
      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
    });
  });
});
