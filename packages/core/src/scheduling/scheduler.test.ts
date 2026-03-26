/**
 * Unit tests for Scheduler - cron-based task execution.
 *
 * Issue #1617 Phase 2 (P1): Tests for Scheduler lifecycle, task management,
 * cooldown enforcement, blocking mechanism, and anti-recursion protection.
 *
 * Tests cover:
 * - start/stop lifecycle
 * - addTask/removeTask with cron validation
 * - executeTask with cooldown check, blocking, and error handling
 * - buildScheduledTaskPrompt anti-recursion wrapping
 * - reload mechanism
 * - Running task tracking (isTaskRunning, getRunningTaskIds)
 * - Cooldown status and clearing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler, type SchedulerOptions, type SchedulerCallbacks, type TaskExecutor } from './scheduler.js';
import type { ScheduledTask } from './scheduled-task.js';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('cron', () => ({
  CronJob: vi.fn().mockImplementation((cronExpr, callback, _unused, start, _tz) => ({
    cronExpression: cronExpr,
    callback,
    running: start,
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ============================================================================
// Test fixtures
// ============================================================================

function createMockScheduleManager(tasks: ScheduledTask[] = []) {
  return {
    listEnabled: vi.fn().mockResolvedValue(tasks),
  };
}

function createMockCallbacks(): SchedulerCallbacks {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockExecutor(): TaskExecutor {
  return vi.fn().mockResolvedValue(undefined);
}

function createMockCooldownManager() {
  return {
    isInCooldown: vi.fn().mockResolvedValue(false),
    getCooldownStatus: vi.fn().mockResolvedValue({
      isInCooldown: false,
      lastExecutionTime: new Date(),
      cooldownEndsAt: new Date(),
      remainingMs: 0,
    }),
    recordExecution: vi.fn().mockResolvedValue(undefined),
    clearCooldown: vi.fn().mockResolvedValue(true),
  };
}

function createTestTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'test-task-1',
    name: 'Test Task',
    cron: '0 9 * * *',
    prompt: 'Execute test task',
    chatId: 'oc_test_chat',
    enabled: true,
    createdAt: '2026-03-27T00:00:00Z',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Scheduler', () => {
  let scheduler: Scheduler;
  let scheduleManager: ReturnType<typeof createMockScheduleManager>;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let executor: ReturnType<typeof createMockExecutor>;

  beforeEach(() => {
    vi.clearAllMocks();
    scheduleManager = createMockScheduleManager();
    callbacks = createMockCallbacks();
    executor = createMockExecutor();
  });

  afterEach(() => {
    if (scheduler) {
      scheduler.stop();
    }
  });

  // ==========================================================================
  // Constructor
  // ==========================================================================

  describe('constructor', () => {
    it('should create scheduler with required options', () => {
      scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
      });

      expect(scheduler.isRunning()).toBe(false);
    });

    it('should accept optional cooldownManager', () => {
      const cooldownManager = createMockCooldownManager();
      scheduler = new Scheduler({
        scheduleManager,
        callbacks,
        executor,
        cooldownManager,
      });

      expect(scheduler.isRunning()).toBe(false);
    });
  });

  // ==========================================================================
  // start / stop
  // ==========================================================================

  describe('start / stop', () => {
    it('should start and schedule all enabled tasks', async () => {
      const task = createTestTask();
      scheduleManager.listEnabled.mockResolvedValue([task]);

      scheduler = new Scheduler({ scheduleManager, callbacks, executor });
      await scheduler.start();

      expect(scheduler.isRunning()).toBe(true);
      expect(scheduleManager.listEnabled).toHaveBeenCalledTimes(1);
      expect(scheduler.getActiveJobs()).toHaveLength(1);
    });

    it('should be idempotent - second start is a no-op', async () => {
      scheduleManager.listEnabled.mockResolvedValue([]);

      scheduler = new Scheduler({ scheduleManager, callbacks, executor });
      await scheduler.start();
      await scheduler.start(); // Should warn and return

      expect(scheduleManager.listEnabled).toHaveBeenCalledTimes(1);
    });

    it('should stop all active jobs and clear state', async () => {
      const task1 = createTestTask({ id: 'task-1' });
      const task2 = createTestTask({ id: 'task-2', cron: '0 10 * * *' });
      scheduleManager.listEnabled.mockResolvedValue([task1, task2]);

      scheduler = new Scheduler({ scheduleManager, callbacks, executor });
      await scheduler.start();
      expect(scheduler.getActiveJobs()).toHaveLength(2);

      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should handle start with no enabled tasks', async () => {
      scheduleManager.listEnabled.mockResolvedValue([]);

      scheduler = new Scheduler({ scheduleManager, callbacks, executor });
      await scheduler.start();

      expect(scheduler.isRunning()).toBe(true);
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });
  });

  // ==========================================================================
  // addTask / removeTask
  // ==========================================================================

  describe('addTask / removeTask', () => {
    it('should add an enabled task and create a cron job', () => {
      scheduler = new Scheduler({ scheduleManager, callbacks, executor });
      const task = createTestTask();

      scheduler.addTask(task);

      expect(scheduler.getActiveJobs()).toHaveLength(1);
      expect(scheduler.getActiveJobs()[0].taskId).toBe('test-task-1');
    });

    it('should not schedule a disabled task', () => {
      scheduler = new Scheduler({ scheduleManager, callbacks, executor });
      const task = createTestTask({ enabled: false });

      scheduler.addTask(task);

      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should replace existing task when adding with same ID', () => {
      scheduler = new Scheduler({ scheduleManager, callbacks, executor });
      const task1 = createTestTask({ id: 'same-id', name: 'Original' });
      const task2 = createTestTask({ id: 'same-id', name: 'Updated', cron: '0 10 * * *' });

      scheduler.addTask(task1);
      scheduler.addTask(task2);

      expect(scheduler.getActiveJobs()).toHaveLength(1);
    });

    it('should remove an existing task', () => {
      scheduler = new Scheduler({ scheduleManager, callbacks, executor });
      const task = createTestTask();

      scheduler.addTask(task);
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      scheduler.removeTask('test-task-1');
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should handle removing a non-existent task gracefully', () => {
      scheduler = new Scheduler({ scheduleManager, callbacks, executor });

      // Should not throw
      scheduler.removeTask('non-existent');
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });
  });

  // ==========================================================================
  // executeTask (tested via direct invocation)
  // ==========================================================================

  describe('task execution', () => {
    it('should execute task with wrapped anti-recursion prompt', async () => {
      scheduler = new Scheduler({ scheduleManager, callbacks, executor });
      const task = createTestTask();

      // Get the active job and invoke its callback directly
      scheduler.addTask(task);
      const activeJob = scheduler.getActiveJobs()[0];

      await (activeJob.job as unknown as { callback: () => Promise<void> }).callback();

      expect(executor).toHaveBeenCalledWith(
        'oc_test_chat',
        expect.stringContaining('Scheduled Task Execution Context'),
        undefined,
        undefined
      );
      expect(executor).toHaveBeenCalledWith(
        'oc_test_chat',
        expect.stringContaining(task.name),
        undefined,
        undefined
      );
      expect(executor).toHaveBeenCalledWith(
        'oc_test_chat',
        expect.stringContaining('Do NOT create new scheduled tasks'),
        undefined,
        undefined
      );
      expect(executor).toHaveBeenCalledWith(
        'oc_test_chat',
        expect.stringContaining(task.prompt),
        undefined,
        undefined
      );
    });

    it('should send start notification before execution', async () => {
      scheduler = new Scheduler({ scheduleManager, callbacks, executor });
      const task = createTestTask();

      scheduler.addTask(task);
      const activeJob = scheduler.getActiveJobs()[0];

      await (activeJob.job as unknown as { callback: () => Promise<void> }).callback();

      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_test_chat',
        expect.stringContaining('开始执行')
      );
    });

    it('should send error notification on execution failure', async () => {
      const failingExecutor = vi.fn().mockRejectedValue(new Error('Agent crashed'));
      scheduler = new Scheduler({ scheduleManager, callbacks, executor: failingExecutor });
      const task = createTestTask();

      scheduler.addTask(task);
      const activeJob = scheduler.getActiveJobs()[0];

      await (activeJob.job as unknown as { callback: () => Promise<void> }).callback();

      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_test_chat',
        expect.stringContaining('执行失败')
      );
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_test_chat',
        expect.stringContaining('Agent crashed')
      );
    });

    it('should track running task and clear after completion', async () => {
      let executionResolve: (() => void) | undefined;
      const slowExecutor = vi.fn().mockImplementation(() => {
        return new Promise<void>((resolve) => { executionResolve = resolve; });
      });
      scheduler = new Scheduler({ scheduleManager, callbacks, executor: slowExecutor });
      const task = createTestTask({ blocking: true });

      scheduler.addTask(task);
      const activeJob = scheduler.getActiveJobs()[0];

      const executionPromise = (activeJob.job as unknown as { callback: () => Promise<void> }).callback();

      // Wait for microtasks to complete (executeTask is async, awaits sendMessage first)
      await new Promise(resolve => setImmediate(resolve));

      // Task should be tracked as running during execution
      expect(scheduler.isTaskRunning('test-task-1')).toBe(true);
      expect(scheduler.getRunningTaskIds()).toEqual(['test-task-1']);
      expect(scheduler.isAnyTaskRunning()).toBe(true);
      expect(executionResolve).toBeDefined();

      // Complete the execution
      executionResolve!();
      await executionPromise;

      // Task should no longer be tracked
      expect(scheduler.isTaskRunning('test-task-1')).toBe(false);
      expect(scheduler.getRunningTaskIds()).toEqual([]);
      expect(scheduler.isAnyTaskRunning()).toBe(false);
    });

    it('should always clear running state even on error', async () => {
      const failingExecutor = vi.fn().mockRejectedValue(new Error('fail'));
      scheduler = new Scheduler({ scheduleManager, callbacks, executor: failingExecutor });
      const task = createTestTask();

      scheduler.addTask(task);
      const activeJob = scheduler.getActiveJobs()[0];

      await (activeJob.job as unknown as { callback: () => Promise<void> }).callback();

      expect(scheduler.isTaskRunning('test-task-1')).toBe(false);
    });
  });

  // ==========================================================================
  // Blocking mechanism
  // ==========================================================================

  describe('blocking mechanism', () => {
    it('should skip task execution if previous run is still in progress', async () => {
      let executionResolve: (() => void) | undefined;
      const slowExecutor = vi.fn().mockImplementation(() => {
        return new Promise<void>((resolve) => { executionResolve = resolve; });
      });
      scheduler = new Scheduler({ scheduleManager, callbacks, executor: slowExecutor });
      const task = createTestTask({ blocking: true });

      scheduler.addTask(task);
      const activeJob = scheduler.getActiveJobs()[0];

      // Start first execution
      const firstPromise = (activeJob.job as unknown as { callback: () => Promise<void> }).callback();
      // Wait for microtasks
      await new Promise(resolve => setImmediate(resolve));
      expect(scheduler.isTaskRunning('test-task-1')).toBe(true);

      // Try second execution while first is still running
      await (activeJob.job as unknown as { callback: () => Promise<void> }).callback();
      // Second execution should be skipped (executor called only once)
      expect(slowExecutor).toHaveBeenCalledTimes(1);

      // Complete first execution
      expect(executionResolve).toBeDefined();
      executionResolve!();
      await firstPromise;
    });

    it('should allow non-blocking tasks to run concurrently', async () => {
      const executor = vi.fn().mockResolvedValue(undefined);
      scheduler = new Scheduler({ scheduleManager, callbacks, executor });
      const task = createTestTask({ blocking: false });

      scheduler.addTask(task);
      const activeJob = scheduler.getActiveJobs()[0];

      // Multiple executions should be allowed
      await (activeJob.job as unknown as { callback: () => Promise<void> }).callback();
      await (activeJob.job as unknown as { callback: () => Promise<void> }).callback();

      expect(executor).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // Cooldown mechanism
  // ==========================================================================

  describe('cooldown mechanism', () => {
    it('should skip execution when task is in cooldown', async () => {
      const cooldownManager = createMockCooldownManager();
      cooldownManager.isInCooldown.mockResolvedValue(true);
      cooldownManager.getCooldownStatus.mockResolvedValue({
        isInCooldown: true,
        lastExecutionTime: new Date('2026-03-27T09:00:00Z'),
        cooldownEndsAt: new Date('2026-03-27T10:00:00Z'),
        remainingMs: 30 * 60 * 1000,
      });

      scheduler = new Scheduler({ scheduleManager, callbacks, executor, cooldownManager });
      const task = createTestTask({ cooldownPeriod: 3600000 });

      scheduler.addTask(task);
      const activeJob = scheduler.getActiveJobs()[0];

      await (activeJob.job as unknown as { callback: () => Promise<void> }).callback();

      expect(executor).not.toHaveBeenCalled();
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_test_chat',
        expect.stringContaining('冷静期中')
      );
    });

    it('should record execution after successful completion', async () => {
      const cooldownManager = createMockCooldownManager();
      scheduler = new Scheduler({ scheduleManager, callbacks, executor, cooldownManager });
      const task = createTestTask({ cooldownPeriod: 1800000 });

      scheduler.addTask(task);
      const activeJob = scheduler.getActiveJobs()[0];

      await (activeJob.job as unknown as { callback: () => Promise<void> }).callback();

      expect(cooldownManager.recordExecution).toHaveBeenCalledWith('test-task-1', 1800000);
    });

    it('should record execution even on failure', async () => {
      const failingExecutor = vi.fn().mockRejectedValue(new Error('fail'));
      const cooldownManager = createMockCooldownManager();
      scheduler = new Scheduler({ scheduleManager, callbacks, executor: failingExecutor, cooldownManager });
      const task = createTestTask({ cooldownPeriod: 600000 });

      scheduler.addTask(task);
      const activeJob = scheduler.getActiveJobs()[0];

      await (activeJob.job as unknown as { callback: () => Promise<void> }).callback();

      expect(cooldownManager.recordExecution).toHaveBeenCalledWith('test-task-1', 600000);
    });

    it('should not check cooldown when task has no cooldownPeriod', async () => {
      const cooldownManager = createMockCooldownManager();
      scheduler = new Scheduler({ scheduleManager, callbacks, executor, cooldownManager });
      const task = createTestTask(); // No cooldownPeriod

      scheduler.addTask(task);
      const activeJob = scheduler.getActiveJobs()[0];

      await (activeJob.job as unknown as { callback: () => Promise<void> }).callback();

      expect(cooldownManager.isInCooldown).not.toHaveBeenCalled();
      expect(executor).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Cooldown status and clearing
  // ==========================================================================

  describe('cooldown status', () => {
    it('should return null when no cooldownManager is set', async () => {
      scheduler = new Scheduler({ scheduleManager, callbacks, executor });

      const status = await scheduler.getCooldownStatus('task-1', 60000);
      expect(status).toBeNull();
    });

    it('should delegate to cooldownManager for status', async () => {
      const cooldownManager = createMockCooldownManager();
      scheduler = new Scheduler({ scheduleManager, callbacks, executor, cooldownManager });

      await scheduler.getCooldownStatus('task-1', 60000);
      expect(cooldownManager.getCooldownStatus).toHaveBeenCalledWith('task-1', 60000);
    });

    it('should return false when clearing cooldown without cooldownManager', async () => {
      scheduler = new Scheduler({ scheduleManager, callbacks, executor });

      const result = await scheduler.clearCooldown('task-1');
      expect(result).toBe(false);
    });

    it('should delegate to cooldownManager for clearing', async () => {
      const cooldownManager = createMockCooldownManager();
      scheduler = new Scheduler({ scheduleManager, callbacks, executor, cooldownManager });

      const result = await scheduler.clearCooldown('task-1');
      expect(cooldownManager.clearCooldown).toHaveBeenCalledWith('task-1');
      expect(result).toBe(true);
    });
  });

  // ==========================================================================
  // Model override
  // ==========================================================================

  describe('model override', () => {
    it('should pass model override to executor when task has model', async () => {
      scheduler = new Scheduler({ scheduleManager, callbacks, executor });
      const task = createTestTask({ model: 'claude-sonnet-4-20250514' });

      scheduler.addTask(task);
      const activeJob = scheduler.getActiveJobs()[0];

      await (activeJob.job as unknown as { callback: () => Promise<void> }).callback();

      expect(executor).toHaveBeenCalledWith(
        'oc_test_chat',
        expect.any(String),
        undefined,
        'claude-sonnet-4-20250514'
      );
    });

    it('should pass createdBy to executor', async () => {
      scheduler = new Scheduler({ scheduleManager, callbacks, executor });
      const task = createTestTask({ createdBy: 'ou_user123' });

      scheduler.addTask(task);
      const activeJob = scheduler.getActiveJobs()[0];

      await (activeJob.job as unknown as { callback: () => Promise<void> }).callback();

      expect(executor).toHaveBeenCalledWith(
        'oc_test_chat',
        expect.any(String),
        'ou_user123',
        undefined
      );
    });
  });

  // ==========================================================================
  // Reload
  // ==========================================================================

  describe('reload', () => {
    it('should stop and restart with fresh task list', async () => {
      const task1 = createTestTask({ id: 'old-task' });
      const task2 = createTestTask({ id: 'new-task', name: 'New Task' });
      scheduleManager.listEnabled
        .mockResolvedValueOnce([task1])
        .mockResolvedValueOnce([task2]);

      scheduler = new Scheduler({ scheduleManager, callbacks, executor });
      await scheduler.start();
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      await scheduler.reload();
      expect(scheduler.getActiveJobs()).toHaveLength(1);
      expect(scheduler.getActiveJobs()[0].taskId).toBe('new-task');
    });
  });

  // ==========================================================================
  // Running task tracking
  // ==========================================================================

  describe('running task tracking', () => {
    it('should return false for non-running task', () => {
      scheduler = new Scheduler({ scheduleManager, callbacks, executor });

      expect(scheduler.isTaskRunning('non-existent')).toBe(false);
    });

    it('should return false for isAnyTaskRunning when no tasks running', () => {
      scheduler = new Scheduler({ scheduleManager, callbacks, executor });

      expect(scheduler.isAnyTaskRunning()).toBe(false);
    });

    it('should return empty array for getRunningTaskIds when no tasks running', () => {
      scheduler = new Scheduler({ scheduleManager, callbacks, executor });

      expect(scheduler.getRunningTaskIds()).toEqual([]);
    });

    it('should return empty array for getActiveJobs when no tasks scheduled', () => {
      scheduler = new Scheduler({ scheduleManager, callbacks, executor });

      expect(scheduler.getActiveJobs()).toEqual([]);
    });
  });

  // ==========================================================================
  // Anti-recursion prompt
  // ==========================================================================

  describe('anti-recursion prompt', () => {
    it('should wrap task prompt with anti-recursion instructions', async () => {
      scheduler = new Scheduler({ scheduleManager, callbacks, executor });
      const task = createTestTask({ prompt: 'Do something useful' });

      scheduler.addTask(task);
      const activeJob = scheduler.getActiveJobs()[0];

      await (activeJob.job as unknown as { callback: () => Promise<void> }).callback();

      const wrappedPrompt = (executor as ReturnType<typeof vi.fn>).mock.calls[0][1];

      // Should contain anti-recursion rules
      expect(wrappedPrompt).toContain('Do NOT create new scheduled tasks');
      expect(wrappedPrompt).toContain('Do NOT modify existing scheduled tasks');
      expect(wrappedPrompt).toContain('Scheduled task creation is blocked');

      // Should contain original prompt
      expect(wrappedPrompt).toContain('Do something useful');

      // Should contain task name
      expect(wrappedPrompt).toContain('Test Task');
    });
  });
});
