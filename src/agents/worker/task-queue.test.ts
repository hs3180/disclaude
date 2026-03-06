/**
 * Tests for TaskQueue - Priority-based task queue.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskQueue } from './task-queue.js';
import type { SubTask } from './types.js';

describe('TaskQueue', () => {
  let queue: TaskQueue;

  beforeEach(() => {
    queue = new TaskQueue({ maxSize: 10 });
  });

  afterEach(() => {
    queue.dispose();
  });

  describe('enqueue', () => {
    it('should add a task to the queue', () => {
      const task: SubTask = { id: 'task-1', input: 'test' };
      expect(queue.enqueue(task)).toBe(true);
      expect(queue.size()).toBe(1);
    });

    it('should reject duplicate task IDs', () => {
      const task: SubTask = { id: 'task-1', input: 'test' };
      expect(queue.enqueue(task)).toBe(true);
      expect(queue.enqueue(task)).toBe(false);
      expect(queue.size()).toBe(1);
    });

    it('should reject tasks when queue is full', () => {
      const smallQueue = new TaskQueue({ maxSize: 2 });
      expect(smallQueue.enqueue({ id: '1', input: 'a' })).toBe(true);
      expect(smallQueue.enqueue({ id: '2', input: 'b' })).toBe(true);
      expect(smallQueue.enqueue({ id: '3', input: 'c' })).toBe(false);
      smallQueue.dispose();
    });
  });

  describe('dequeue', () => {
    it('should return undefined when queue is empty', () => {
      expect(queue.dequeue()).toBeUndefined();
    });

    it('should return first pending task', () => {
      queue.enqueue({ id: '1', input: 'a' });
      queue.enqueue({ id: '2', input: 'b' });

      const task = queue.dequeue();
      expect(task?.id).toBe('1');
    });

    it('should skip tasks with incomplete dependencies', () => {
      queue.enqueue({ id: '1', input: 'a', status: 'pending' });
      queue.enqueue({ id: '2', input: 'b', dependencies: ['1'] });

      // Should get task 1 first (task 2 depends on it)
      const first = queue.dequeue();
      expect(first?.id).toBe('1');

      // Task 2 should still be in queue (dependency not completed)
      const second = queue.dequeue();
      expect(second).toBeUndefined();
    });

    it('should allow tasks with completed dependencies', () => {
      queue.enqueue({ id: '1', input: 'a', status: 'completed' });
      queue.enqueue({ id: '2', input: 'b', dependencies: ['1'] });

      const task = queue.dequeue();
      expect(task?.id).toBe('2');
    });
  });

  describe('priority ordering', () => {
    it('should order tasks by priority (high to low)', () => {
      const priorityQueue = new TaskQueue({ enablePriority: true });

      priorityQueue.enqueue({ id: '1', input: 'a', priority: 'low' });
      priorityQueue.enqueue({ id: '2', input: 'b', priority: 'critical' });
      priorityQueue.enqueue({ id: '3', input: 'c', priority: 'normal' });

      expect(priorityQueue.dequeue()?.id).toBe('2'); // critical
      expect(priorityQueue.dequeue()?.id).toBe('3'); // normal
      expect(priorityQueue.dequeue()?.id).toBe('1'); // low

      priorityQueue.dispose();
    });
  });

  describe('peek', () => {
    it('should return first task without removing it', () => {
      queue.enqueue({ id: '1', input: 'a' });
      expect(queue.peek()?.id).toBe('1');
      expect(queue.size()).toBe(1);
    });
  });

  describe('cancel', () => {
    it('should remove a pending task', () => {
      queue.enqueue({ id: '1', input: 'a' });
      expect(queue.cancel('1')).toBe(true);
      expect(queue.size()).toBe(0);
    });

    it('should return false for non-existent task', () => {
      expect(queue.cancel('nonexistent')).toBe(false);
    });
  });

  describe('getByStatus', () => {
    it('should filter tasks by status', () => {
      queue.enqueue({ id: '1', input: 'a', status: 'pending' });
      queue.enqueue({ id: '2', input: 'b', status: 'running' });
      queue.enqueue({ id: '3', input: 'c', status: 'pending' });

      const pending = queue.getByStatus('pending');
      expect(pending.length).toBe(2);
      expect(pending.map(t => t.id)).toContain('1');
      expect(pending.map(t => t.id)).toContain('3');
    });
  });

  describe('dispose', () => {
    it('should clear all tasks', () => {
      queue.enqueue({ id: '1', input: 'a' });
      queue.enqueue({ id: '2', input: 'b' });

      queue.dispose();
      expect(queue.size()).toBe(0);
    });

    it('should be idempotent', () => {
      queue.dispose();
      queue.dispose(); // Should not throw
    });
  });
});
