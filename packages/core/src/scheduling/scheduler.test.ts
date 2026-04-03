/**
 * Unit tests for Scheduler
 *
 * Tests the Scheduler class which manages cron-based task execution:
 * - Lifecycle: start/stop/reload
 * - Task scheduling: add/remove tasks with cron expressions
 * - Task execution: cooldown, blocking, error handling
 * - Anti-recursion prompt wrapping
 * - Running task tracking
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger before importing Scheduler
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock CooldownManager
vi.mock('./cooldown-manager.js', () => ({
  CooldownManager: vi.fn().mockImplementation(() => ({
    isInCooldown: vi.fn().mockResolvedValue(false),
    getCooldownStatus: vi.fn().mockResolvedValue({
      isInCooldown: false,
      lastExecutionTime: null,
      cooldownEndsAt: null,
      remainingMs: 0,
    }),
    recordExecution: vi.fn().mockResolvedValue(undefined),
    clearCooldown: vi.fn().mockResolvedValue(true),
  })),
}));

import { Scheduler, type SchedulerCallbacks, type TaskExecutor } from './scheduler.js';
import type { ScheduledTask } from './scheduled-task.js';
import { CooldownManager } from './cooldown-manager.js';

// ============================================================================
// Helpers
// ============================================================================

function createMockScheduleManager() {
  return {
    listEnabled: vi.fn().mockResolvedValue([]),
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

function createMockTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    name: 'Test Task',
    cron: '* * * * *',
    prompt: 'Do something',
    chatId: 'oc_test',
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ============================================================================
// Scheduler Tests
// ============================================================================

describe('Scheduler', () => {
  let scheduler: Scheduler;
  let mockScheduleManager: ReturnType<typeof createMockScheduleManager>;
  let mockCallbacks: SchedulerCallbacks;
  let mockExecutor: TaskExecutor;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockScheduleManager = createMockScheduleManager();
    mockCallbacks = createMockCallbacks();
    mockExecutor = createMockExecutor();

    scheduler = new Scheduler({
      scheduleManager: mockScheduleManager,
      callbacks: mockCallbacks,
      executor: mockExecutor,
    });
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create a Scheduler with required options', () => {
      expect(scheduler).toBeDefined();
      expect(scheduler.isRunning()).toBe(false);
    });

    it('should create a Scheduler with optional cooldownManager', () => {
      const mockCooldownManager = new CooldownManager({ cooldownDir: '/tmp/test' });
      const s = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        executor: mockExecutor,
        cooldownManager: mockCooldownManager,
      });
      expect(s).toBeDefined();
      expect(s.isRunning()).toBe(false);
    });
  });

  describe('start', () => {
    it('should start and load all enabled tasks', async () => {
      const task = createMockTask();
      mockScheduleManager.listEnabled.mockResolvedValue([task]);

      await scheduler.start();

      expect(scheduler.isRunning()).toBe(true);
      expect(mockScheduleManager.listEnabled).toHaveBeenCalledOnce();
      expect(scheduler.getActiveJobs()).toHaveLength(1);
    });

    it('should not start if already running', async () => {
      mockScheduleManager.listEnabled.mockResolvedValue([]);

      await scheduler.start();
      await scheduler.start();

      expect(mockScheduleManager.listEnabled).toHaveBeenCalledOnce();
    });

    it('should handle empty task list', async () => {
      mockScheduleManager.listEnabled.mockResolvedValue([]);

      await scheduler.start();

      expect(scheduler.isRunning()).toBe(true);
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should skip disabled tasks when loading', async () => {
      const enabledTask = createMockTask({ id: 'enabled-1', enabled: true });
      const disabledTask = createMockTask({ id: 'disabled-1', enabled: false });
      mockScheduleManager.listEnabled.mockResolvedValue([enabledTask, disabledTask]);

      await scheduler.start();

      // Only the enabled task should be scheduled
      expect(scheduler.getActiveJobs()).toHaveLength(1);
      expect(scheduler.getActiveJobs()[0].taskId).toBe('enabled-1');
    });
  });

  describe('stop', () => {
    it('should stop all active jobs', async () => {
      const task = createMockTask();
      mockScheduleManager.listEnabled.mockResolvedValue([task]);

      await scheduler.start();
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should be safe to call stop when not running', () => {
      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
    });
  });

  describe('addTask', () => {
    it('should add an enabled task and create a cron job', () => {
      const task = createMockTask();
      scheduler.addTask(task);

      expect(scheduler.getActiveJobs()).toHaveLength(1);
      expect(scheduler.getActiveJobs()[0].taskId).toBe('task-1');
    });

    it('should not add a disabled task', () => {
      const task = createMockTask({ enabled: false });
      scheduler.addTask(task);

      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should replace existing task when adding with same ID', () => {
      const task1 = createMockTask({ cron: '0 9 * * *' });
      const task2 = createMockTask({ cron: '0 18 * * *' });

      scheduler.addTask(task1);
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      scheduler.addTask(task2);
      expect(scheduler.getActiveJobs()).toHaveLength(1);
    });

    it('should handle invalid cron expression gracefully', () => {
      const task = createMockTask({ cron: 'invalid-cron' });
      scheduler.addTask(task);

      // Should not throw, just log error and not add
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should add multiple tasks', () => {
      const task1 = createMockTask({ id: 'task-1' });
      const task2 = createMockTask({ id: 'task-2', cron: '0 10 * * *' });
      const task3 = createMockTask({ id: 'task-3', cron: '0 14 * * *' });

      scheduler.addTask(task1);
      scheduler.addTask(task2);
      scheduler.addTask(task3);

      expect(scheduler.getActiveJobs()).toHaveLength(3);
    });
  });

  describe('removeTask', () => {
    it('should remove an existing task', () => {
      const task = createMockTask();
      scheduler.addTask(task);
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      scheduler.removeTask('task-1');
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should be safe to remove non-existent task', () => {
      scheduler.removeTask('non-existent');
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });
  });

  describe('reload', () => {
    it('should reload all tasks from schedule manager', async () => {
      const oldTask = createMockTask({ id: 'old-task' });
      const newTask = createMockTask({ id: 'new-task' });

      mockScheduleManager.listEnabled
        .mockResolvedValueOnce([oldTask])
        .mockResolvedValueOnce([newTask]);

      await scheduler.start();
      expect(scheduler.getActiveJobs()).toHaveLength(1);
      expect(scheduler.getActiveJobs()[0].taskId).toBe('old-task');

      await scheduler.reload();
      expect(scheduler.getActiveJobs()).toHaveLength(1);
      expect(scheduler.getActiveJobs()[0].taskId).toBe('new-task');
    });

    it('should restart running state after reload', async () => {
      mockScheduleManager.listEnabled.mockResolvedValue([]);

      await scheduler.start();
      expect(scheduler.isRunning()).toBe(true);

      await scheduler.reload();
      expect(scheduler.isRunning()).toBe(true);
    });
  });

  describe('isTaskRunning / isAnyTaskRunning / getRunningTaskIds', () => {
    it('should return false when no tasks are running', () => {
      expect(scheduler.isTaskRunning('task-1')).toBe(false);
      expect(scheduler.isAnyTaskRunning()).toBe(false);
      expect(scheduler.getRunningTaskIds()).toEqual([]);
    });
  });

  describe('getActiveJobs', () => {
    it('should return empty array when no jobs', () => {
      expect(scheduler.getActiveJobs()).toEqual([]);
    });

    it('should return active job entries with correct structure', () => {
      const task = createMockTask();
      scheduler.addTask(task);

      const jobs = scheduler.getActiveJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toEqual({
        taskId: 'task-1',
        job: expect.any(Object),
        task: expect.objectContaining({ id: 'task-1' }),
      });
    });
  });

  describe('getCooldownStatus / clearCooldown', () => {
    it('should return null when no cooldownManager', async () => {
      const result = await scheduler.getCooldownStatus('task-1', 60000);
      expect(result).toBeNull();
    });

    it('should return false from clearCooldown when no cooldownManager', async () => {
      const result = await scheduler.clearCooldown('task-1');
      expect(result).toBe(false);
    });

    it('should delegate to cooldownManager when available', async () => {
      const mockCooldownManager = {
        isInCooldown: vi.fn().mockResolvedValue(false),
        getCooldownStatus: vi.fn().mockResolvedValue({
          isInCooldown: true,
          lastExecutionTime: new Date(),
          cooldownEndsAt: new Date(),
          remainingMs: 30000,
        }),
        recordExecution: vi.fn().mockResolvedValue(undefined),
        clearCooldown: vi.fn().mockResolvedValue(true),
      };

      const s = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        executor: mockExecutor,
        cooldownManager: mockCooldownManager,
      });

      const status = await s.getCooldownStatus('task-1', 60000);
      expect(status).not.toBeNull();
      expect(status!.isInCooldown).toBe(true);

      const cleared = await s.clearCooldown('task-1');
      expect(cleared).toBe(true);
    });
  });
});

describe('Scheduler (task execution)', () => {
  let scheduler: Scheduler;
  let mockScheduleManager: ReturnType<typeof createMockScheduleManager>;
  let mockCallbacks: SchedulerCallbacks;
  let mockExecutor: TaskExecutor;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockScheduleManager = createMockScheduleManager();
    mockCallbacks = createMockCallbacks();
    mockExecutor = createMockExecutor();
  });

  afterEach(() => {
    if (scheduler) scheduler.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should execute task via executor with anti-recursion wrapped prompt', async () => {
    const task = createMockTask();
    scheduler = new Scheduler({
      scheduleManager: mockScheduleManager,
      callbacks: mockCallbacks,
      executor: mockExecutor,
    });

    scheduler.addTask(task);

    // Execute the task (simulate cron trigger)
    // We need to trigger the cron callback
    const jobs = scheduler.getActiveJobs();
    expect(jobs).toHaveLength(1);

    // Wait for cron to fire by advancing time
    await vi.advanceTimersByTimeAsync(61000);

    // The executor should have been called with the wrapped prompt
    expect(mockExecutor).toHaveBeenCalled();
    const calledPrompt = mockExecutor.mock.calls[0][1];
    expect(calledPrompt).toContain('Scheduled Task Execution Context');
    expect(calledPrompt).toContain('Do NOT create new scheduled tasks');
    expect(calledPrompt).toContain('Do something');
  });

  it('should send start notification before execution', async () => {
    const task = createMockTask();
    scheduler = new Scheduler({
      scheduleManager: mockScheduleManager,
      callbacks: mockCallbacks,
      executor: mockExecutor,
    });

    scheduler.addTask(task);
    await vi.advanceTimersByTimeAsync(61000);

    // Should have sent start notification
    const sendMessageCalls = mockCallbacks.sendMessage.mock.calls;
    const startCall = sendMessageCalls.find(
      (call: any[]) => call[1].includes('开始执行')
    );
    expect(startCall).toBeDefined();
    expect(startCall![0]).toBe('oc_test');
  });

  it('should pass createdBy and model to executor', async () => {
    const task = createMockTask({
      createdBy: 'user_123',
      model: 'claude-sonnet-4-20250514',
    });
    scheduler = new Scheduler({
      scheduleManager: mockScheduleManager,
      callbacks: mockCallbacks,
      executor: mockExecutor,
    });

    scheduler.addTask(task);
    await vi.advanceTimersByTimeAsync(61000);

    expect(mockExecutor).toHaveBeenCalledWith(
      'oc_test',
      expect.any(String),
      'user_123',
      'claude-sonnet-4-20250514'
    );
  });

  it('should send error notification when executor throws', async () => {
    const task = createMockTask();
    mockExecutor.mockRejectedValue(new Error('Execution failed'));

    scheduler = new Scheduler({
      scheduleManager: mockScheduleManager,
      callbacks: mockCallbacks,
      executor: mockExecutor,
    });

    scheduler.addTask(task);
    await vi.advanceTimersByTimeAsync(61000);

    // Should have sent error notification
    const sendMessageCalls = mockCallbacks.sendMessage.mock.calls;
    const errorCall = sendMessageCalls.find(
      (call: any[]) => call[1].includes('执行失败')
    );
    expect(errorCall).toBeDefined();
    expect(errorCall![1]).toContain('Execution failed');
  });

  it('should remove task from running set after execution completes', async () => {
    const task = createMockTask();
    scheduler = new Scheduler({
      scheduleManager: mockScheduleManager,
      callbacks: mockCallbacks,
      executor: mockExecutor,
    });

    scheduler.addTask(task);

    // Before execution
    expect(scheduler.isTaskRunning('task-1')).toBe(false);
    expect(scheduler.isAnyTaskRunning()).toBe(false);

    await vi.advanceTimersByTimeAsync(61000);

    // After execution
    expect(scheduler.isTaskRunning('task-1')).toBe(false);
    expect(scheduler.isAnyTaskRunning()).toBe(false);
  });

  it('should skip blocking task if previous execution still running', async () => {
    const blockingTask = createMockTask({ blocking: true });

    // Make executor take a long time
    let resolveExecution: () => void;
    mockExecutor.mockImplementation(
      () => new Promise<void>(resolve => { resolveExecution = resolve; })
    );

    scheduler = new Scheduler({
      scheduleManager: mockScheduleManager,
      callbacks: mockCallbacks,
      executor: mockExecutor,
    });

    scheduler.addTask(blockingTask);

    // First execution starts
    await vi.advanceTimersByTimeAsync(61000);
    expect(scheduler.isTaskRunning('task-1')).toBe(true);

    // Second trigger while first is still running - should be skipped
    await vi.advanceTimersByTimeAsync(61000);

    // Executor should only be called once
    expect(mockExecutor).toHaveBeenCalledOnce();

    // Clean up
    resolveExecution!();
  });
});

describe('Scheduler (cooldown integration)', () => {
  let scheduler: Scheduler;
  let mockScheduleManager: ReturnType<typeof createMockScheduleManager>;
  let mockCallbacks: SchedulerCallbacks;
  let mockExecutor: TaskExecutor;
  let mockCooldownManager: any;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockScheduleManager = createMockScheduleManager();
    mockCallbacks = createMockCallbacks();
    mockExecutor = createMockExecutor();

    mockCooldownManager = {
      isInCooldown: vi.fn().mockResolvedValue(false),
      getCooldownStatus: vi.fn().mockResolvedValue({
        isInCooldown: false,
        lastExecutionTime: null,
        cooldownEndsAt: null,
        remainingMs: 0,
      }),
      recordExecution: vi.fn().mockResolvedValue(undefined),
      clearCooldown: vi.fn().mockResolvedValue(true),
    };
  });

  afterEach(() => {
    if (scheduler) scheduler.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should skip task when in cooldown period', async () => {
    mockCooldownManager.isInCooldown.mockResolvedValue(true);
    mockCooldownManager.getCooldownStatus.mockResolvedValue({
      isInCooldown: true,
      lastExecutionTime: new Date('2026-01-01T10:00:00'),
      cooldownEndsAt: new Date('2026-01-01T11:00:00'),
      remainingMs: 1800000,
    });

    const task = createMockTask({ cooldownPeriod: 3600000 });
    scheduler = new Scheduler({
      scheduleManager: mockScheduleManager,
      callbacks: mockCallbacks,
      executor: mockExecutor,
      cooldownManager: mockCooldownManager,
    });

    scheduler.addTask(task);
    await vi.advanceTimersByTimeAsync(61000);

    // Executor should NOT be called
    expect(mockExecutor).not.toHaveBeenCalled();

    // Should send cooldown notification
    expect(mockCallbacks.sendMessage).toHaveBeenCalled();
    const call = mockCallbacks.sendMessage.mock.calls[0];
    expect(call[1]).toContain('冷静期中');
  });

  it('should record execution for cooldown after successful execution', async () => {
    const task = createMockTask({ cooldownPeriod: 3600000 });
    scheduler = new Scheduler({
      scheduleManager: mockScheduleManager,
      callbacks: mockCallbacks,
      executor: mockExecutor,
      cooldownManager: mockCooldownManager,
    });

    scheduler.addTask(task);
    await vi.advanceTimersByTimeAsync(61000);

    expect(mockCooldownManager.recordExecution).toHaveBeenCalledWith('task-1', 3600000);
  });

  it('should record execution for cooldown even after failed execution', async () => {
    mockExecutor.mockRejectedValue(new Error('Failed'));
    const task = createMockTask({ cooldownPeriod: 3600000 });
    scheduler = new Scheduler({
      scheduleManager: mockScheduleManager,
      callbacks: mockCallbacks,
      executor: mockExecutor,
      cooldownManager: mockCooldownManager,
    });

    scheduler.addTask(task);
    await vi.advanceTimersByTimeAsync(61000);

    expect(mockCooldownManager.recordExecution).toHaveBeenCalledWith('task-1', 3600000);
  });

  it('should not check cooldown when task has no cooldownPeriod', async () => {
    const task = createMockTask({ cooldownPeriod: undefined });
    scheduler = new Scheduler({
      scheduleManager: mockScheduleManager,
      callbacks: mockCallbacks,
      executor: mockExecutor,
      cooldownManager: mockCooldownManager,
    });

    scheduler.addTask(task);
    await vi.advanceTimersByTimeAsync(61000);

    expect(mockCooldownManager.isInCooldown).not.toHaveBeenCalled();
    expect(mockExecutor).toHaveBeenCalled();
  });
});
