/**
 * Tests for Scheduler.
 *
 * Verifies cron-based task execution via InputMessageRouter,
 * cooldown handling, blocking mechanism, and lifecycle management.
 *
 * Issue #1617: Phase 2 - scheduling module test coverage.
 * Issue #3901: All tests use InputMessageRouter.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { CronJob } from 'cron';
import { Scheduler, TaskTimeoutError, type SchedulerCallbacks } from './scheduler.js';
import { TurnSupersededError } from '../messaging/turn-superseded-error.js';
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

/**
 * Issue #4218 part 2: job factory for deterministic tests. Creates a real
 * CronJob with `start: false` — cron expressions are still validated (the
 * constructor throws on invalid), but NO real OS timer is scheduled, so no
 * `setTimeout` leaks across tests. Tests drive execution manually via
 * `job.fireOnTick()` (as they already do). Production is unaffected (no
 * factory = real, auto-started CronJob).
 */
const testJobFactory = (
  cron: string,
  onTick: () => void,
  timezone: string,
) => new CronJob(cron, onTick, null, false, timezone);

/**
 * Issue #4394 (part 3): deterministic event-loop drain, replacing fixed
 * `await new Promise(r => setTimeout(r, N))` wall-clock waits.
 *
 * Why this is safe for the "tick should have been SKIPPED" assertions below:
 * `executeTask` makes every skip decision (blocking-already-running,
 * same-chatId blocking, isChatBusy) SYNCHRONOUSLY, before its first `await`
 * (`scheduleManager.get`, whose mock resolves on the microtask queue), and the
 * route mock also resolves on the microtask queue. A few `setImmediate`
 * (macrotask) boundaries therefore let all pending microtasks settle —
 * including any `route` call from a tick that was NOT skipped. So after this
 * resolves, a regression that routes a meant-to-be-skipped tick is already
 * observable (the assertion fails), with no fixed ms wait and no load sensitivity.
 * For assertions that expect a route to LAND, prefer `vi.waitFor` instead.
 */
