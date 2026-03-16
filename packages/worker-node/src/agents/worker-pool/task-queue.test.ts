/**
 * Tests for Task Queue - Priority-based task queue with dependency resolution.
 *
 * Issue #897: Support master-workers multi-agent collaboration pattern.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskQueue } from './task-queue.js';
import type { TaskOptions, TaskPriority } from './types.js';

// Mock callbacks for testing
const mockCallbacks = {
  sendMessage: async () => {},
  sendCard: async () => {},
  sendFile: async () => {},
  sendInteractiveMessage: async () => {},
};

describe('TaskQueue', () => {
  let queue: TaskQueue;

  beforeEach(() => {
    queue = new TaskQueue(100);
  });

  afterEach(() => {
    queue.clear();
  });

  describe('enqueue', () => {
    it('should add a task to the queue', () => {
      const options: TaskOptions = {
        id: 'task-1',
        name: 'Test Task',
        prompt: 'Do something',
        chatId: 'chat-123',
        callbacks: mockCallbacks,
      };

      const task = queue.enqueue(options);

      expect(task.id).toBe('task-1');
      expect(task.name).toBe('Test Task');
      expect(task.status).toBe('pending');
      expect(task.priority).toBe('normal');
      expect(task.timeout).toBe(300000);
      expect(task.maxRetries).toBe(0);
    });

    it('should set default values for optional fields', () => {
      const task = queue.enqueue({
        id: 'task-1',
        name: 'Test',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: mockCallbacks,
      });

      expect(task.priority).toBe('normal');
      expect(task.timeout).toBe(300000);
      expect(task.maxRetries).toBe(0);
      expect(task.dependencies).toEqual([]);
    });

    it('should respect custom options', () => {
      const task = queue.enqueue({
        id: 'task-1',
        name: 'Test',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: mockCallbacks,
        priority: 'high',
        timeout: 60000,
        maxRetries: 3,
        dependencies: [{ taskId: 'task-0', type: 'sequential' }],
      });

      expect(task.priority).toBe('high');
      expect(task.timeout).toBe(60000);
      expect(task.maxRetries).toBe(3);
      expect(task.dependencies).toHaveLength(1);
    });
  });

  describe('enqueueBatch', () => {
    it('should add multiple tasks to the queue', () => {
      const tasks = queue.enqueueBatch([
        { id: 'task-1', name: 'Task 1', prompt: 'A', chatId: 'c1', callbacks: mockCallbacks },
        { id: 'task-2', name: 'Task 2', prompt: 'B', chatId: 'c2', callbacks: mockCallbacks },
        { id: 'task-3', name: 'Task 3', prompt: 'C', chatId: 'c3', callbacks: mockCallbacks },
      ]);

      expect(tasks).toHaveLength(3);
      expect(queue.size()).toBe(3);
    });
  });

  describe('dequeue', () => {
    it('should return the highest priority task', () => {
      queue.enqueue({
        id: 'low-task',
        name: 'Low',
        prompt: 'Low priority',
        chatId: 'c1',
        callbacks: mockCallbacks,
        priority: 'low',
      });

      queue.enqueue({
        id: 'high-task',
        name: 'High',
        prompt: 'High priority',
        chatId: 'c2',
        callbacks: mockCallbacks,
        priority: 'high',
      });

      queue.enqueue({
        id: 'normal-task',
        name: 'Normal',
        prompt: 'Normal priority',
        chatId: 'c3',
        callbacks: mockCallbacks,
        priority: 'normal',
      });

      const task = queue.dequeue();
      expect(task?.id).toBe('high-task');
    });

    it('should return undefined when queue is empty', () => {
      expect(queue.dequeue()).toBeUndefined();
    });

    it('should respect critical priority', () => {
      queue.enqueue({
        id: 'high-task',
        name: 'High',
        prompt: 'High',
        chatId: 'c1',
        callbacks: mockCallbacks,
        priority: 'high',
      });

      queue.enqueue({
        id: 'critical-task',
        name: 'Critical',
        prompt: 'Critical',
        chatId: 'c2',
        callbacks: mockCallbacks,
        priority: 'critical',
      });

      expect(queue.dequeue()?.id).toBe('critical-task');
    });
  });

  describe('peek', () => {
    it('should return the next task without removing it', () => {
      queue.enqueue({
        id: 'task-1',
        name: 'Task 1',
        prompt: 'Test',
        chatId: 'c1',
        callbacks: mockCallbacks,
      });

      const task = queue.peek();
      expect(task?.id).toBe('task-1');
      expect(queue.size()).toBe(1);
    });
  });

  describe('updateStatus', () => {
    it('should update task status', () => {
      queue.enqueue({
        id: 'task-1',
        name: 'Task 1',
        prompt: 'Test',
        chatId: 'c1',
        callbacks: mockCallbacks,
      });

      queue.updateStatus('task-1', 'running');
      const task = queue.get('task-1');
      expect(task?.status).toBe('running');
      expect(task?.startedAt).toBeDefined();
    });

    it('should move completed tasks to history', () => {
      queue.enqueue({
        id: 'task-1',
        name: 'Task 1',
        prompt: 'Test',
        chatId: 'c1',
        callbacks: mockCallbacks,
      });

      queue.updateStatus('task-1', 'completed', { output: 'Done' });

      expect(queue.get('task-1')).toBeUndefined();
      const history = queue.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].result?.status).toBe('completed');
      expect(history[0].result?.output).toBe('Done');
    });
  });

  describe('remove', () => {
    it('should remove a task from the queue', () => {
      queue.enqueue({
        id: 'task-1',
        name: 'Task 1',
        prompt: 'Test',
        chatId: 'c1',
        callbacks: mockCallbacks,
      });

      expect(queue.remove('task-1')).toBe(true);
      expect(queue.size()).toBe(0);
    });

    it('should return false if task not found', () => {
      expect(queue.remove('nonexistent')).toBe(false);
    });
  });

  describe('cancel', () => {
    it('should cancel a pending task', () => {
      queue.enqueue({
        id: 'task-1',
        name: 'Task 1',
        prompt: 'Test',
        chatId: 'c1',
        callbacks: mockCallbacks,
      });

      expect(queue.cancel('task-1')).toBe(true);
      const history = queue.getHistory();
      expect(history[0].status).toBe('cancelled');
    });

    it('should not cancel a running task', () => {
      queue.enqueue({
        id: 'task-1',
        name: 'Task 1',
        prompt: 'Test',
        chatId: 'c1',
        callbacks: mockCallbacks,
      });

      queue.updateStatus('task-1', 'running');
      expect(queue.cancel('task-1')).toBe(false);
    });
  });

  describe('query methods', () => {
    beforeEach(() => {
      queue.enqueueBatch([
        { id: 'task-1', name: 'T1', prompt: 'A', chatId: 'c1', callbacks: mockCallbacks, priority: 'high' },
        { id: 'task-2', name: 'T2', prompt: 'B', chatId: 'c2', callbacks: mockCallbacks, priority: 'low' },
        { id: 'task-3', name: 'T3', prompt: 'C', chatId: 'c3', callbacks: mockCallbacks, priority: 'normal' },
      ]);
    });

    it('should return pending tasks', () => {
      const pending = queue.getPending();
      expect(pending).toHaveLength(3);
    });

    it('should return running tasks', () => {
      queue.updateStatus('task-1', 'running');
      const running = queue.getRunning();
      expect(running).toHaveLength(1);
      expect(running[0].id).toBe('task-1');
    });

    it('should count tasks by status', () => {
      queue.updateStatus('task-1', 'running');
      expect(queue.countByStatus('pending')).toBe(2);
      expect(queue.countByStatus('running')).toBe(1);
    });

    it('should check if queue is empty', () => {
      expect(queue.isEmpty()).toBe(false);
      queue.dequeue();
      queue.dequeue();
      queue.dequeue();
      expect(queue.isEmpty()).toBe(true);
    });
  });

  describe('dependencies', () => {
    it('should not dequeue tasks with unsatisfied dependencies', () => {
      // Add dependency first (but it will complete later)
      queue.enqueue({
        id: 'task-1',
        name: 'First',
        prompt: 'First task',
        chatId: 'c1',
        callbacks: mockCallbacks,
      });

      // Add dependent task
      queue.enqueue({
        id: 'task-2',
        name: 'Second',
        prompt: 'Second task',
        chatId: 'c2',
        callbacks: mockCallbacks,
        dependencies: [{ taskId: 'task-1', type: 'sequential' }],
      });

      // First dequeue should return task-1 (no dependencies)
      const first = queue.dequeue();
      expect(first?.id).toBe('task-1');

      // Second dequeue should return undefined (task-2 depends on task-1)
      expect(queue.dequeue()).toBeUndefined();

      // Complete task-1
      queue.updateStatus('task-1', 'completed');

      // Now task-2 should be available
      const second = queue.dequeue();
      expect(second?.id).toBe('task-2');
    });

    it('should find dependent tasks', () => {
      queue.enqueue({
        id: 'task-1',
        name: 'First',
        prompt: 'First',
        chatId: 'c1',
        callbacks: mockCallbacks,
      });

      queue.enqueue({
        id: 'task-2',
        name: 'Second',
        prompt: 'Second',
        chatId: 'c2',
        callbacks: mockCallbacks,
        dependencies: [{ taskId: 'task-1', type: 'sequential' }],
      });

      const dependents = queue.getDependents('task-1');
      expect(dependents).toHaveLength(1);
      expect(dependents[0].id).toBe('task-2');
    });
  });

  describe('priority ordering', () => {
    it('should order tasks by priority', () => {
      const priorities: TaskPriority[] = ['low', 'high', 'normal', 'critical', 'low'];

      for (let i = 0; i < priorities.length; i++) {
        queue.enqueue({
          id: `task-${i}`,
          name: `Task ${i}`,
          prompt: `Priority: ${priorities[i]}`,
          chatId: 'c1',
          callbacks: mockCallbacks,
          priority: priorities[i],
        });
      }

      const expectedOrder = ['critical', 'high', 'normal', 'low', 'low'];
      const actualOrder: string[] = [];

      while (!queue.isEmpty()) {
        const task = queue.dequeue();
        if (task && task.priority) {actualOrder.push(task.priority);}
      }

      expect(actualOrder).toEqual(expectedOrder);
    });
  });

  describe('history', () => {
    it('should limit history size', () => {
      const smallQueue = new TaskQueue(5);

      for (let i = 0; i < 10; i++) {
        smallQueue.enqueue({
          id: `task-${i}`,
          name: `Task ${i}`,
          prompt: 'Test',
          chatId: 'c1',
          callbacks: mockCallbacks,
        });
        smallQueue.updateStatus(`task-${i}`, 'completed');
      }

      expect(smallQueue.getHistory()).toHaveLength(5);
    });
  });
});
