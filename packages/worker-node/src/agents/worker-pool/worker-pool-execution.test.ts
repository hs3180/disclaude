/**
 * Tests for Worker Pool Execution - Task submission, batch execution, and completion.
 *
 * Issue #1617 Phase 2: Add meaningful unit tests for worker-pool modules.
 * Covers submitTask, submitBatchTasks, executeBatch, and waitForTaskCompletion.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  submitTask,
  submitBatchTasks,
  executeBatch,
  waitForTaskCompletion,
  type SubmissionContext,
  type BatchContext,
} from './worker-pool-execution.js';
import type { Task, TaskOptions, TaskResult } from './types.js';
import type { WorkerPoolTaskQueue as TaskQueue } from './task-queue.js';

// Mock callbacks for testing
const mockCallbacks = {
  sendMessage: async () => {},
  sendCard: async () => {},
  sendFile: async () => {},
  sendInteractiveMessage: async () => {},
};

// ============================================================================
// Helper: Create mock task queue
// ============================================================================

function createMockTaskQueue(): TaskQueue & {
  _tasks: Map<string, Task>;
  _history: Task[];
} {
  const _tasks = new Map<string, Task>();
  const _history: Task[] = [];

  const queue = {
    _tasks,
    _history,

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
      return optionsList.map((options) => queue.enqueue(options));
    },

    dequeue(): Task | undefined {
      const entries = Array.from(_tasks.values()).filter((t) => t.status === 'pending');
      return entries[0];
    },

    peek(): Task | undefined {
      const entries = Array.from(_tasks.values()).filter((t) => t.status === 'pending');
      return entries[0];
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
      task.result = { taskId: id, status: 'cancelled' };
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
      return Array.from(_tasks.values()).filter((t) => t.status === 'pending');
    },

    getRunning(): Task[] {
      return Array.from(_tasks.values()).filter((t) => t.status === 'running');
    },

    countByStatus(status: Task['status']): number {
      return Array.from(_tasks.values()).filter((t) => t.status === status).length;
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
  } as unknown as TaskQueue & { _tasks: Map<string, Task>; _history: Task[] };

  return queue;
}

// ============================================================================
// Tests
// ============================================================================

describe('submitTask', () => {
  let taskQueue: ReturnType<typeof createMockTaskQueue>;
  let ctx: SubmissionContext;

  beforeEach(() => {
    taskQueue = createMockTaskQueue();
    ctx = {
      taskQueue,
      emit: vi.fn(),
      triggerAssignment: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('should enqueue a task and return it', () => {
    const options: TaskOptions = {
      id: 'task-1',
      name: 'Test Task',
      prompt: 'Do something',
      chatId: 'chat-123',
      callbacks: mockCallbacks,
    };

    const task = submitTask(ctx, options);

    expect(task.id).toBe('task-1');
    expect(task.name).toBe('Test Task');
    expect(task.status).toBe('pending');
    expect(task.createdAt).toBeInstanceOf(Date);
  });

  it('should emit task:queued event', () => {
    const options: TaskOptions = {
      id: 'task-1',
      name: 'Test Task',
      prompt: 'Do something',
      chatId: 'chat-123',
      callbacks: mockCallbacks,
    };

    submitTask(ctx, options);

    expect(ctx.emit).toHaveBeenCalledWith('task:queued', { taskId: 'task-1' });
  });

  it('should trigger task assignment after submission', () => {
    const options: TaskOptions = {
      id: 'task-1',
      name: 'Test Task',
      prompt: 'Do something',
      chatId: 'chat-123',
      callbacks: mockCallbacks,
    };

    submitTask(ctx, options);

    expect(ctx.triggerAssignment).toHaveBeenCalledOnce();
  });

  it('should add the task to the queue', () => {
    const options: TaskOptions = {
      id: 'task-1',
      name: 'Test Task',
      prompt: 'Do something',
      chatId: 'chat-123',
      callbacks: mockCallbacks,
    };

    submitTask(ctx, options);

    expect(taskQueue.get('task-1')).toBeDefined();
  });
});

describe('submitBatchTasks', () => {
  let taskQueue: ReturnType<typeof createMockTaskQueue>;
  let ctx: SubmissionContext;

  beforeEach(() => {
    taskQueue = createMockTaskQueue();
    ctx = {
      taskQueue,
      emit: vi.fn(),
      triggerAssignment: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('should submit multiple tasks at once', () => {
    const optionsList: TaskOptions[] = [
      { id: 'task-1', name: 'Task 1', prompt: 'A', chatId: 'c1', callbacks: mockCallbacks },
      { id: 'task-2', name: 'Task 2', prompt: 'B', chatId: 'c2', callbacks: mockCallbacks },
      { id: 'task-3', name: 'Task 3', prompt: 'C', chatId: 'c3', callbacks: mockCallbacks },
    ];

    const tasks = submitBatchTasks(ctx, optionsList);

    expect(tasks).toHaveLength(3);
    expect(tasks[0].id).toBe('task-1');
    expect(tasks[1].id).toBe('task-2');
    expect(tasks[2].id).toBe('task-3');
  });

  it('should trigger assignment once after batch', () => {
    const optionsList: TaskOptions[] = [
      { id: 'task-1', name: 'Task 1', prompt: 'A', chatId: 'c1', callbacks: mockCallbacks },
      { id: 'task-2', name: 'Task 2', prompt: 'B', chatId: 'c2', callbacks: mockCallbacks },
    ];

    submitBatchTasks(ctx, optionsList);

    expect(ctx.triggerAssignment).toHaveBeenCalledOnce();
  });

  it('should return empty array for empty options list', () => {
    const tasks = submitBatchTasks(ctx, []);

    expect(tasks).toHaveLength(0);
  });

  it('should add all tasks to the queue', () => {
    const optionsList: TaskOptions[] = [
      { id: 'task-1', name: 'Task 1', prompt: 'A', chatId: 'c1', callbacks: mockCallbacks },
      { id: 'task-2', name: 'Task 2', prompt: 'B', chatId: 'c2', callbacks: mockCallbacks },
    ];

    submitBatchTasks(ctx, optionsList);

    expect(taskQueue.get('task-1')).toBeDefined();
    expect(taskQueue.get('task-2')).toBeDefined();
  });
});

describe('executeBatch', () => {
  function createMockBatchContext(
    results: Map<string, TaskResult>,
  ): BatchContext {
    const submittedOptions: TaskOptions[] = [];

    return {
      submitBatch(optionsList: TaskOptions[]): Task[] {
        submittedOptions.push(...optionsList);
        return optionsList.map((opt) => ({
          ...opt,
          status: 'pending' as const,
          createdAt: new Date(),
          retryCount: 0,
        }));
      },

      waitForTask(taskId: string, _timeout?: number): Promise<TaskResult> {
        const result = results.get(taskId);
        if (!result) {
          return Promise.reject(new Error(`Task ${taskId} not found in mock results`));
        }
        return Promise.resolve(result);
      },

      cancelTask(_taskId: string): boolean {
        return true;
      },
    };
  }

  it('should execute all tasks and return results', async () => {
    const results = new Map<string, TaskResult>([
      ['task-1', { taskId: 'task-1', status: 'completed', output: 'Result 1' }],
      ['task-2', { taskId: 'task-2', status: 'completed', output: 'Result 2' }],
    ]);

    const ctx = createMockBatchContext(results);

    const batchResult = await executeBatch(ctx, [
      { id: 'task-1', name: 'Task 1', prompt: 'A', chatId: 'c1', callbacks: mockCallbacks },
      { id: 'task-2', name: 'Task 2', prompt: 'B', chatId: 'c2', callbacks: mockCallbacks },
    ]);

    expect(batchResult.allSucceeded).toBe(true);
    expect(batchResult.successCount).toBe(2);
    expect(batchResult.failedCount).toBe(0);
    expect(batchResult.results).toHaveLength(2);
  });

  it('should track failed tasks', async () => {
    const results = new Map<string, TaskResult>([
      ['task-1', { taskId: 'task-1', status: 'completed', output: 'OK' }],
      ['task-2', { taskId: 'task-2', status: 'failed', error: 'Something went wrong' }],
    ]);

    const ctx = createMockBatchContext(results);

    const batchResult = await executeBatch(ctx, [
      { id: 'task-1', name: 'Task 1', prompt: 'A', chatId: 'c1', callbacks: mockCallbacks },
      { id: 'task-2', name: 'Task 2', prompt: 'B', chatId: 'c2', callbacks: mockCallbacks },
    ]);

    expect(batchResult.allSucceeded).toBe(false);
    expect(batchResult.successCount).toBe(1);
    expect(batchResult.failedCount).toBe(1);
  });

  it('should call onProgress callback', async () => {
    const results = new Map<string, TaskResult>([
      ['task-1', { taskId: 'task-1', status: 'completed' }],
      ['task-2', { taskId: 'task-2', status: 'completed' }],
    ]);

    const ctx = createMockBatchContext(results);
    const onProgress = vi.fn();

    await executeBatch(
      ctx,
      [
        { id: 'task-1', name: 'Task 1', prompt: 'A', chatId: 'c1', callbacks: mockCallbacks },
        { id: 'task-2', name: 'Task 2', prompt: 'B', chatId: 'c2', callbacks: mockCallbacks },
      ],
      { onProgress },
    );

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith(1, 2);
    expect(onProgress).toHaveBeenCalledWith(2, 2);
  });

  it('should cancel remaining tasks when failFast is true', async () => {
    const results = new Map<string, TaskResult>([
      ['task-1', { taskId: 'task-1', status: 'completed' }],
      ['task-2', { taskId: 'task-2', status: 'failed', error: 'Error' }],
      ['task-3', { taskId: 'task-3', status: 'completed' }],
    ]);

    const cancelMock = vi.fn().mockReturnValue(true);
    const submittedTasks: string[] = [];

    const ctx: BatchContext = {
      submitBatch(optionsList: TaskOptions[]): Task[] {
        return optionsList.map((opt) => ({
          ...opt,
          status: 'pending' as const,
          createdAt: new Date(),
          retryCount: 0,
        }));
      },
      waitForTask(taskId: string): Promise<TaskResult> {
        submittedTasks.push(taskId);
        const result = results.get(taskId);
        if (!result) { return Promise.reject(new Error(`Unknown task: ${taskId}`)); }
        return Promise.resolve(result);
      },
      cancelTask: cancelMock,
    };

    const batchResult = await executeBatch(
      ctx,
      [
        { id: 'task-1', name: 'Task 1', prompt: 'A', chatId: 'c1', callbacks: mockCallbacks },
        { id: 'task-2', name: 'Task 2', prompt: 'B', chatId: 'c2', callbacks: mockCallbacks },
        { id: 'task-3', name: 'Task 3', prompt: 'C', chatId: 'c3', callbacks: mockCallbacks },
      ],
      { failFast: true },
    );

    expect(batchResult.failedCount).toBe(1);
    expect(cancelMock).toHaveBeenCalledWith('task-3');
    expect(batchResult.results).toHaveLength(2); // Only first 2 results
  });

  it('should handle rejected task promises', async () => {
    const ctx: BatchContext = {
      submitBatch(optionsList: TaskOptions[]): Task[] {
        return optionsList.map((opt) => ({
          ...opt,
          status: 'pending' as const,
          createdAt: new Date(),
          retryCount: 0,
        }));
      },
      waitForTask(_taskId: string): Promise<TaskResult> {
        return Promise.reject(new Error('Connection lost'));
      },
      cancelTask: vi.fn().mockReturnValue(true),
    };

    const batchResult = await executeBatch(ctx, [
      { id: 'task-1', name: 'Task 1', prompt: 'A', chatId: 'c1', callbacks: mockCallbacks },
    ]);

    expect(batchResult.allSucceeded).toBe(false);
    expect(batchResult.failedCount).toBe(1);
    expect(batchResult.results[0].status).toBe('failed');
    expect(batchResult.results[0].error).toBe('Connection lost');
  });

  it('should report total duration', async () => {
    const results = new Map<string, TaskResult>([
      ['task-1', { taskId: 'task-1', status: 'completed' }],
    ]);

    const ctx = createMockBatchContext(results);

    const batchResult = await executeBatch(ctx, [
      { id: 'task-1', name: 'Task 1', prompt: 'A', chatId: 'c1', callbacks: mockCallbacks },
    ]);

    expect(batchResult.totalDuration).toBeGreaterThanOrEqual(0);
  });

  it('should handle empty task list', async () => {
    const ctx = createMockBatchContext(new Map());

    const batchResult = await executeBatch(ctx, []);

    expect(batchResult.allSucceeded).toBe(true);
    expect(batchResult.successCount).toBe(0);
    expect(batchResult.failedCount).toBe(0);
    expect(batchResult.results).toHaveLength(0);
  });
});

describe('waitForTaskCompletion', () => {
  let taskQueue: ReturnType<typeof createMockTaskQueue>;

  beforeEach(() => {
    taskQueue = createMockTaskQueue();
  });

  it('should resolve immediately if task result is in history', async () => {
    const options: TaskOptions = {
      id: 'task-1',
      name: 'Test Task',
      prompt: 'Do something',
      chatId: 'chat-123',
      callbacks: mockCallbacks,
    };

    const task = taskQueue.enqueue(options);
    taskQueue.updateStatus('task-1', 'completed', { output: 'Done' });

    const result = await waitForTaskCompletion(taskQueue, task.id, 5000);

    expect(result.status).toBe('completed');
    expect(result.output).toBe('Done');
  });

  it('should resolve with failed result when task fails', async () => {
    const options: TaskOptions = {
      id: 'task-1',
      name: 'Test Task',
      prompt: 'Do something',
      chatId: 'chat-123',
      callbacks: mockCallbacks,
    };

    taskQueue.enqueue(options);
    taskQueue.updateStatus('task-1', 'failed', { error: 'Task failed' });

    // When a task fails and is moved to history, waitForTaskCompletion
    // resolves with the failed TaskResult (the history check fires first)
    const result = await waitForTaskCompletion(taskQueue, 'task-1', 5000);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Task failed');
  });

  it('should resolve with cancelled result when task is cancelled', async () => {
    const options: TaskOptions = {
      id: 'task-1',
      name: 'Test Task',
      prompt: 'Do something',
      chatId: 'chat-123',
      callbacks: mockCallbacks,
    };

    taskQueue.enqueue(options);
    taskQueue.cancel('task-1');

    // Cancelled task is moved to history with a result
    const result = await waitForTaskCompletion(taskQueue, 'task-1', 5000);
    expect(result.status).toBe('cancelled');
  });

  it('should time out if task never completes', async () => {
    const options: TaskOptions = {
      id: 'task-1',
      name: 'Test Task',
      prompt: 'Do something',
      chatId: 'chat-123',
      callbacks: mockCallbacks,
    };

    taskQueue.enqueue(options);

    await expect(
      waitForTaskCompletion(taskQueue, 'task-1', 200),
    ).rejects.toThrow('timed out');
  }, 10000);

  it('should resolve when task completes via polling', async () => {
    const options: TaskOptions = {
      id: 'task-1',
      name: 'Test Task',
      prompt: 'Do something',
      chatId: 'chat-123',
      callbacks: mockCallbacks,
    };

    taskQueue.enqueue(options);

    // Simulate task completion after a delay
    setTimeout(() => {
      taskQueue.updateStatus('task-1', 'completed', { output: 'Delayed result' });
    }, 150);

    const result = await waitForTaskCompletion(taskQueue, 'task-1', 5000);

    expect(result.status).toBe('completed');
    expect(result.output).toBe('Delayed result');
  }, 10000);
});
