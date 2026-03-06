/**
 * Integration tests for Worker Agent System.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskQueue } from './task-queue.js';
import { WorkerPool } from './worker-pool.js';
import { TaskDispatcher } from './task-dispatcher.js';
import { SimpleWorker } from './simple-worker.js';
import type { SubTask } from './types.js';

describe('Worker Agent System', () => {
  let pool: WorkerPool;
  let dispatcher: TaskDispatcher;

  beforeEach(() => {
    pool = new WorkerPool({
      workerFactory: (id) => new SimpleWorker({
        id,
        executor: async (task) => {
        await new Promise(r => setTimeout(r, 10));
        return `Result: ${task.input}`;
      }),
      maxWorkers: 5,
    });

    dispatcher = new TaskDispatcher({
      pool,
      defaultConcurrency: 3,
    });
  });

  afterEach(() => {
    dispatcher.dispose();
    pool.dispose();
  });

  describe('TaskQueue', () => {
    let queue: TaskQueue;

    beforeEach(() => {
      queue = new TaskQueue();
    });

    afterEach(() => {
      queue.dispose();
    });

    it('should enqueue and dequeue tasks', () => {
      const task: SubTask = { id: 't1', input: 'test' };
      expect(queue.enqueue(task)).toBe(true);
      expect(queue.size()).toBe(1);

      const dequeued = queue.dequeue();
      expect(dequeued?.id).toBe('t1');
      expect(queue.size()).toBe(0);
    });

    it('should support priority ordering', () => {
      const pq = new TaskQueue({ enablePriority: true });
      pq.enqueue({ id: 'low', input: 'a', priority: 'low' });
      pq.enqueue({ id: 'high', input: 'b', priority: 'high' });
      pq.enqueue({ id: 'critical', input: 'c', priority: 'critical' });

      expect(pq.dequeue()?.id).toBe('critical');
      expect(pq.dequeue()?.id).toBe('high');
      expect(pq.dequeue()?.id).toBe('low');
      pq.dispose();
    });
  });

  describe('SimpleWorker', () => {
    it('should execute tasks and async () => {
      const worker = new SimpleWorker({
        id: 'test',
        executor: async (task) => `Processed: ${task.input}`,
      });

      const task: SubTask = { id: 't1', input: 'hello' };
      const messages = [];
      for await (const msg of worker.execute(task)) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
      expect(worker.status).toBe('idle');
      worker.dispose();
    });
  });

  describe('WorkerPool', () => {
    it('should execute single task', async () => {
      const task: SubTask = { id: 't1', input: 5 };
      const result = await pool.executeOne(task);

      expect(result.success).toBe(true);
      expect(result.result).toBe('Result: 5');
    });

    it('should execute multiple tasks', async () => {
      const tasks: SubTask[] = [
        { id: 't1', input: 1 },
        { id: 't2', input: 2 },
        { id: 't3', input: 3 },
      ];

      const results = await pool.executeAll(tasks, 2);

      expect(results.length).toBe(3);
      expect(results.every(r => r.success)).toBe(true);
    });
  });

  describe('TaskDispatcher', () => {
    it('should dispatch and wait for tasks', async () => {
      const tasks: SubTask[] = [
        { id: 't1', input: 1 },
        { id: 't2', input: 2 },
        { id: 't3', input: 3 },
      ];

      const handles = dispatcher.dispatchAll(tasks);
      const results = await dispatcher.waitForAll(handles);

      expect(results.length).toBe(3);
      expect(results.every(r => r.success)).toBe(true);
    });

    it('should handle task cancellation', () => {
      const task: SubTask = { id: 't1', input: 'test' };
      const handle = dispatcher.dispatch(task);

      handle.cancel();
      expect(task.status).toBe('cancelled');
    });
  });
});
