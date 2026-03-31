/**
 * Unit tests for TaskContext
 *
 * Issue #857: Task progress tracking shared state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TaskContext,
  initTaskContext,
  getTaskContext,
  resetTaskContext,
} from './task-context.js';
import type { TaskContextEvent } from './task-context.js';

describe('TaskContext', () => {
  let ctx: TaskContext;

  beforeEach(() => {
    resetTaskContext();
    ctx = new TaskContext();
  });

  afterEach(() => {
    ctx.dispose();
    resetTaskContext();
  });

  // ==========================================================================
  // Task Registration
  // ==========================================================================

  describe('registerTask', () => {
    it('should register a new task with correct defaults', () => {
      const progress = ctx.registerTask({
        taskId: 'task-1',
        description: 'Fix bug #123',
      });

      expect(progress.taskId).toBe('task-1');
      expect(progress.description).toBe('Fix bug #123');
      expect(progress.status).toBe('pending');
      expect(progress.currentStep).toBe('Task registered');
      expect(progress.steps).toEqual([]);
      expect(progress.elapsedTime).toBe(0);
      expect(progress.registeredAt).toBeInstanceOf(Date);
      expect(progress.updatedAt).toBeInstanceOf(Date);
    });

    it('should register a task with optional fields', () => {
      const progress = ctx.registerTask({
        taskId: 'task-2',
        description: 'Refactor module',
        chatId: 'oc_xxx',
        totalEstimatedSteps: 5,
        metadata: { prNumber: 123 },
      });

      expect(progress.chatId).toBe('oc_xxx');
      expect(progress.totalEstimatedSteps).toBe(5);
      expect(progress.metadata).toEqual({ prNumber: 123 });
    });

    it('should throw if taskId is empty', () => {
      expect(() => ctx.registerTask({ taskId: '', description: 'Test' }))
        .toThrow('taskId is required');
    });

    it('should throw if task already exists', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      expect(() => ctx.registerTask({ taskId: 'task-1', description: 'Test 2' }))
        .toThrow('Task task-1 already registered');
    });

    it('should emit task:registered event', () => {
      const events: TaskContextEvent[] = [];
      ctx.onTaskEvent('all', (event) => events.push(event));

      ctx.registerTask({ taskId: 'task-1', description: 'Test' });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task:registered');
      expect(events[0].taskId).toBe('task-1');
    });
  });

  // ==========================================================================
  // Task Lifecycle
  // ==========================================================================

  describe('startTask', () => {
    it('should mark a pending task as running', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      const progress = ctx.startTask('task-1', 'Initializing...');

      expect(progress.status).toBe('running');
      expect(progress.currentStep).toBe('Initializing...');
      expect(progress.startedAt).toBeInstanceOf(Date);
    });

    it('should throw if task not found', () => {
      expect(() => ctx.startTask('nonexistent'))
        .toThrow('Task nonexistent not found');
    });

    it('should throw if task is not pending', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      ctx.startTask('task-1');
      ctx.completeTask('task-1');

      expect(() => ctx.startTask('task-1'))
        .toThrow('is not pending');
    });

    it('should emit task:started event', () => {
      const events: TaskContextEvent[] = [];
      ctx.onTaskEvent('all', (event) => events.push(event));

      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      ctx.startTask('task-1');

      expect(events).toHaveLength(2);
      expect(events[1].type).toBe('task:started');
    });
  });

  describe('updateProgress', () => {
    it('should update current step', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      const progress = ctx.updateProgress('task-1', { currentStep: 'Analyzing code...' });

      expect(progress.status).toBe('running'); // auto-started
      expect(progress.currentStep).toBe('Analyzing code...');
      expect(progress.startedAt).toBeInstanceOf(Date);
    });

    it('should add a structured step', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      const progress = ctx.updateProgress('task-1', {
        addStep: { name: 'Analyze code', status: 'running' },
      });

      expect(progress.steps).toHaveLength(1);
      expect(progress.steps[0].name).toBe('Analyze code');
      expect(progress.steps[0].status).toBe('running');
    });

    it('should update a step by name', async () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      ctx.updateProgress('task-1', {
        addStep: { name: 'Step 1', status: 'running' },
      });

      // Wait a tick for the timestamp to differ
      await new Promise(resolve => setTimeout(resolve, 10));

      const progress = ctx.updateProgress('task-1', {
        updateStep: { name: 'Step 1', status: 'completed' },
      });

      expect(progress.steps[0].status).toBe('completed');
      expect(progress.steps[0].completedAt).toBeInstanceOf(Date);
    });

    it('should update task status to failed', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      const progress = ctx.updateProgress('task-1', {
        status: 'failed',
        error: 'Test failed',
      });

      expect(progress.status).toBe('failed');
      expect(progress.error).toBe('Test failed');
      expect(progress.completedAt).toBeInstanceOf(Date);
    });

    it('should merge metadata', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test', metadata: { key1: 'value1' } });
      const progress = ctx.updateProgress('task-1', {
        metadata: { key2: 'value2' },
      });

      expect(progress.metadata).toEqual({ key1: 'value1', key2: 'value2' });
    });

    it('should throw if task not found', () => {
      expect(() => ctx.updateProgress('nonexistent', { currentStep: 'test' }))
        .toThrow('Task nonexistent not found');
    });

    it('should throw if task is already completed', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      ctx.completeTask('task-1');

      expect(() => ctx.updateProgress('task-1', { currentStep: 'test' }))
        .toThrow('Cannot update progress');
    });

    it('should emit task:progress event', () => {
      const events: TaskContextEvent[] = [];
      ctx.onTaskEvent('task:progress', (event) => events.push(event));

      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      ctx.updateProgress('task-1', { currentStep: 'Working...' });

      expect(events).toHaveLength(1);
      expect(events[0].progress.currentStep).toBe('Working...');
    });
  });

  describe('completeTask', () => {
    it('should mark task as completed', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      const progress = ctx.completeTask('task-1');

      expect(progress.status).toBe('completed');
      expect(progress.completedAt).toBeInstanceOf(Date);
      expect(progress.elapsedTime).toBeGreaterThanOrEqual(0);
    });

    it('should set result message', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      const progress = ctx.completeTask('task-1', 'All tests passed');

      expect(progress.currentStep).toBe('All tests passed');
    });

    it('should emit task:completed event', () => {
      const events: TaskContextEvent[] = [];
      ctx.onTaskEvent('task:completed', (event) => events.push(event));

      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      ctx.completeTask('task-1');

      expect(events).toHaveLength(1);
    });
  });

  describe('failTask', () => {
    it('should mark task as failed with error', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      const progress = ctx.failTask('task-1', 'Connection timeout');

      expect(progress.status).toBe('failed');
      expect(progress.error).toBe('Connection timeout');
      expect(progress.completedAt).toBeInstanceOf(Date);
    });
  });

  describe('cancelTask', () => {
    it('should mark task as cancelled', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      const progress = ctx.cancelTask('task-1', 'User cancelled');

      expect(progress.status).toBe('cancelled');
      expect(progress.error).toBe('User cancelled');
      expect(progress.completedAt).toBeInstanceOf(Date);
    });
  });

  // ==========================================================================
  // Query Methods
  // ==========================================================================

  describe('getTaskProgress', () => {
    it('should return undefined for non-existent task', () => {
      expect(ctx.getTaskProgress('nonexistent')).toBeUndefined();
    });

    it('should return progress for existing task', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      const progress = ctx.getTaskProgress('task-1');

      expect(progress).toBeDefined();
      expect(progress!.taskId).toBe('task-1');
    });
  });

  describe('getAllTasks', () => {
    it('should return all registered tasks', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test 1' });
      ctx.registerTask({ taskId: 'task-2', description: 'Test 2' });

      expect(ctx.getAllTasks()).toHaveLength(2);
    });

    it('should return empty array when no tasks', () => {
      expect(ctx.getAllTasks()).toHaveLength(0);
    });
  });

  describe('getRunningTasks', () => {
    it('should only return running tasks', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test 1' });
      ctx.registerTask({ taskId: 'task-2', description: 'Test 2' });
      ctx.updateProgress('task-1', { currentStep: 'Running' });
      ctx.completeTask('task-2');

      const running = ctx.getRunningTasks();
      expect(running).toHaveLength(1);
      expect(running[0].taskId).toBe('task-1');
    });
  });

  describe('getTasksByChatId', () => {
    it('should filter tasks by chat ID', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test 1', chatId: 'oc_aaa' });
      ctx.registerTask({ taskId: 'task-2', description: 'Test 2', chatId: 'oc_bbb' });
      ctx.registerTask({ taskId: 'task-3', description: 'Test 3', chatId: 'oc_aaa' });

      const tasks = ctx.getTasksByChatId('oc_aaa');
      expect(tasks).toHaveLength(2);
    });
  });

  describe('getSummary', () => {
    it('should return correct counts', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test 1' });
      ctx.registerTask({ taskId: 'task-2', description: 'Test 2' });
      ctx.registerTask({ taskId: 'task-3', description: 'Test 3' });
      ctx.updateProgress('task-1', { currentStep: 'Running' });
      ctx.completeTask('task-2');
      ctx.failTask('task-3', 'Error');

      const summary = ctx.getSummary();
      expect(summary).toEqual({
        total: 3,
        pending: 0,
        running: 1,
        completed: 1,
        failed: 1,
        cancelled: 0,
      });
    });
  });

  describe('getProgressPercentage', () => {
    it('should return 0 for pending task', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      expect(ctx.getProgressPercentage('task-1')).toBe(0);
    });

    it('should return 100 for completed task', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      ctx.completeTask('task-1');
      expect(ctx.getProgressPercentage('task-1')).toBe(100);
    });

    it('should return 50 for running task without steps', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      ctx.updateProgress('task-1', { currentStep: 'Running' });
      expect(ctx.getProgressPercentage('task-1')).toBe(50);
    });

    it('should calculate from structured steps', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      ctx.updateProgress('task-1', { addStep: { name: 'Step 1', status: 'completed' } });
      ctx.updateProgress('task-1', { addStep: { name: 'Step 2', status: 'running' } });
      ctx.updateProgress('task-1', { addStep: { name: 'Step 3', status: 'pending' } });

      expect(ctx.getProgressPercentage('task-1')).toBe(33); // 1/3 ≈ 33%
    });

    it('should return 0 for non-existent task', () => {
      expect(ctx.getProgressPercentage('nonexistent')).toBe(0);
    });
  });

  // ==========================================================================
  // Event Handling
  // ==========================================================================

  describe('onTaskEvent', () => {
    it('should filter events by type', () => {
      const progressEvents: TaskContextEvent[] = [];
      ctx.onTaskEvent('task:progress', (event) => progressEvents.push(event));

      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      ctx.updateProgress('task-1', { currentStep: 'Running' });

      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0].type).toBe('task:progress');
    });

    it('should receive all events with "all" type', () => {
      const allEvents: TaskContextEvent[] = [];
      ctx.onTaskEvent('all', (event) => allEvents.push(event));

      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      ctx.updateProgress('task-1', { currentStep: 'Running' });
      ctx.completeTask('task-1');

      expect(allEvents).toHaveLength(3);
    });

    it('should unsubscribe correctly', () => {
      const events: TaskContextEvent[] = [];
      const unsub = ctx.onTaskEvent('all', (event) => events.push(event));

      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      unsub();
      ctx.registerTask({ taskId: 'task-2', description: 'Test 2' });

      expect(events).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  describe('cleanup', () => {
    it('should remove old completed tasks', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      ctx.completeTask('task-1');

      // Manually set completedAt to the past
      const progress = ctx.getTaskProgress('task-1')!;
      progress.completedAt = new Date(Date.now() - 7200000); // 2 hours ago

      const cleaned = ctx.cleanup(3600000); // 1 hour max
      expect(cleaned).toBe(1);
      expect(ctx.getTaskProgress('task-1')).toBeUndefined();
    });

    it('should not remove recent tasks', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      ctx.completeTask('task-1');

      const cleaned = ctx.cleanup(3600000);
      expect(cleaned).toBe(0);
      expect(ctx.getTaskProgress('task-1')).toBeDefined();
    });
  });

  describe('removeTask', () => {
    it('should remove a specific task', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test' });
      expect(ctx.removeTask('task-1')).toBe(true);
      expect(ctx.getTaskProgress('task-1')).toBeUndefined();
    });

    it('should return false for non-existent task', () => {
      expect(ctx.removeTask('nonexistent')).toBe(false);
    });
  });

  describe('clear', () => {
    it('should remove all tasks', () => {
      ctx.registerTask({ taskId: 'task-1', description: 'Test 1' });
      ctx.registerTask({ taskId: 'task-2', description: 'Test 2' });
      ctx.clear();
      expect(ctx.getAllTasks()).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Max Tasks Limit
  // ==========================================================================

  describe('max tasks limit', () => {
    it('should evict oldest completed tasks when limit reached', () => {
      const smallCtx = new TaskContext(3);

      smallCtx.registerTask({ taskId: 'task-1', description: 'Test 1' });
      smallCtx.completeTask('task-1');

      smallCtx.registerTask({ taskId: 'task-2', description: 'Test 2' });
      smallCtx.completeTask('task-2');

      smallCtx.registerTask({ taskId: 'task-3', description: 'Test 3' });

      // This should trigger eviction of oldest completed task
      smallCtx.registerTask({ taskId: 'task-4', description: 'Test 4' });

      // task-1 should be evicted (oldest completed)
      expect(smallCtx.getTaskProgress('task-1')).toBeUndefined();
      // task-4 should exist
      expect(smallCtx.getTaskProgress('task-4')).toBeDefined();

      smallCtx.dispose();
    });
  });

  // ==========================================================================
  // Global Singleton
  // ==========================================================================

  describe('global singleton', () => {
    afterEach(() => {
      resetTaskContext();
    });

    it('should return undefined before initialization', () => {
      expect(getTaskContext()).toBeUndefined();
    });

    it('should initialize and return the same instance', () => {
      const ctx1 = initTaskContext();
      const ctx2 = getTaskContext();
      expect(ctx1).toBe(ctx2);
    });

    it('should create new instance on re-initialization', () => {
      const ctx1 = initTaskContext();
      const ctx2 = initTaskContext();
      expect(ctx1).not.toBe(ctx2);
      expect(getTaskContext()).toBe(ctx2);
    });

    it('should reset to undefined', () => {
      initTaskContext();
      resetTaskContext();
      expect(getTaskContext()).toBeUndefined();
    });
  });
});