const flushPending = async (rounds = 4) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

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
      // Issue #3929: Default get() returns a dummy task so stale-file detection
      // does not skip execution in existing tests. Override per-test when needed.
      get: vi.fn().mockResolvedValue(createTask()),
      listByChatId: vi.fn().mockResolvedValue([]),
      getFileScanner: vi.fn(),
    } as unknown as ScheduleManager;

    mockCallbacks = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      resetAgent: vi.fn(),
    };

    mockRouter = createMockRouter();
    mockRouterAsMock = mockRouter as unknown as MockRouter;

    scheduler = new Scheduler({
      scheduleManager: mockScheduleManager,
      callbacks: mockCallbacks,
      inputMessageRouter: mockRouter,
      jobFactory: testJobFactory,
    });
  });

  // Issue #4394 (part 2): "有 start 必有 stop" — several tests below call
  // `scheduler.start()` but not every path stops before the test ends. Stop()
  // is idempotent (the "stop without starting" test above resolves undefined),
  // so a defensive afterEach teardown guarantees no started scheduler leaks
  // across tests even when a test forgets to stop. testJobFactory (#4218)
  // already avoids real CronJob timers, but this closes the hygiene gap for any
  // future start()-side-effect (watchers, drains) without changing behavior.
  //
  // stop(0) skips the graceful drain deliberately: three tests below leave an
  // intentionally never-completing task (`new Promise(() => {})`) on this shared
  // scheduler, and the default 5000ms drain would block the full timeout on each
  // during cleanup (~15s added, 18s vs 3s for the file). Drain semantics are
  // already asserted by those tests' own explicit `stop()` calls, so cleanup
  // only needs to stop timers + clear state — keeping it instant.
  afterEach(async () => {
    await scheduler.stop(0).catch(() => {
      /* defensive teardown — never fail a test from cleanup */
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
        jobFactory: testJobFactory,
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

      // Start a task execution the test resolves on demand. Issue #4394
      // (part 25): this used to be a real 200ms wall-clock setTimeout, making
      // the drain wait load-sensitive on a busy CI host. A deferred promise
      // keeps exactly the semantics the test asserts — task still running
      // while stop() pends, stop() resolves once the task completes — with
      // the test controlling the completion instant and zero real timers.
      let finishExecution!: () => void;
      mockRouterAsMock.route.mockImplementationOnce(
        () => new Promise<void>(resolve => { finishExecution = resolve; }),
      );

      // Fire the cron job to start execution
      const jobs = scheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();

      // Wait for execution to start. Waiting on the route CALL (not just
      // isTaskRunning) is what synchronizes `finishExecution` being assigned:
      // executeTask marks the task running before its first await, then only
      // reaches route() after the get/sendMessage microtasks settle.
      await vi.waitFor(() => {
        expect(scheduler.isTaskRunning('graceful-stop-1')).toBe(true);
        expect(mockRouterAsMock.route).toHaveBeenCalledTimes(1);
      }, { timeout: 1000 });

      // Stop should wait for the running task to complete
      const stopPromise = scheduler.stop(2000);

      // Task should still be tracked as running immediately after stop() call
      expect(scheduler.isRunning()).toBe(false);
      expect(scheduler.getActiveJobs()).toHaveLength(0);

      // Let the in-flight execution complete; stop() should then resolve
      // without hitting its 2000ms grace timeout.
      finishExecution();
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
        jobFactory: testJobFactory,
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

  describe('jobFactory (Issue #4218: DI for deterministic tests)', () => {
    it('uses the injected factory instead of a real CronJob (no OS timer)', async () => {
      const created: Array<{ cron: string; onTick: () => void | Promise<void>; timezone: string }> = [];
      const stop = vi.fn();
      const fireOnTick = vi.fn();
      const jobFactory = (
        cron: string,
        onTick: () => void | Promise<void>,
        timezone: string,
      ) => {
        created.push({ cron, onTick, timezone });
        return { fireOnTick, stop };
      };

      const s = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        inputMessageRouter: mockRouter,
        jobFactory,
      });

      const task = createTask({ id: 'di-1', cron: '*/5 * * * *', timezone: 'Asia/Shanghai' });
      s.addTask(task);

      // Factory invoked once with the task's cron + timezone; the fake job is stored.
      expect(created).toHaveLength(1);
      expect(created[0].cron).toBe('*/5 * * * *');
      expect(created[0].timezone).toBe('Asia/Shanghai');
      const jobs = s.getActiveJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].job.fireOnTick).toBe(fireOnTick);

      // Driving onTick manually executes the task (routes via InputMessageRouter)
      // without any real wall-clock timer needing to advance. Awaited because the
      // real onTick is async (`() => this.executeTask(task)` → Promise<void>).
      await created[0].onTick();
      await vi.waitFor(() => expect(mockRouterAsMock.route).toHaveBeenCalledTimes(1));

      // removeTask tears the fake job down via stop().
      s.removeTask('di-1');
      expect(stop).toHaveBeenCalledTimes(1);
      expect(s.getActiveJobs()).toHaveLength(0);
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

    it('should call resetAgent before the start message when task.clearContext is true (#4206)', async () => {
      const task = createTask({ id: 'clear-ctx-1', clearContext: true });
      scheduler.addTask(task);
      const jobs = scheduler.getActiveJobs();

      fireJob(jobs);
      await vi.waitFor(() => {
        expect(mockRouterAsMock.route).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      // resetAgent was called once with the chat's id and skipContext=true…
      expect(mockCallbacks.resetAgent).toHaveBeenCalledTimes(1);
      expect(mockCallbacks.resetAgent).toHaveBeenCalledWith('oc_test', true);
      // …and it happened BEFORE the start-notification sendMessage.
      const resetAgent = mockCallbacks.resetAgent!;
      const [resetOrder] = vi.mocked(resetAgent).mock.invocationCallOrder;
      const sendCalls = vi.mocked(mockCallbacks.sendMessage).mock.calls;
      const sendOrders = vi.mocked(mockCallbacks.sendMessage).mock.invocationCallOrder;
      const startIdx = sendCalls.findIndex(c => (c[1] as string)?.includes('开始执行'));
      expect(startIdx).toBeGreaterThanOrEqual(0);
      const startOrder = sendOrders[startIdx];
      expect(resetOrder).toBeDefined();
      expect(startOrder).toBeDefined();
      expect(resetOrder!).toBeLessThan(startOrder!);
    });

    it('should NOT call resetAgent when clearContext is unset (#4206)', async () => {
      const task = createTask({ id: 'no-clear-ctx' });
      scheduler.addTask(task);
      const jobs = scheduler.getActiveJobs();

      fireJob(jobs);
      await vi.waitFor(() => {
        expect(mockRouterAsMock.route).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      expect(mockCallbacks.resetAgent).not.toHaveBeenCalled();
    });

    it('should clear the skip-history flag via resetAgent(chatId, false) when a clearContext task fails (#4206 nit)', async () => {
      const task = createTask({ id: 'clear-ctx-fail', clearContext: true });
      scheduler.addTask(task);
      const jobs = scheduler.getActiveJobs();

      // Route rejects → the task fails and lands in the catch path.
      mockRouterAsMock.route.mockRejectedValueOnce(new Error('route boom'));

      fireJob(jobs);
      await vi.waitFor(() => {
        expect(mockCallbacks.sendMessage).toHaveBeenCalledWith(
          'oc_test',
          expect.stringContaining('执行失败'),
        );
      }, { timeout: 2000 });

      // resetAgent called twice: first (chatId, true) before route, then
      // (chatId, false) in the catch to clear the leaked skip-history flag so
      // it doesn't drop history from the next unrelated message.
      expect(mockCallbacks.resetAgent).toHaveBeenCalledTimes(2);
      expect(mockCallbacks.resetAgent).toHaveBeenNthCalledWith(1, 'oc_test', true);
      expect(mockCallbacks.resetAgent).toHaveBeenNthCalledWith(2, 'oc_test', false);
    });

    it('should NOT clear context when clearContext task fails but clearContext was unset (#4206 nit)', async () => {
      const task = createTask({ id: 'no-clear-fail' }); // clearContext unset
      scheduler.addTask(task);
      const jobs = scheduler.getActiveJobs();

      mockRouterAsMock.route.mockRejectedValueOnce(new Error('route boom'));

      fireJob(jobs);
      await vi.waitFor(() => {
        expect(mockCallbacks.sendMessage).toHaveBeenCalledWith(
          'oc_test',
          expect.stringContaining('执行失败'),
        );
      }, { timeout: 2000 });

      // No clearContext → no resetAgent at all (neither before route nor in catch).
      expect(mockCallbacks.resetAgent).not.toHaveBeenCalled();
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
        jobFactory: testJobFactory,
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

    describe('Issue #4648: completion status hooks the turn\'s real outcome', () => {
      /** Helper: fire the job and wait until its ❌ failure notification landed. */
      async function fireAndExpectFailure() {
        fireJob(scheduler.getActiveJobs());
        await vi.waitFor(() => {
          expect(mockCallbacks.sendMessage).toHaveBeenCalledWith(
            'oc_test',
            expect.stringContaining('执行失败'),
          );
        }, { timeout: 2000 });
      }

      it('routes the scheduled SystemMessage with waitForCompletion: true', async () => {
        // The core fix: without this flag route() resolved the moment
        // processMessage QUEUED the prompt, so "completed" was logged before
        // the agent did any work (see the 38-day #4626 incident).
        const task = createTask({ id: 'wait-1' });
        scheduler.addTask(task);

        fireJob(scheduler.getActiveJobs());
        await vi.waitFor(() => {
          expect(mockRouterAsMock.route).toHaveBeenCalledTimes(1);
        }, { timeout: 2000 });

        expect(getRoutedMessage().waitForCompletion).toBe(true);
      });

      it('counts consecutive failures per task and resets the streak on success', async () => {
        const task = createTask({ id: 'streak-1' });
        scheduler.addTask(task);
        const counters = (scheduler as unknown as {
          consecutiveTaskFailures: Map<string, number>;
        }).consecutiveTaskFailures;

        // Persistent rejection as the mock default; the success run below
        // overrides it once.
        mockRouterAsMock.route.mockRejectedValue(new Error('turn died'));

        await fireAndExpectFailure();
        expect(counters.get('streak-1')).toBe(1);
        // Reset the call count so the next failure notification is
        // distinguishable (waitFor on the count, not just any-call).
        vi.mocked(mockCallbacks.sendMessage).mockClear();

        await fireAndExpectFailure();
        expect(counters.get('streak-1')).toBe(2);
        vi.mocked(mockCallbacks.sendMessage).mockClear();

        // Third failure crosses the alert threshold (CONSECUTIVE_FAILURE_
        // ALERT_THRESHOLD = 3) — asserted via the counter the threshold
        // reads from.
        await fireAndExpectFailure();
        expect(counters.get('streak-1')).toBe(3);
        vi.mocked(mockCallbacks.sendMessage).mockClear();

        // A healthy run wipes the streak entirely (map delete, not 0), so a
        // later failure starts counting from 1 again.
        mockRouterAsMock.route.mockResolvedValueOnce(undefined);
        fireJob(scheduler.getActiveJobs());
        await vi.waitFor(() => {
          expect(scheduler.isTaskRunning('streak-1')).toBe(false);
        }, { timeout: 2000 });
        expect(counters.has('streak-1')).toBe(false);
      });

      it('timeout notification is honest about the turn still running in the background', async () => {
        // With waitForCompletion the timeout now bounds the agent TURN, not
        // just routing — and the abandoned await does not cancel the agent.
        // The old wording claimed 已自动终止 (terminated), which was never
        // true and matters more now.
        mockRouterAsMock.route.mockReturnValueOnce(new Promise(() => {}));

        const task = createTask({ id: 'timeout-wording', timeoutMs: 50 });
        scheduler.addTask(task);

        fireJob(scheduler.getActiveJobs());

        await vi.waitFor(() => {
          expect(mockCallbacks.sendMessage).toHaveBeenCalledWith(
            'oc_test',
            expect.stringContaining('可能仍在后台继续'),
          );
        }, { timeout: 3000 });
      });
    });

    describe('Issue #4649 (review ①②): superseded turns and timeouts are neutral, not failures', () => {
      /** Typed view of the scheduler's private streak map (same trick as the #4648 tests above). */
      function streakMap(): Map<string, number> {
        return (scheduler as unknown as {
          consecutiveTaskFailures: Map<string, number>;
        }).consecutiveTaskFailures;
      }

      it('superseded turn: no ❌ notification and streak untouched (①)', async () => {
        // The interjection shape: a user message lands in the chat while the
        // scheduled turn is still running, so the turn promise rejects with
        // TurnSupersededError. That is alive-chat concurrency — treating it
        // as failure spammed ❌ into every busy group chat.
        const task = createTask({ id: 'superseded-1' });
        scheduler.addTask(task);

        mockRouterAsMock.route.mockRejectedValueOnce(new TurnSupersededError());
        fireJob(scheduler.getActiveJobs());
        await vi.waitFor(() => {
          expect(scheduler.isTaskRunning('superseded-1')).toBe(false);
        }, { timeout: 2000 });

        // Only the ⏰ start notification may exist — never a failure notice.
        for (const call of vi.mocked(mockCallbacks.sendMessage).mock.calls) {
          expect(String(call[1])).not.toContain('执行失败');
        }
        expect(streakMap().has('superseded-1')).toBe(false);

        // The superseded run neither incremented nor reset the streak: the
        // next REAL failure counts as 1.
        mockRouterAsMock.route.mockRejectedValueOnce(new Error('turn died'));
        vi.mocked(mockCallbacks.sendMessage).mockClear();
        fireJob(scheduler.getActiveJobs());
        await vi.waitFor(() => {
          expect(mockCallbacks.sendMessage).toHaveBeenCalledWith(
            'oc_test',
            expect.stringContaining('执行失败'),
          );
        }, { timeout: 2000 });
        expect(streakMap().get('superseded-1')).toBe(1);
      });

      it('superseded run does not reset an existing failure streak (①)', async () => {
        // Neutral ≠ reset: two real failures, one superseded run, then a
        // real failure → the streak reflects the three REAL failures, so a
        // supersession cannot mask chronic breakage.
        const task = createTask({ id: 'streak-neutral' });
        scheduler.addTask(task);
        mockRouterAsMock.route.mockRejectedValue(new Error('turn died'));

        fireJob(scheduler.getActiveJobs());
        await vi.waitFor(() => expect(streakMap().get('streak-neutral')).toBe(1), { timeout: 2000 });
        fireJob(scheduler.getActiveJobs());
        await vi.waitFor(() => expect(streakMap().get('streak-neutral')).toBe(2), { timeout: 2000 });

        mockRouterAsMock.route.mockRejectedValueOnce(new TurnSupersededError());
        fireJob(scheduler.getActiveJobs());
        await vi.waitFor(() => {
          expect(scheduler.isTaskRunning('streak-neutral')).toBe(false);
        }, { timeout: 2000 });
        expect(streakMap().get('streak-neutral')).toBe(2);

        fireJob(scheduler.getActiveJobs());
        await vi.waitFor(() => expect(streakMap().get('streak-neutral')).toBe(3), { timeout: 2000 });
      });

      it('timeout: outcome unknown — not counted toward the streak, notification teaches timeoutMs (②)', async () => {
        // The timeout bounds the WAIT; the turn is not cancelled and may
        // still finish. Counting it as failure made every legitimately-long
        // task a guaranteed ❌ and eventually a false chronic-failure alert.
        const task = createTask({ id: 'timeout-neutral', timeoutMs: 50 });
        scheduler.addTask(task);

        mockRouterAsMock.route.mockReturnValueOnce(new Promise(() => {})); // turn never settles
        fireJob(scheduler.getActiveJobs());
        await vi.waitFor(() => {
          expect(mockCallbacks.sendMessage).toHaveBeenCalledWith(
            'oc_test',
            expect.stringContaining('已停止等待'),
          );
        }, { timeout: 3000 });
        expect(mockCallbacks.sendMessage).toHaveBeenCalledWith(
          'oc_test',
          expect.stringContaining('timeoutMs'),
        );
        expect(streakMap().has('timeout-neutral')).toBe(false);

        // …and the timeout didn't mask real failures either: the next real
        // error counts as 1, not 2.
        mockRouterAsMock.route.mockRejectedValueOnce(new Error('turn died'));
        vi.mocked(mockCallbacks.sendMessage).mockClear();
        fireJob(scheduler.getActiveJobs());
        await vi.waitFor(() => {
          expect(mockCallbacks.sendMessage).toHaveBeenCalledWith(
            'oc_test',
            expect.stringContaining('执行失败'),
          );
        }, { timeout: 2000 });
        expect(streakMap().get('timeout-neutral')).toBe(1);
      });

      it('default timeout is 2 hours — above the pool busy-turn cap so stuck turns stay countable (②)', async () => {
        // DEFAULT_TASK_TIMEOUT_MS is deliberately larger than the agent
        // pool's 90-min busy-turn hard cap (#4577): a genuinely stuck turn
        // is killed by the pool cap and lands in the catch as a REAL
        // (countable) error before this timeout fires. Pin the default so a
        // future "just lower it" tweak can't silently re-break that order.
        vi.useFakeTimers();
        try {
          const task = createTask({ id: 'timeout-default-2h' }); // no timeoutMs
          scheduler.addTask(task);
          mockRouterAsMock.route.mockReturnValueOnce(new Promise(() => {}));

          fireJob(scheduler.getActiveJobs());
          await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 - 1);
          expect(scheduler.isTaskRunning('timeout-default-2h')).toBe(true);

          await vi.advanceTimersByTimeAsync(1);
          // (No flushPending() here: it parks on setImmediate, which fake
          // timers freeze — advanceTimersByTimeAsync already drains the
          // microtask chain the catch path needs.)
          expect(scheduler.isTaskRunning('timeout-default-2h')).toBe(false);
          expect(mockCallbacks.sendMessage).toHaveBeenCalledWith(
            'oc_test',
            expect.stringContaining('120分钟'), // formatTimeout(2h) renders in minutes
          );
          expect(streakMap().has('timeout-default-2h')).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    describe('Issue #4649 (review ④): clearContext cleanup never disposes a possibly-live turn', () => {
      // The catch's contextCleared cleanup calls resetAgent(chatId, false),
      // which disposes the agent and aborts any running turn. The two
      // "the turn may still be running" outcomes — superseded and timeout —
      // must skip it; only genuinely-dead-session errors reach the cleanup.
      it('superseded outcome skips the contextCleared cleanup', async () => {
        const task = createTask({ id: 'clear-skip-superseded', clearContext: true });
        scheduler.addTask(task);

        mockRouterAsMock.route.mockRejectedValueOnce(new TurnSupersededError());
        fireJob(scheduler.getActiveJobs());
        await vi.waitFor(() => {
          expect(scheduler.isTaskRunning('clear-skip-superseded')).toBe(false);
        }, { timeout: 2000 });

        // resetAgent was called exactly once — the pre-turn clearContext
        // reset (chatId, true). The (chatId, false) cleanup never ran.
        expect(mockCallbacks.resetAgent).toHaveBeenCalledTimes(1);
        expect(mockCallbacks.resetAgent).toHaveBeenCalledWith('oc_test', true);
        expect(mockCallbacks.resetAgent).not.toHaveBeenCalledWith('oc_test', false);
      });

      it('timeout outcome skips the contextCleared cleanup', async () => {
        const task = createTask({ id: 'clear-skip-timeout', clearContext: true, timeoutMs: 50 });
        scheduler.addTask(task);

        mockRouterAsMock.route.mockReturnValueOnce(new Promise(() => {})); // turn never settles
        fireJob(scheduler.getActiveJobs());
        await vi.waitFor(() => {
          expect(scheduler.isTaskRunning('clear-skip-timeout')).toBe(false);
        }, { timeout: 3000 });

        expect(mockCallbacks.resetAgent).toHaveBeenCalledTimes(1);
        expect(mockCallbacks.resetAgent).not.toHaveBeenCalledWith('oc_test', false);
      });
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
        jobFactory: testJobFactory,
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
        jobFactory: testJobFactory,
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
        jobFactory: testJobFactory,
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
        jobFactory: testJobFactory,
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
      // Deterministic drain instead of a fixed 100ms wait (Issue #4394 part 3).
      await flushPending();

      // Router should only be called once (second trigger was skipped)
      expect(mockRouterAsMock.route).toHaveBeenCalledTimes(1);
    });

    it('should allow execution when blocking=false even if previous still running', async () => {
      // Issue #4394 (part 25): this used `new Promise(r => setTimeout(r, 200))`
      // for every route call, but the test only asserts that both executions
      // are *initiated* (route called twice) — it never awaits completion, so
      // the two real timers just leaked past the test boundary. A
      // never-resolving promise provides the same "previous still running"
      // state with zero real timers; the shared afterEach teardown uses
      // stop(0), which skips the drain and so is not blocked by it.
      mockRouterAsMock.route.mockImplementation(() => new Promise<void>(() => {}));

      const task = createTask({ id: 'non-blocking', blocking: false });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();

      void jobs[0].job.fireOnTick();
      await vi.waitFor(() => {
        expect(scheduler.isTaskRunning('non-blocking')).toBe(true);
      }, { timeout: 2000 });

      // Second trigger while running - should start since blocking=false
      void jobs[0].job.fireOnTick();

      // Both executions should have been initiated. The second route lands
      // after executeTask's first await, so wait for it deterministically
      // instead of a fixed 100ms wall-clock wait (Issue #4394 part 3).
      await vi.waitFor(() => {
        expect(mockRouterAsMock.route).toHaveBeenCalledTimes(2);
      }, { timeout: 1000 });
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

  describe('executeTask busy-chat gate (Issue #4199)', () => {
    it('should skip a blocking task when its chat is busy', async () => {
      mockRouterAsMock.route.mockResolvedValue(undefined);
      const busyScheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: { ...mockCallbacks, isChatBusy: (chatId: string) => chatId === 'oc_busy' },
        inputMessageRouter: mockRouter,
        jobFactory: testJobFactory,
      });
      busyScheduler.addTask(createTask({ id: 'blocking-busy', blocking: true, chatId: 'oc_busy' }));

      void busyScheduler.getActiveJobs()[0].job.fireOnTick();
      // Deterministic drain instead of a fixed 100ms wait (Issue #4394 part 3):
      // the busy-skip is decided synchronously, so a would-be route would have
      // fired by here if the gate had failed.
      await flushPending();

      // Skipped this tick because the chat is busy
      expect(mockRouterAsMock.route).not.toHaveBeenCalled();
    });

    it('should execute a blocking task when its chat is not busy', async () => {
      mockRouterAsMock.route.mockResolvedValueOnce(undefined);
      const busyScheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: { ...mockCallbacks, isChatBusy: (chatId: string) => chatId === 'oc_busy' },
        inputMessageRouter: mockRouter,
        jobFactory: testJobFactory,
      });
      busyScheduler.addTask(createTask({ id: 'blocking-idle', blocking: true, chatId: 'oc_other' }));

      void busyScheduler.getActiveJobs()[0].job.fireOnTick();
      await vi.waitFor(() => {
        expect(mockRouterAsMock.route).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });
    });

    it('should execute a non-blocking task even when its chat is busy', async () => {
      mockRouterAsMock.route.mockResolvedValueOnce(undefined);
      const busyScheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: { ...mockCallbacks, isChatBusy: () => true },
        inputMessageRouter: mockRouter,
        jobFactory: testJobFactory,
      });
      busyScheduler.addTask(createTask({ id: 'nonblocking-busy', blocking: false, chatId: 'oc_busy' }));

      void busyScheduler.getActiveJobs()[0].job.fireOnTick();
      await vi.waitFor(() => {
        expect(mockRouterAsMock.route).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });
    });

    it('should not gate when no isChatBusy callback is wired (unchanged behavior)', async () => {
      mockRouterAsMock.route.mockResolvedValueOnce(undefined);
      // beforeEach `scheduler` uses mockCallbacks (no isChatBusy)
      scheduler.addTask(createTask({ id: 'blocking-no-cb', blocking: true, chatId: 'oc_test' }));

      void scheduler.getActiveJobs()[0].job.fireOnTick();
      await vi.waitFor(() => {
        expect(mockRouterAsMock.route).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });
    });
  });

  describe('executeTask stale job detection (Issue #3929)', () => {
    it('should remove cron job and skip execution when schedule file is deleted', async () => {
      // scheduleManager.get() returns undefined = file no longer exists
      vi.mocked(mockScheduleManager.get).mockResolvedValue(undefined);

      const task = createTask({ id: 'stale-1' });
      scheduler.addTask(task);
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      const jobs = scheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();

      // Wait for the stale detection to run
      await vi.waitFor(() => {
        expect(scheduler.getActiveJobs()).toHaveLength(0);
      }, { timeout: 2000 });

      // Router should NOT have been called
      expect(mockRouterAsMock.route).not.toHaveBeenCalled();
      // Task should not be in running state
      expect(scheduler.isTaskRunning('stale-1')).toBe(false);
    });

    it('should execute normally when schedule file still exists', async () => {
      // scheduleManager.get() returns the task = file still exists
      const task = createTask({ id: 'fresh-1' });
      vi.mocked(mockScheduleManager.get).mockResolvedValue(task);

      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();

      await vi.waitFor(() => {
        expect(mockRouterAsMock.route).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      // Job should still be active
      expect(scheduler.getActiveJobs()).toHaveLength(1);
    });

    it('should remove cron job and clean up when scheduleManager.get() throws', async () => {
      // scheduleManager.get() throws (e.g., disk I/O error)
      vi.mocked(mockScheduleManager.get).mockRejectedValue(new Error('EIO: i/o error'));

      const task = createTask({ id: 'error-1' });
      scheduler.addTask(task);
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      const jobs = scheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();

      // Wait for the error handling to complete
      await vi.waitFor(() => {
        expect(scheduler.getActiveJobs()).toHaveLength(0);
      }, { timeout: 2000 });

      // Router should NOT have been called
      expect(mockRouterAsMock.route).not.toHaveBeenCalled();
      // Task should not be in running state
      expect(scheduler.isTaskRunning('error-1')).toBe(false);
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

    it('should use default timeout when task has no timeoutMs', async () => {
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
        jobFactory: testJobFactory,
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

  describe('executeTask agent busy check (Issue #3931, #4102)', () => {
    it('should skip blocking task when another blocking task is running for same chatId', async () => {
      const blockScheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        inputMessageRouter: mockRouter,
        jobFactory: testJobFactory,
      });

      // Use a task that hangs on route to keep it "running"
      const hangingRoute: Promise<void> = new Promise(() => {}); // never resolves
      mockRouterAsMock.route.mockReturnValueOnce(hangingRoute);

      const task1 = createTask({ id: 'block-running', blocking: true });
      const task2 = createTask({ id: 'block-skip', blocking: true });
      blockScheduler.addTask(task1);
      blockScheduler.addTask(task2);

      // Fire task1 first
      const jobs = blockScheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();

      // Wait for task1 to start running
      await vi.waitFor(() => {
        expect(blockScheduler.isTaskRunning('block-running')).toBe(true);
      }, { timeout: 2000 });

      // Fire task2 — should be skipped because task1 is blocking and same chatId
      void jobs[1].job.fireOnTick();

      // Deterministic drain instead of a fixed 200ms wait (Issue #4394 part 3):
      // the same-chatId blocking skip is decided synchronously in executeTask.
      await flushPending();

      // Task2 should not have been routed
      expect(mockRouterAsMock.route).toHaveBeenCalledTimes(1);
      expect(blockScheduler.isTaskRunning('block-skip')).toBe(false);
    });

    it('should execute blocking task when no other blocking task is running', async () => {
      const task = createTask({ id: 'idle-1', blocking: true });
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      void jobs[0].job.fireOnTick();

      await vi.waitFor(() => {
        expect(mockRouterAsMock.route).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });
    });

    it('should not skip non-blocking tasks even when blocking task is running', async () => {
      const blockScheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        inputMessageRouter: mockRouter,
        jobFactory: testJobFactory,
      });

      // Make route hang for the first call (blocking task)
      const hangingRoute: Promise<void> = new Promise(() => {}); // never resolves
      mockRouterAsMock.route.mockReturnValueOnce(hangingRoute);

      const blockTask = createTask({ id: 'block-1', blocking: true });
      const nonBlockTask = createTask({ id: 'nonblock-1', blocking: false });
      blockScheduler.addTask(blockTask);
      blockScheduler.addTask(nonBlockTask);

      const jobs = blockScheduler.getActiveJobs();
      // Fire blocking task first
      void jobs[0].job.fireOnTick();

      await vi.waitFor(() => {
        expect(blockScheduler.isTaskRunning('block-1')).toBe(true);
      }, { timeout: 2000 });

      // Fire non-blocking task — should still execute
      void jobs[1].job.fireOnTick();

      await vi.waitFor(() => {
        expect(mockRouterAsMock.route).toHaveBeenCalledTimes(2);
      }, { timeout: 2000 });
    });
  });
});
