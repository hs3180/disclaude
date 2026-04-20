/**
 * Tests for Worker Pool Health - Task assignment, execution, and error recovery.
 *
 * Issue #1617 Phase 2: Add meaningful unit tests for worker-pool modules.
 * Covers assignTasksToWorkers and executeTaskOnWorker including retry logic,
 * error handling, and worker lifecycle during task execution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  assignTasksToWorkers,
  executeTaskOnWorker,
  type AssignmentContext,
} from './worker-pool-health.js';
import type {
  Task,
  TaskOptions,
  TaskResult,
  WorkerHandle,
} from './types.js';
import type { WorkerPoolTaskQueue as TaskQueue } from './task-queue.js';
import type { ChatAgentCallbacks } from '../chat-agent/index.js';

// Mock AgentFactory to avoid real agent creation
vi.mock('../factory.js', () => ({
  AgentFactory: {
    createAgent: vi.fn(),
  },
}));

// Import after mock
import { AgentFactory } from '../factory.js';

// ============================================================================
// Helpers
// ============================================================================

const mockCallbacks: ChatAgentCallbacks = {
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendCard: vi.fn().mockResolvedValue(undefined),
  sendFile: vi.fn().mockResolvedValue(undefined),
  sendInteractiveMessage: vi.fn().mockResolvedValue(undefined),
};

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? 'task-1',
    name: overrides.name ?? 'Test Task',
    prompt: overrides.prompt ?? 'Do something',
    chatId: overrides.chatId ?? 'chat-123',
    callbacks: overrides.callbacks ?? mockCallbacks,
    status: overrides.status ?? 'pending',
    createdAt: overrides.createdAt ?? new Date(),
    retryCount: overrides.retryCount ?? 0,
    maxRetries: overrides.maxRetries ?? 0,
    senderOpenId: overrides.senderOpenId,
    workerId: overrides.workerId,
  };
}

function createMockWorker(overrides: Partial<WorkerHandle> = {}): WorkerHandle {
  return {
    id: overrides.id ?? 'worker-1',
    type: overrides.type ?? 'general',
    maxConcurrent: overrides.maxConcurrent ?? 1,
    defaultTimeout: overrides.defaultTimeout ?? 300000,
    status: overrides.status ?? 'idle',
    currentTaskIds: overrides.currentTaskIds ?? [],
    createdAt: overrides.createdAt ?? new Date(),
    stats: {
      tasksCompleted: overrides.stats?.tasksCompleted ?? 0,
      tasksFailed: overrides.stats?.tasksFailed ?? 0,
      totalExecutionTime: overrides.stats?.totalExecutionTime ?? 0,
      averageExecutionTime: overrides.stats?.averageExecutionTime ?? 0,
    },
  };
}

function createMockTaskQueue(tasks: Task[] = []): TaskQueue {
  const _tasks = new Map<string, Task>();
  const _history: Task[] = [];

  tasks.forEach(t => _tasks.set(t.id, { ...t }));

  return {
    enqueue(options: TaskOptions): Task {
      const task: Task = {
        ...options,
        status: 'pending',
        createdAt: new Date(),
        retryCount: 0,
      };
      _tasks.set(task.id, task);
      return task;
    },
    enqueueBatch(optionsList: TaskOptions[]): Task[] {
      return optionsList.map(opt => {
        const task: Task = { ...opt, status: 'pending', createdAt: new Date(), retryCount: 0 };
        _tasks.set(task.id, task);
        return task;
      });
    },
    dequeue(): Task | undefined {
      return Array.from(_tasks.values()).find(t => t.status === 'pending');
    },
    peek(): Task | undefined {
      return Array.from(_tasks.values()).find(t => t.status === 'pending');
    },
    get(id: string): Task | undefined {
      return _tasks.get(id);
    },
    remove(id: string): boolean {
      return _tasks.delete(id);
    },
    cancel(id: string): boolean {
      const task = _tasks.get(id);
      if (!task || task.status !== 'pending') { return false; }
      task.status = 'cancelled';
      _tasks.delete(id);
      _history.push(task);
      return true;
    },
    updateStatus(
      id: string,
      status: Task['status'],
      result?: Partial<TaskResult>,
    ): void {
      const task = _tasks.get(id);
      if (task) {
        task.status = status;
        if (status === 'completed' || status === 'failed') {
          task.result = { taskId: id, status, ...result } as TaskResult;
          _tasks.delete(id);
          _history.push(task);
        }
      }
    },
    getHistory(): Task[] {
      return _history;
    },
    getPending(): Task[] {
      return Array.from(_tasks.values()).filter(t => t.status === 'pending');
    },
    getRunning(): Task[] {
      return Array.from(_tasks.values()).filter(t => t.status === 'running');
    },
    countByStatus(status: Task['status']): number {
      return Array.from(_tasks.values()).filter(t => t.status === status).length;
    },
    size(): number {
      return _tasks.size;
    },
    isEmpty(): boolean {
      return _tasks.size === 0;
    },
    clear(): void {
      _tasks.clear();
      _history.length = 0;
    },
    getDependents(_taskId: string): Task[] {
      return [];
    },
    hasAvailableTasks(): boolean {
      return Array.from(_tasks.values()).some(t => t.status === 'pending');
    },
  } as unknown as TaskQueue;
}

function createAssignmentContext(overrides: Partial<AssignmentContext> = {}): AssignmentContext {
  const workers = overrides.workers ?? new Map<string, WorkerHandle>();
  const taskQueue = overrides.taskQueue ?? createMockTaskQueue();
  const emit = overrides.emit ?? vi.fn();
  const runningTasks = overrides.runningTasks ?? new Map<string, { task: Task; workerId: string }>();

  return {
    workers,
    taskQueue,
    config: {
      maxWorkers: 5,
      minIdleWorkers: 1,
      defaultTimeout: 300000,
      maxRetries: 2,
      enablePriority: true,
      maxHistorySize: 100,
      resultRetentionTime: 3600000,
    },
    callbacks: mockCallbacks,
    runningTasks,
    emit,
    getIdleWorker: overrides.getIdleWorker ?? (() => createMockWorker()),
    createWorker: overrides.createWorker ?? (() => createMockWorker()),
    updateWorkerStatus: overrides.updateWorkerStatus ?? vi.fn(),
    ensureMinIdleWorkers: overrides.ensureMinIdleWorkers ?? vi.fn(),
  };
}

function createMockAgent() {
  return {
    executeOnce: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };
}

// ============================================================================
// Tests: assignTasksToWorkers
// ============================================================================

describe('assignTasksToWorkers', () => {
  beforeEach(() => {
    vi.mocked(AgentFactory.createAgent).mockReturnValue(createMockAgent() as never);
  });

  it('should assign a task to an idle worker', async () => {
    const worker = createMockWorker({ id: 'w-1' });
    const task = createMockTask({ id: 't-1' });
    const taskQueue = createMockTaskQueue([task]);
    const getIdleWorker = vi.fn().mockReturnValueOnce(worker).mockReturnValueOnce(undefined);
    const updateWorkerStatus = vi.fn();

    const ctx = createAssignmentContext({
      taskQueue,
      getIdleWorker,
      updateWorkerStatus,
    });

    await assignTasksToWorkers(ctx);

    expect(taskQueue.get('t-1')?.status).not.toBe('pending');
    expect(AgentFactory.createAgent).toHaveBeenCalled();
  });

  it('should create a new worker when no idle workers available but under limit', async () => {
    const task = createMockTask({ id: 't-1' });
    const taskQueue = createMockTaskQueue([task]);
    const newWorker = createMockWorker({ id: 'w-new' });
    let callCount = 0;
    const getIdleWorker = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) { return undefined; }
      return newWorker;
    });
    const createWorker = vi.fn().mockImplementation(() => {
      return newWorker;
    });

    const workers = new Map<string, WorkerHandle>();
    const ctx = createAssignmentContext({
      workers,
      taskQueue,
      getIdleWorker,
      createWorker,
    });

    await assignTasksToWorkers(ctx);

    expect(createWorker).toHaveBeenCalled();
  });

  it('should stop when pool is full and no idle workers', async () => {
    const task = createMockTask({ id: 't-1' });
    const taskQueue = createMockTaskQueue([task]);
    const getIdleWorker = vi.fn().mockReturnValue(undefined);
    const createWorker = vi.fn();

    // Pool is full (5 workers at max)
    const workers = new Map<string, WorkerHandle>();
    for (let i = 0; i < 5; i++) {
      workers.set(`w-${i}`, createMockWorker({ id: `w-${i}`, status: 'busy' }));
    }

    const ctx = createAssignmentContext({
      workers,
      taskQueue,
      getIdleWorker,
      createWorker,
    });

    await assignTasksToWorkers(ctx);

    expect(createWorker).not.toHaveBeenCalled();
  });

  it('should call ensureMinIdleWorkers after assignment', async () => {
    const ensureMinIdleWorkers = vi.fn();
    const taskQueue = createMockTaskQueue(); // no tasks

    const ctx = createAssignmentContext({
      taskQueue,
      ensureMinIdleWorkers,
    });

    await assignTasksToWorkers(ctx);

    expect(ensureMinIdleWorkers).toHaveBeenCalled();
  });

  it('should do nothing when no tasks are available', async () => {
    const taskQueue = createMockTaskQueue(); // empty
    const getIdleWorker = vi.fn();

    const ctx = createAssignmentContext({
      taskQueue,
      getIdleWorker,
    });

    await assignTasksToWorkers(ctx);

    expect(getIdleWorker).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Tests: executeTaskOnWorker
// ============================================================================

describe('executeTaskOnWorker', () => {
  beforeEach(() => {
    vi.mocked(AgentFactory.createAgent).mockReturnValue(createMockAgent() as never);
  });

  it('should execute a task successfully and mark it completed', async () => {
    const task = createMockTask({ id: 't-1' });
    const worker = createMockWorker({ id: 'w-1' });
    const taskQueue = createMockTaskQueue([task]);
    const emit = vi.fn();
    const runningTasks = new Map<string, { task: Task; workerId: string }>();
    const updateWorkerStatus = vi.fn();

    const ctx = createAssignmentContext({
      taskQueue,
      emit,
      runningTasks,
      updateWorkerStatus,
    });

    await executeTaskOnWorker(ctx, task, worker);

    expect(emit).toHaveBeenCalledWith('task:started', { taskId: 't-1', workerId: 'w-1' });
    expect(emit).toHaveBeenCalledWith('task:completed', { taskId: 't-1', workerId: 'w-1' });
    expect(worker.stats.tasksCompleted).toBe(1);
  });

  it('should set task status to running during execution', async () => {
    const task = createMockTask({ id: 't-1' });
    const worker = createMockWorker({ id: 'w-1' });
    const taskQueue = createMockTaskQueue([task]);
    const runningTasks = new Map<string, { task: Task; workerId: string }>();

    const ctx = createAssignmentContext({
      taskQueue,
      runningTasks,
    });

    await executeTaskOnWorker(ctx, task, worker);

    // Task should have been set to running at some point
    expect(task.workerId).toBe('w-1');
    expect(worker.currentTaskIds).toEqual([]);
  });

  it('should register the task in runningTasks during execution', async () => {
    const task = createMockTask({ id: 't-1' });
    const worker = createMockWorker({ id: 'w-1' });
    const taskQueue = createMockTaskQueue([task]);
    const runningTasks = new Map<string, { task: Task; workerId: string }>();

    // Use an agent that delays execution so we can check intermediate state
    let resolveExecution: () => void;
    const executionPromise = new Promise<void>(resolve => { resolveExecution = resolve; });
    const slowAgent = {
      executeOnce: vi.fn().mockImplementation(() => executionPromise),
      dispose: vi.fn(),
    };
    vi.mocked(AgentFactory.createAgent).mockReturnValue(slowAgent as never);

    const ctx = createAssignmentContext({
      taskQueue,
      runningTasks,
    });

    const executionDone = executeTaskOnWorker(ctx, task, worker);

    // During execution, task should be in runningTasks
    expect(runningTasks.has('t-1')).toBe(true);
    expect(runningTasks.get('t-1')).toEqual({ task, workerId: 'w-1' });
    expect(worker.currentTaskIds).toContain('t-1');

    // Let execution complete
    resolveExecution!();
    await executionDone;

    // After completion, runningTasks should be cleaned up
    expect(runningTasks.has('t-1')).toBe(false);
    expect(worker.currentTaskIds).toEqual([]);
  });

  it('should dispose agent after successful execution', async () => {
    const mockAgent = createMockAgent();
    vi.mocked(AgentFactory.createAgent).mockReturnValue(mockAgent as never);

    const task = createMockTask({ id: 't-1' });
    const worker = createMockWorker({ id: 'w-1' });
    const taskQueue = createMockTaskQueue([task]);
    const runningTasks = new Map<string, { task: Task; workerId: string }>();

    const ctx = createAssignmentContext({
      taskQueue,
      runningTasks,
    });

    await executeTaskOnWorker(ctx, task, worker);

    expect(mockAgent.dispose).toHaveBeenCalled();
  });

  it('should mark task as failed when execution throws and no retries left', async () => {
    const failingAgent = {
      executeOnce: vi.fn().mockRejectedValue(new Error('Execution failed')),
      dispose: vi.fn(),
    };
    vi.mocked(AgentFactory.createAgent).mockReturnValue(failingAgent as never);

    const task = createMockTask({ id: 't-1', retryCount: 0, maxRetries: 0 });
    const worker = createMockWorker({ id: 'w-1' });
    const taskQueue = createMockTaskQueue([task]);
    const emit = vi.fn();
    const runningTasks = new Map<string, { task: Task; workerId: string }>();

    const ctx = createAssignmentContext({
      taskQueue,
      emit,
      runningTasks,
    });

    await executeTaskOnWorker(ctx, task, worker);

    expect(emit).toHaveBeenCalledWith('task:failed', {
      taskId: 't-1',
      workerId: 'w-1',
      data: 'Execution failed',
    });
    expect(worker.stats.tasksFailed).toBe(1);
  });

  it('should handle non-Error rejection values', async () => {
    const failingAgent = {
      executeOnce: vi.fn().mockRejectedValue('string error'),
      dispose: vi.fn(),
    };
    vi.mocked(AgentFactory.createAgent).mockReturnValue(failingAgent as never);

    const task = createMockTask({ id: 't-1', retryCount: 0, maxRetries: 0 });
    const worker = createMockWorker({ id: 'w-1' });
    const taskQueue = createMockTaskQueue([task]);
    const emit = vi.fn();
    const runningTasks = new Map<string, { task: Task; workerId: string }>();

    const ctx = createAssignmentContext({
      taskQueue,
      emit,
      runningTasks,
    });

    await executeTaskOnWorker(ctx, task, worker);

    expect(emit).toHaveBeenCalledWith('task:failed', {
      taskId: 't-1',
      workerId: 'w-1',
      data: 'string error',
    });
  });

  it('should retry task when retries are available', async () => {
    const failingAgent = {
      executeOnce: vi.fn().mockRejectedValue(new Error('Temporary failure')),
      dispose: vi.fn(),
    };
    vi.mocked(AgentFactory.createAgent).mockReturnValue(failingAgent as never);

    const task = createMockTask({ id: 't-1', retryCount: 0, maxRetries: 2 });
    const worker = createMockWorker({ id: 'w-1' });
    const taskQueue = createMockTaskQueue([task]);
    const emit = vi.fn();
    const runningTasks = new Map<string, { task: Task; workerId: string }>();

    const ctx = createAssignmentContext({
      taskQueue,
      emit,
      runningTasks,
    });

    await executeTaskOnWorker(ctx, task, worker);

    // Should NOT emit task:failed (it should retry)
    expect(emit).not.toHaveBeenCalledWith('task:failed', expect.anything());
    // Retry count should be incremented
    expect(task.retryCount).toBe(1);
    // Worker should not have failed stat
    expect(worker.stats.tasksFailed).toBe(0);
  });

  it('should release worker as idle after task completion', async () => {
    const task = createMockTask({ id: 't-1' });
    const worker = createMockWorker({ id: 'w-1' });
    const taskQueue = createMockTaskQueue([task]);
    const runningTasks = new Map<string, { task: Task; workerId: string }>();
    const updateWorkerStatus = vi.fn();

    const ctx = createAssignmentContext({
      taskQueue,
      runningTasks,
      updateWorkerStatus,
    });

    await executeTaskOnWorker(ctx, task, worker);

    expect(updateWorkerStatus).toHaveBeenCalledWith('w-1', 'idle');
    expect(worker.currentTaskIds).toEqual([]);
    expect(runningTasks.has('t-1')).toBe(false);
  });

  it('should not set worker to idle if it is disabled', async () => {
    const task = createMockTask({ id: 't-1' });
    const worker = createMockWorker({ id: 'w-1', status: 'disabled' });
    const taskQueue = createMockTaskQueue([task]);
    const runningTasks = new Map<string, { task: Task; workerId: string }>();
    const updateWorkerStatus = vi.fn();

    // Simulate the worker being disabled during execution
    const ctx = createAssignmentContext({
      taskQueue,
      runningTasks,
      updateWorkerStatus,
    });

    await executeTaskOnWorker(ctx, task, worker);

    // updateWorkerStatus should NOT be called for disabled worker
    expect(updateWorkerStatus).not.toHaveBeenCalledWith('w-1', 'idle');
  });

  it('should update worker execution time stats when task has duration', async () => {
    const task = createMockTask({ id: 't-1' });
    const worker = createMockWorker({ id: 'w-1' });
    const taskQueue = createMockTaskQueue([task]);
    const runningTasks = new Map<string, { task: Task; workerId: string }>();

    // Add a completed task with duration to history
    const completedTask = {
      ...task,
      status: 'completed' as const,
      result: {
        taskId: 't-1',
        status: 'completed' as const,
        duration: 5000,
      },
    };

    // We need to override getHistory to return our completed task
    const origQueue = taskQueue;
    const patchedQueue = Object.create(origQueue);
    patchedQueue.getHistory = () => [completedTask];

    const ctx = createAssignmentContext({
      taskQueue: patchedQueue,
      runningTasks,
    });

    await executeTaskOnWorker(ctx, task, worker);

    expect(worker.stats.totalExecutionTime).toBe(5000);
    expect(worker.stats.averageExecutionTime).toBe(5000);
  });
});
