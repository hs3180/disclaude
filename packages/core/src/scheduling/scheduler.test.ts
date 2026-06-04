/**
 * Tests for Scheduler.
 *
 * Verifies cron-based task execution via InputMessageRouter,
 * cooldown handling, blocking mechanism, and lifecycle management.
 *
 * Issue #1617: Phase 2 - scheduling module test coverage.
 * Issue #3901: Removed dead executor path, all tests use InputMessageRouter.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Scheduler, TaskTimeoutError, type SchedulerCallbacks } from './scheduler.js';
import type { ScheduleManager } from './schedule-manager.js';
import type { ScheduledTask } from './scheduled-task.js';
import type { CooldownManager } from './cooldown-manager.js';
import type { MessageRouter } from '../messaging/message-router.js';
import type { SystemMessage } from '../types/message.js';

/**
 * Create a mock InputMessageRouter for use in Scheduler tests.
 * Uses `as unknown as MessageRouter` because MessageRouter is a concrete class
 * with private fields (handler, log) that cannot be satisfied by a plain object.
 */
function createMockRouter() {
  return {
    route: vi.fn().mockResolvedValue(undefined),
  } as unknown as MessageRouter;
}

/** Type for accessing mock route call assertions (MessageRouter cast loses mock type info) */
type MockRouter = { route: Mock<(message: SystemMessage) => Promise<void>> };

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
  let mockRouter: MessageRouter;
  /** Typed view of mockRouter for assertion access (mock.calls etc.) */
  let mockRouterAsMock: MockRouter;
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

    mockRouter = createMockRouter();
    mockRouterAsMock = mockRouter as unknown as MockRouter;

    scheduler = new Scheduler({
      scheduleManager: mockScheduleManager,
      callbacks: mockCallbacks,
      inputMessageRouter: mockRouter,
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
        cooldownManager: mockCooldownManager,
        inputMessageRouter: mockRouter,
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

      await scheduler.stop();

      expect(scheduler.isRunning()).toBe(false);
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should handle stop when not running', async () => {
      await expect(scheduler.stop()).resolves.toBeUndefined();
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

    it('should wait for running tasks to complete on stop (Issue #3415)', async () => {
      const task = createTask({ id: 'graceful-stop-1' });
      scheduler.addTask(task);

      // Start a task execution that takes 200ms
      mockRouterAsMock.route.mockImplementationOnce(() => new Promise(resolve => setTimeout(resolve, 200)));

      // Fire the cron job to start execution
      const jobs = scheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();

      // Wait for execution to start
      await vi.waitFor(() => {
        expect(scheduler.isTaskRunning('graceful-stop-1')).toBe(true);
      }, { timeout: 1000 });

      // Stop should wait for the running task to complete
      const stopPromise = scheduler.stop(2000);

      // Task should still be tracked as running immediately after stop() call
      expect(scheduler.isRunning()).toBe(false);
      expect(scheduler.getActiveJobs()).toHaveLength(0);

      // Stop should eventually resolve after task completes
      await stopPromise;

      // Running task should be cleared after completion
      expect(scheduler.isTaskRunning('graceful-stop-1')).toBe(false);
    });

    it('should timeout waiting for running tasks if they exceed shutdown timeout (Issue #3415)', async () => {
      const task = createTask({ id: 'timeout-stop-1' });
      scheduler.addTask(task);

      // Start a task that never completes
      mockRouterAsMock.route.mockReturnValueOnce(new Promise(() => {}));

      const jobs = scheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();

      await vi.waitFor(() => {
        expect(scheduler.isTaskRunning('timeout-stop-1')).toBe(true);
      }, { timeout: 1000 });

      // Stop with a very short timeout (50ms)
      const start = Date.now();
      await scheduler.stop(50);
      const elapsed = Date.now() - start;

      // Should have waited approximately 50ms before giving up
      expect(elapsed).toBeGreaterThanOrEqual(40);
      expect(elapsed).toBeLessThan(500); // generous upper bound
    });

    it('should skip waiting when no tasks are running (Issue #3415)', async () => {
      const task = createTask({ id: 'quick-stop-1' });
      scheduler.addTask(task);

      // No task is running, stop should complete immediately
      const start = Date.now();
      await scheduler.stop();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(100); // should be near-instant
      expect(scheduler.isRunning()).toBe(false);
    });

    it('should skip waiting when timeout is 0 (Issue #3415)', async () => {
      const task = createTask({ id: 'instant-stop-1' });
      scheduler.addTask(task);

      // Start a task that never completes
      mockRouterAsMock.route.mockReturnValueOnce(new Promise(() => {}));
      const jobs = scheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();

      await vi.waitFor(() => {
        expect(scheduler.isTaskRunning('instant-stop-1')).toBe(true);
      }, { timeout: 1000 });

      // Stop with timeout 0 — should skip waiting
      const start = Date.now();
      await scheduler.stop(0);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50); // should be near-instant
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
        cooldownManager: mockCooldownManager,
        inputMessageRouter: mockRouter,
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
    /** Helper: fire a cron job trigger (sync, use vi.waitFor for assertions) */
    function fireJob(jobs: ReturnType<typeof scheduler.getActiveJobs>) {
      void jobs[0].job.fireOnTick();
    }

    /** Helper: extract the first SystemMessage from mock route calls */
    function getRoutedMessage(): SystemMessage {
      const [[msg]] = mockRouterAsMock.route.mock.calls as unknown as [[SystemMessage]];
      return msg;
    }

    it('should route task through InputMessageRouter and send start message', async () => {
      const task = createTask({ id: 'exec-1' });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      expect(jobs).toHaveLength(1);

      fireJob(jobs);
      await vi.waitFor(() => {
        expect(mockRouterAsMock.route).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      expect(mockCallbacks.sendMessage).toHaveBeenCalledWith(
        'oc_test',
        expect.stringContaining('开始执行'),
      );

      const routedMessage = getRoutedMessage();
      expect(routedMessage.chatId).toBe('oc_test');
      expect(routedMessage.payload).toContain('Run tests');
      expect(routedMessage.source).toBe('system');
      expect(routedMessage.trigger).toBe('scheduled');
    });

    it('should construct SystemMessage with model and modelTier', async () => {
      const task = createTask({
        id: 'exec-2',
        createdBy: 'user-123',
        model: 'claude-sonnet-4',
        modelTier: 'low',
      });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      fireJob(jobs);
      await vi.waitFor(() => {
        expect(mockRouterAsMock.route).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      const routedMessage = getRoutedMessage();
      expect(routedMessage.data!.taskId).toBe('exec-2');
      expect(routedMessage.data!.createdBy).toBe('user-123');
      expect(routedMessage.data!.model).toBe('claude-sonnet-4');
      expect(routedMessage.modelTier).toBe('low');
    });

    it('should send error message when router fails', async () => {
      mockRouterAsMock.route.mockRejectedValueOnce(new Error('Router crashed'));

      const task = createTask({ id: 'exec-3' });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      fireJob(jobs);
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
      fireJob(jobs);
      await vi.waitFor(() => {
        expect(mockRouterAsMock.route).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      const routedMessage = getRoutedMessage();
      expect(routedMessage.payload).toContain('Scheduled Task Execution Context');
      expect(routedMessage.payload).toContain('My Task');
      expect(routedMessage.payload).toContain('Do NOT create new scheduled tasks');
      expect(routedMessage.payload).toContain('Do something');
    });

    it('should handle non-Error exceptions from router', async () => {
      mockRouterAsMock.route.mockRejectedValueOnce('string error');

      const task = createTask({ id: 'exec-5' });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      fireJob(jobs);
      await vi.waitFor(() => {
        expect(mockCallbacks.sendMessage).toHaveBeenCalledWith(
          'oc_test',
          expect.stringContaining('string error'),
        );
      }, { timeout: 2000 });
    });

    it('should clear running state even when router fails', async () => {
      mockRouterAsMock.route.mockRejectedValueOnce(new Error('failure'));

      const task = createTask({ id: 'fail-clear' });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      fireJob(jobs);
      await vi.waitFor(() => {
        expect(scheduler.isTaskRunning('fail-clear')).toBe(false);
      }, { timeout: 2000 });
    });

    it('should timeout when route() hangs beyond timeoutMs (Issue #3894)', async () => {
      // Create a route() that never resolves
      mockRouterAsMock.route.mockReturnValueOnce(new Promise(() => {}));

      // Use a very short timeout for testing (50ms)
      const task = createTask({ id: 'timeout-1', timeoutMs: 50 });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      fireJob(jobs);

      await vi.waitFor(() => {
        expect(mockCallbacks.sendMessage).toHaveBeenCalledWith(
          'oc_test',
          expect.stringContaining('执行超时'),
        );
      }, { timeout: 3000 });
    });

    it('should clear running state after timeout', async () => {
      mockRouterAsMock.route.mockReturnValueOnce(new Promise(() => {}));

      const task = createTask({ id: 'timeout-cleanup', timeoutMs: 50 });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      fireJob(jobs);

      await vi.waitFor(() => {
        expect(scheduler.isTaskRunning('timeout-cleanup')).toBe(false);
      }, { timeout: 3000 });
    });

    it('should send explicit notification when no inputMessageRouter configured', async () => {
      const noRouterScheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
      });

      const task = createTask({ id: 'no-router' });
      noRouterScheduler.addTask(task);

      const jobs = noRouterScheduler.getActiveJobs();
      fireJob(jobs);

      await vi.waitFor(() => {
        expect(mockCallbacks.sendMessage).toHaveBeenCalledWith(
          'oc_test',
          expect.stringContaining('无法执行'),
        );
      }, { timeout: 2000 });

      // Should NOT send start notification when router is missing
      const calls = vi.mocked(mockCallbacks.sendMessage).mock.calls; // eslint-disable-line prefer-destructuring
      const startCall = calls.find(c => c[1].includes('开始执行'));
      expect(startCall).toBeUndefined();
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
        cooldownManager: mockCooldownManager,
        inputMessageRouter: mockRouter,
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

      // Router should NOT be called when in cooldown
      expect(mockRouterAsMock.route).not.toHaveBeenCalled();
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
        cooldownManager: mockCooldownManager,
        inputMessageRouter: mockRouter,
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

      mockRouterAsMock.route.mockRejectedValueOnce(new Error('task failed'));

      const cooldownScheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        cooldownManager: mockCooldownManager,
        inputMessageRouter: mockRouter,
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
        cooldownManager: mockCooldownManager,
        inputMessageRouter: mockRouter,
      });

      // Task without cooldownPeriod
      const task = createTask({ id: 'no-cd' });
      cooldownScheduler.addTask(task);

      const jobs = cooldownScheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();
      await vi.waitFor(() => {
        expect(mockRouterAsMock.route).toHaveBeenCalledTimes(1);
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

  describe('executeTask blocking mechanism', () => {
    it('should skip execution when blocking=true and task already running', async () => {
      // First execution never completes
      mockRouterAsMock.route.mockReturnValueOnce(new Promise(() => {}));

      const task = createTask({ id: 'blocking-1', blocking: true });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();

      // First trigger starts execution
      void jobs[0].job.fireOnTick();
      await vi.waitFor(() => {
        expect(scheduler.isTaskRunning('blocking-1')).toBe(true);
      }, { timeout: 2000 });

      // Second trigger while still running should be skipped
      void jobs[0].job.fireOnTick();
      await new Promise(resolve => setTimeout(resolve, 100));

      // Router should only be called once (second trigger was skipped)
      expect(mockRouterAsMock.route).toHaveBeenCalledTimes(1);
    });

    it('should allow execution when blocking=false even if previous still running', async () => {
      mockRouterAsMock.route.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 200)));

      const task = createTask({ id: 'non-blocking', blocking: false });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();

      void jobs[0].job.fireOnTick();
      await vi.waitFor(() => {
        expect(scheduler.isTaskRunning('non-blocking')).toBe(true);
      }, { timeout: 2000 });

      // Second trigger while running - should start since blocking=false
      void jobs[0].job.fireOnTick();
      await new Promise(resolve => setTimeout(resolve, 100));

      // Both executions should have been initiated
      expect(mockRouterAsMock.route).toHaveBeenCalledTimes(2);
    });

    it('should allow execution after previous blocking task completes', async () => {
      // First execution completes quickly
      mockRouterAsMock.route.mockResolvedValueOnce(undefined);
      // Second execution also succeeds
      mockRouterAsMock.route.mockResolvedValueOnce(undefined);

      const task = createTask({ id: 'blocking-done', blocking: true });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();

      // First trigger
      void jobs[0].job.fireOnTick();
      await vi.waitFor(() => {
        expect(scheduler.isTaskRunning('blocking-done')).toBe(false);
      }, { timeout: 2000 });

      // Second trigger after completion — should execute
      void jobs[0].job.fireOnTick();
      await vi.waitFor(() => {
        expect(mockRouterAsMock.route).toHaveBeenCalledTimes(2);
      }, { timeout: 2000 });
    });
  });

  describe('executeTask timeout protection (Issue #3894)', () => {
    it('should timeout when InputMessageRouter.route hangs beyond default timeout', async () => {
      // Route never resolves
      mockRouterAsMock.route.mockReturnValueOnce(new Promise(() => {}));

      const task = createTask({ id: 'timeout-1', timeoutMs: 100 });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();

      await vi.waitFor(() => {
        expect(mockCallbacks.sendMessage).toHaveBeenCalledWith(
          'oc_test',
          expect.stringContaining('执行超时'),
        );
      }, { timeout: 3000 });

      // Task should be cleared from running state after timeout
      expect(scheduler.isTaskRunning('timeout-1')).toBe(false);
    });

    it('should use default 5-minute timeout when task has no timeoutMs', async () => {
      mockRouterAsMock.route.mockResolvedValueOnce(undefined);

      const task = createTask({ id: 'timeout-default' });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();

      // Should complete normally (route resolves before 5-minute default)
      await vi.waitFor(() => {
        expect(mockRouterAsMock.route).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });
    });

    it('should clear running state after timeout', async () => {
      mockRouterAsMock.route.mockReturnValueOnce(new Promise(() => {}));

      const task = createTask({ id: 'timeout-cleanup', timeoutMs: 50, blocking: true });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();

      // Wait for timeout to occur and running state to clear
      await vi.waitFor(() => {
        expect(scheduler.isTaskRunning('timeout-cleanup')).toBe(false);
      }, { timeout: 2000 });
    });

    it('should allow re-execution after timeout with blocking=true', async () => {
      // First call hangs (will timeout)
      mockRouterAsMock.route.mockReturnValueOnce(new Promise(() => {}));
      // Second call succeeds
      mockRouterAsMock.route.mockResolvedValueOnce(undefined);

      const task = createTask({ id: 'timeout-retry', timeoutMs: 50, blocking: true });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();

      // First trigger — will timeout
      void jobs[0].job.fireOnTick();
      await vi.waitFor(() => {
        expect(scheduler.isTaskRunning('timeout-retry')).toBe(false);
      }, { timeout: 2000 });

      // Second trigger — should execute since timeout cleared the running state
      void jobs[0].job.fireOnTick();
      await vi.waitFor(() => {
        expect(mockRouterAsMock.route).toHaveBeenCalledTimes(2);
      }, { timeout: 2000 });
    });

    it('should send specific timeout message with duration', async () => {
      mockRouterAsMock.route.mockReturnValueOnce(new Promise(() => {}));

      const task = createTask({ id: 'timeout-msg', name: 'Report Gen', timeoutMs: 100 });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();

      // Wait for the timeout notification specifically
      await vi.waitFor(() => {
        const {calls} = vi.mocked(mockCallbacks.sendMessage).mock;
        const timeoutCall = calls.find(c => c[1].includes('执行超时'));
        expect(timeoutCall).toBeDefined();
      }, { timeout: 3000 });

      const {calls} = vi.mocked(mockCallbacks.sendMessage).mock;
      const timeoutCall = calls.find(c => c[1].includes('执行超时'));
      expect(timeoutCall![1]).toContain('Report Gen');
    });

    it('should record cooldown even after timeout', async () => {
      const mockCooldownManager = {
        isInCooldown: vi.fn().mockResolvedValue(false),
        recordExecution: vi.fn().mockResolvedValue(undefined),
        getCooldownStatus: vi.fn().mockResolvedValue(null),
        clearCooldown: vi.fn().mockResolvedValue(true),
      } as unknown as CooldownManager;

      mockRouterAsMock.route.mockReturnValueOnce(new Promise(() => {}));

      const cooldownScheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        cooldownManager: mockCooldownManager,
        inputMessageRouter: mockRouter,
      });

      const task = createTask({ id: 'timeout-cd', timeoutMs: 50, cooldownPeriod: 60000 });
      cooldownScheduler.addTask(task);

      const jobs = cooldownScheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();

      await vi.waitFor(() => {
        expect(mockCooldownManager.recordExecution).toHaveBeenCalledWith('timeout-cd', 60000);
      }, { timeout: 2000 });
    });
  });

  describe('TaskTimeoutError', () => {
    it('should have correct properties', () => {
      const err = new TaskTimeoutError('my-task', 300000);
      expect(err.name).toBe('TaskTimeoutError');
      expect(err.taskId).toBe('my-task');
      expect(err.timeoutMs).toBe(300000);
      expect(err.message).toContain('my-task');
      expect(err.message).toContain('5');
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('executeTask agent busy check (Issue #3931)', () => {
    it('should skip blocking task when agent is busy', async () => {
      const isAgentBusy = vi.fn().mockReturnValue(true);
      const busyScheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        inputMessageRouter: mockRouter,
        isAgentBusy,
      });

      const task = createTask({ id: 'busy-1', blocking: true });
      busyScheduler.addTask(task);

      const jobs = busyScheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();

      // Use vi.waitFor for robust async assertion instead of fixed setTimeout
      await vi.waitFor(() => {
        // Should check agent busy state
        expect(isAgentBusy).toHaveBeenCalledWith('oc_test');
      }, { timeout: 2000 });

      // Router should NOT be called when agent is busy
      expect(mockRouterAsMock.route).not.toHaveBeenCalled();
      // Task should not be running
      expect(busyScheduler.isTaskRunning('busy-1')).toBe(false);
    });

    it('should execute blocking task when agent is idle', async () => {
      const isAgentBusy = vi.fn().mockReturnValue(false);
      const idleScheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        inputMessageRouter: mockRouter,
        isAgentBusy,
      });

      const task = createTask({ id: 'idle-1', blocking: true });
      idleScheduler.addTask(task);

      const jobs = idleScheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();

      await vi.waitFor(() => {
        expect(mockRouterAsMock.route).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      expect(isAgentBusy).toHaveBeenCalledWith('oc_test');
    });

    it('should not check agent busy state for non-blocking tasks', async () => {
      const isAgentBusy = vi.fn().mockReturnValue(true);
      const nonBlockScheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        inputMessageRouter: mockRouter,
        isAgentBusy,
      });

      const task = createTask({ id: 'nonblock-1', blocking: false });
      nonBlockScheduler.addTask(task);

      const jobs = nonBlockScheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();

      await vi.waitFor(() => {
        expect(mockRouterAsMock.route).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      // Should NOT check agent busy for non-blocking tasks
      expect(isAgentBusy).not.toHaveBeenCalled();
    });

    it('should execute task when isAgentBusy callback is not configured', async () => {
      const task = createTask({ id: 'no-callback-1', blocking: true });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();

      await vi.waitFor(() => {
        expect(mockRouterAsMock.route).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });
    });

    it('should report hasAgentBusyCheck correctly', () => {
      expect(scheduler.hasAgentBusyCheck()).toBe(false);

      const busyScheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        inputMessageRouter: mockRouter,
        isAgentBusy: () => false,
      });
      expect(busyScheduler.hasAgentBusyCheck()).toBe(true);
    });

    it('should notify user every 3 consecutive agent-busy skips', async () => {
      const isAgentBusy = vi.fn().mockReturnValue(true);
      const sendMsgSpy = vi.fn().mockResolvedValue(undefined);
      const busyScheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: { sendMessage: sendMsgSpy },
        inputMessageRouter: mockRouter,
        isAgentBusy,
      });

      const task = createTask({ id: 'skip-notify', blocking: true });
      busyScheduler.addTask(task);

      // Trigger 3 consecutive skips
      for (let i = 0; i < 3; i++) {
        const jobs = busyScheduler.getActiveJobs();
        void jobs[0].job.fireOnTick();
        await vi.waitFor(() => {
          expect(isAgentBusy).toHaveBeenCalledTimes(i + 1);
        }, { timeout: 2000 });
      }

      // Should have sent notification on the 3rd skip
      expect(sendMsgSpy).toHaveBeenCalledTimes(1);
      expect(sendMsgSpy).toHaveBeenCalledWith(
        'oc_test',
        expect.stringContaining('已连续 3 次')
      );
    });

    it('should reset skip counter when task executes successfully', async () => {
      let busy = true;
      const isAgentBusy = vi.fn(() => busy);
      const sendMsgSpy = vi.fn().mockResolvedValue(undefined);
      const busyScheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: { sendMessage: sendMsgSpy },
        inputMessageRouter: mockRouter,
        isAgentBusy,
      });

      const task = createTask({ id: 'reset-counter', blocking: true });
      busyScheduler.addTask(task);

      // Skip twice (below notification threshold)
      for (let i = 0; i < 2; i++) {
        const jobs = busyScheduler.getActiveJobs();
        void jobs[0].job.fireOnTick();
        await vi.waitFor(() => {
          expect(isAgentBusy).toHaveBeenCalledTimes(i + 1);
        }, { timeout: 2000 });
      }

      // No skip notification yet (threshold is 3)
      const skipNotifications = sendMsgSpy.mock.calls.filter(
        (call: string[]) => call[1]?.includes('已连续')
      );
      expect(skipNotifications).toHaveLength(0);

      // Agent becomes idle — task executes, counter resets
      busy = false;
      const jobs = busyScheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();
      await vi.waitFor(() => {
        expect(mockRouterAsMock.route).toHaveBeenCalled();
      }, { timeout: 2000 });

      // Agent becomes busy again — skip count should restart from 1, not 3
      busy = true;
      mockRouterAsMock.route.mockClear();
      isAgentBusy.mockClear();
      const jobs2 = busyScheduler.getActiveJobs();
      void jobs2[0].job.fireOnTick();
      await vi.waitFor(() => {
        expect(isAgentBusy).toHaveBeenCalled();
      }, { timeout: 2000 });

      // Still no skip notification because counter was reset (only 1 new skip)
      const skipNotificationsAfter = sendMsgSpy.mock.calls.filter(
        (call: string[]) => call[1]?.includes('已连续')
      );
      expect(skipNotificationsAfter).toHaveLength(0);
    });
  });
});
