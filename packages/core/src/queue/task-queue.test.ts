/**
 * Tests for Task Queue (packages/core/src/queue/task-queue.ts)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TaskQueue } from './task-queue.js';

describe('TaskQueue', () => {
  let queue: TaskQueue;

  beforeEach(() => {
    queue = new TaskQueue();
  });

  describe('enqueue', () => {
    it('should add a task to the queue', () => {
      const task = queue.enqueue({
        id: 'task-1',
        name: 'Test Task',
        prompt: 'Do something',
      });

      expect(task.id).toBe('task-1');
      expect(task.name).toBe('Test Task');
      expect(task.status).toBe('pending');
      expect(task.priority).toBe('normal');
      expect(queue.size()).toBe(1);
    });

    it('should use custom priority', () => {
      const task = queue.enqueue({
        id: 'task-1',
        name: 'High Priority Task',
        prompt: 'Do something urgent',
        priority: 'high',
      });

      expect(task.priority).toBe('high');
    });

    it('should use default task options', () => {
      const task = queue.enqueue({
        id: 'task-1',
        name: 'Test Task',
        prompt: 'test',
      });

      expect(task.timeout).toBe(300000);
      expect(task.maxRetries).toBe(0);
      expect(task.dependencies).toEqual([]);
    });
  });

  describe('enqueueBatch', () => {
    it('should add multiple tasks at once', () => {
      const tasks = queue.enqueueBatch([
        { id: 'task-1', name: 'Task 1', prompt: 'test' },
        { id: 'task-2', name: 'Task 2', prompt: 'test' },
        { id: 'task-3', name: 'Task 3', prompt: 'test' },
      ]);

      expect(tasks).toHaveLength(3);
      expect(queue.size()).toBe(3);
    });
  });

  describe('dequeue', () => {
    it('should return undefined when queue is empty', () => {
      expect(queue.dequeue()).toBeUndefined();
    });

    it('should return and remove the first available task', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });

      const task = queue.dequeue();

      expect(task?.id).toBe('task-1');
      expect(queue.size()).toBe(0);
    });

    it('should respect priority order (critical > high > normal > low)', () => {
      queue.enqueue({ id: 'low', name: 'Low', prompt: 'test', priority: 'low' });
      queue.enqueue({ id: 'high', name: 'High', prompt: 'test', priority: 'high' });
      queue.enqueue({ id: 'normal', name: 'Normal', prompt: 'test', priority: 'normal' });
      queue.enqueue({ id: 'critical', name: 'Critical', prompt: 'test', priority: 'critical' });

      expect(queue.dequeue()?.id).toBe('critical');
      expect(queue.dequeue()?.id).toBe('high');
      expect(queue.dequeue()?.id).toBe('normal');
      expect(queue.dequeue()?.id).toBe('low');
    });

    it('should only return tasks with satisfied dependencies', () => {
      // Add a task with an unsatisfied dependency
      queue.enqueue({
        id: 'task-1',
        name: 'Task 1',
        prompt: 'test',
        dependencies: [{ taskId: 'task-0', type: 'sequential' }],
      });

      expect(queue.dequeue()).toBeUndefined();
    });
  });

  describe('peek', () => {
    it('should return undefined when queue is empty', () => {
      expect(queue.peek()).toBeUndefined();
    });

    it('should return the next task without removing it', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });

      const task = queue.peek();

      expect(task?.id).toBe('task-1');
      expect(queue.size()).toBe(1);
    });
  });

  describe('get', () => {
    it('should return task by ID', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });

      const task = queue.get('task-1');

      expect(task?.id).toBe('task-1');
    });

    it('should return undefined for non-existent task', () => {
      expect(queue.get('non-existent')).toBeUndefined();
    });
  });

  describe('updateStatus', () => {
    it('should update task status', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });

      queue.updateStatus('task-1', 'running');
      const task = queue.get('task-1');

      expect(task?.status).toBe('running');
      expect(task?.startedAt).toBeDefined();
    });

    it('should handle non-existent task', () => {
      // Should not throw
      queue.updateStatus('non-existent', 'running');
    });

    it('should move completed task to history', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });

      queue.updateStatus('task-1', 'completed');

      expect(queue.get('task-1')).toBeUndefined();
      expect(queue.getHistory()).toHaveLength(1);
      expect(queue.getHistory()[0].status).toBe('completed');
    });

    it('should move failed task to history', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });

      queue.updateStatus('task-1', 'failed');

      expect(queue.getHistory()).toHaveLength(1);
      expect(queue.getHistory()[0].status).toBe('failed');
    });

    it('should move cancelled task to history', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });

      queue.updateStatus('task-1', 'cancelled');

      expect(queue.getHistory()).toHaveLength(1);
      expect(queue.getHistory()[0].status).toBe('cancelled');
    });

    it('should record result data for completed task', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });

      queue.updateStatus('task-1', 'completed', { output: 'result' });
      const history = queue.getHistory();

      expect(history[0].result?.output).toBe('result');
    });
  });

  describe('remove', () => {
    it('should remove task from queue', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });

      const removed = queue.remove('task-1');

      expect(removed).toBe(true);
      expect(queue.size()).toBe(0);
    });

    it('should return false for non-existent task', () => {
      expect(queue.remove('non-existent')).toBe(false);
    });
  });

  describe('cancel', () => {
    it('should cancel a pending task', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });

      const cancelled = queue.cancel('task-1');

      expect(cancelled).toBe(true);
      expect(queue.getHistory()[0].status).toBe('cancelled');
    });

    it('should not cancel a running task', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });
      queue.updateStatus('task-1', 'running');

      const cancelled = queue.cancel('task-1');

      expect(cancelled).toBe(false);
    });

    it('should return false for non-existent task', () => {
      expect(queue.cancel('non-existent')).toBe(false);
    });
  });

  describe('getPending', () => {
    it('should return all pending tasks', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });
      queue.enqueue({ id: 'task-2', name: 'Task 2', prompt: 'test' });

      const pending = queue.getPending();

      // Both tasks are pending (not yet dequeued)
      expect(pending).toHaveLength(2);
    });

    it('should not include dequeued tasks', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });
      queue.enqueue({ id: 'task-2', name: 'Task 2', prompt: 'test' });

      queue.dequeue(); // Remove task-1

      const pending = queue.getPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('task-2');
    });
  });

  describe('getRunning', () => {
    it('should return all running tasks', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });
      queue.enqueue({ id: 'task-2', name: 'Task 2', prompt: 'test' });
      queue.updateStatus('task-1', 'running');
      queue.updateStatus('task-2', 'running');

      const running = queue.getRunning();

      expect(running).toHaveLength(2);
    });
  });

  describe('getHistory', () => {
    it('should return completed task history', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });
      queue.enqueue({ id: 'task-2', name: 'Task 2', prompt: 'test' });
      queue.updateStatus('task-1', 'completed');
      queue.updateStatus('task-2', 'failed');

      const history = queue.getHistory();

      expect(history).toHaveLength(2);
    });

    it('should trim history to maxHistorySize', () => {
      const smallQueue = new TaskQueue(5);

      for (let i = 0; i < 10; i++) {
        smallQueue.enqueue({ id: `task-${i}`, name: `Task ${i}`, prompt: 'test' });
        smallQueue.updateStatus(`task-${i}`, 'completed');
      }

      const history = smallQueue.getHistory();

      expect(history).toHaveLength(5);
      // Should keep most recent tasks
      expect(history[0].id).toBe('task-5');
    });
  });

  describe('size and isEmpty', () => {
    it('should return correct size', () => {
      expect(queue.size()).toBe(0);

      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });
      expect(queue.size()).toBe(1);

      queue.enqueue({ id: 'task-2', name: 'Task 2', prompt: 'test' });
      expect(queue.size()).toBe(2);
    });

    it('should correctly report isEmpty', () => {
      expect(queue.isEmpty()).toBe(true);

      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });
      expect(queue.isEmpty()).toBe(false);
    });
  });

  describe('hasAvailableTasks', () => {
    it('should return true when tasks are available', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });

      expect(queue.hasAvailableTasks()).toBe(true);
    });

    it('should return false when no tasks are available', () => {
      expect(queue.hasAvailableTasks()).toBe(false);
    });

    it('should return false when all tasks have unsatisfied dependencies', () => {
      queue.enqueue({
        id: 'task-1',
        name: 'Task 1',
        prompt: 'test',
        dependencies: [{ taskId: 'missing-task', type: 'sequential' }],
      });

      expect(queue.hasAvailableTasks()).toBe(false);
    });
  });

  describe('countByStatus', () => {
    it('should count tasks by status', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });
      queue.enqueue({ id: 'task-2', name: 'Task 2', prompt: 'test' });
      queue.enqueue({ id: 'task-3', name: 'Task 3', prompt: 'test' });

      queue.updateStatus('task-1', 'running');
      queue.updateStatus('task-2', 'completed');
      queue.updateStatus('task-3', 'failed');

      expect(queue.countByStatus('pending')).toBe(0);
      expect(queue.countByStatus('running')).toBe(1);
      expect(queue.countByStatus('completed')).toBe(1);
      expect(queue.countByStatus('failed')).toBe(1);
    });
  });

  describe('getDependents', () => {
    it('should return tasks that depend on a given task', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });
      queue.enqueue({
        id: 'task-2',
        name: 'Task 2',
        prompt: 'test',
        dependencies: [{ taskId: 'task-1', type: 'sequential' }],
      });

      const dependents = queue.getDependents('task-1');

      expect(dependents).toHaveLength(1);
      expect(dependents[0].id).toBe('task-2');
    });

    it('should return empty array when no dependents', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });

      expect(queue.getDependents('task-1')).toHaveLength(0);
    });
  });

  describe('clear', () => {
    it('should clear all tasks from queue', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });
      queue.enqueue({ id: 'task-2', name: 'Task 2', prompt: 'test' });

      queue.clear();

      expect(queue.size()).toBe(0);
      expect(queue.isEmpty()).toBe(true);
    });
  });

  describe('clearHistory', () => {
    it('should clear completed task history', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });
      queue.updateStatus('task-1', 'completed');

      queue.clearHistory();

      expect(queue.getHistory()).toHaveLength(0);
    });
  });

  describe('dependency resolution', () => {
    it('should allow dequeue when dependency is completed', () => {
      queue.enqueue({ id: 'task-1', name: 'Task 1', prompt: 'test' });
      queue.enqueue({
        id: 'task-2',
        name: 'Task 2',
        prompt: 'test',
        dependencies: [{ taskId: 'task-1', type: 'sequential' }],
      });

      // First dequeue gets task-1
      expect(queue.dequeue()?.id).toBe('task-1');

      // Complete task-1
      queue.updateStatus('task-1', 'completed');

      // Now task-2 should be available
      expect(queue.dequeue()?.id).toBe('task-2');
    });

    it('should handle conditional dependencies', () => {
      queue.enqueue({
        id: 'task-1',
        name: 'Task 1',
        prompt: 'test',
        dependencies: [{ taskId: 'missing-task', type: 'conditional' }],
      });

      // Conditional dependencies are skipped when not satisfied
      // So the task should still be available for dequeue
      const task = queue.dequeue();
      expect(task?.id).toBe('task-1');
    });
  });
});
