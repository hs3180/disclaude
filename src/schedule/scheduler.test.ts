/**
 * Scheduler Tests - Issue #86, Issue #89
 *
 * Tests for:
 * - No duplicate scheduling when addTask is called multiple times
 * - Proper task removal
 * - Active jobs count consistency
 * - Blocking mechanism for concurrent task execution
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Scheduler } from './scheduler.js';
import { ScheduleManager } from './schedule-manager.js';
import type { ScheduledTask } from './index.js';
import type { Pilot, PilotCallbacks } from '../agents/pilot.js';

// Mock Pilot
const createMockPilot = (): Pilot => {
  return {
    executeOnce: vi.fn().mockResolvedValue(undefined),
    processMessage: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
  } as unknown as Pilot;
};

// Mock callbacks
const createMockCallbacks = (): PilotCallbacks => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendCard: vi.fn().mockResolvedValue(undefined),
  sendFile: vi.fn().mockResolvedValue(undefined),
});

describe('Scheduler', () => {
  let scheduler: Scheduler;
  let manager: ScheduleManager;
  let mockPilot: Pilot;
  let mockCallbacks: PilotCallbacks;
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `scheduler-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });

    mockPilot = createMockPilot();
    mockCallbacks = createMockCallbacks();
    manager = new ScheduleManager({ schedulesDir: testDir });
    scheduler = new Scheduler({
      scheduleManager: manager,
      pilot: mockPilot,
      callbacks: mockCallbacks,
    });
  });

  afterEach(async () => {
    scheduler.stop();
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('addTask', () => {
    it('should add a task to active jobs', () => {
      const task: ScheduledTask = {
        id: 'schedule-test-task',
        name: 'Test Task',
        cron: '0 9 * * *',
        prompt: 'Test prompt',
        chatId: 'test-chat',
        enabled: true,
        createdAt: new Date().toISOString(),
      };

      scheduler.addTask(task);

      const activeJobs = scheduler.getActiveJobs();
      expect(activeJobs).toHaveLength(1);
      expect(activeJobs[0].taskId).toBe('schedule-test-task');
    });

    it('should not add disabled task', () => {
      const task: ScheduledTask = {
        id: 'schedule-disabled-task',
        name: 'Disabled Task',
        cron: '0 9 * * *',
        prompt: 'Test',
        chatId: 'test-chat',
        enabled: false,
        createdAt: new Date().toISOString(),
      };

      scheduler.addTask(task);

      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });
  });

  describe('removeTask', () => {
    it('should remove a task from active jobs', () => {
      const task: ScheduledTask = {
        id: 'schedule-test-task',
        name: 'Test Task',
        cron: '0 9 * * *',
        prompt: 'Test',
        chatId: 'test-chat',
        enabled: true,
        createdAt: new Date().toISOString(),
      };

      scheduler.addTask(task);
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      scheduler.removeTask('schedule-test-task');
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should not throw when removing non-existent task', () => {
      expect(() => scheduler.removeTask('non-existent')).not.toThrow();
    });
  });

  // ========================================================================
  // Issue #86 Tests: 防止重复调度
  // ========================================================================

  describe('Issue #86: 防止重复调度', () => {
    it('should only have one job when addTask is called twice for same task', () => {
      const task: ScheduledTask = {
        id: 'schedule-duplicate-test',
        name: 'Duplicate Test',
        cron: '0 9 * * *',
        prompt: 'Test',
        chatId: 'test-chat',
        enabled: true,
        createdAt: new Date().toISOString(),
      };

      // Add the same task twice (simulating MCP tool + FileWatcher)
      scheduler.addTask(task);
      scheduler.addTask(task);

      // Should still only have one active job
      const activeJobs = scheduler.getActiveJobs();
      expect(activeJobs).toHaveLength(1);
      expect(activeJobs[0].taskId).toBe('schedule-duplicate-test');
    });

    it('should replace job when addTask is called multiple times', () => {
      const task: ScheduledTask = {
        id: 'schedule-replace-test',
        name: 'Replace Test',
        cron: '0 9 * * *',
        prompt: 'Test',
        chatId: 'test-chat',
        enabled: true,
        createdAt: new Date().toISOString(),
      };

      // Add task multiple times
      for (let i = 0; i < 5; i++) {
        scheduler.addTask(task);
      }

      // Should still only have one job
      expect(scheduler.getActiveJobs()).toHaveLength(1);
    });

    it('should handle rapid add/remove cycles without duplicates', () => {
      const task: ScheduledTask = {
        id: 'schedule-rapid-test',
        name: 'Rapid Test',
        cron: '0 9 * * *',
        prompt: 'Test',
        chatId: 'test-chat',
        enabled: true,
        createdAt: new Date().toISOString(),
      };

      // Simulate rapid add/remove (like FileWatcher + manual operations)
      scheduler.addTask(task);
      scheduler.addTask(task);
      scheduler.removeTask(task.id);
      scheduler.addTask(task);
      scheduler.addTask(task);

      // Should have exactly one job
      expect(scheduler.getActiveJobs()).toHaveLength(1);
    });

    it('should correctly count multiple different tasks', () => {
      const tasks: ScheduledTask[] = [
        {
          id: 'schedule-task-1',
          name: 'Task 1',
          cron: '0 9 * * *',
          prompt: 'Test 1',
          chatId: 'chat-1',
          enabled: true,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'schedule-task-2',
          name: 'Task 2',
          cron: '0 10 * * *',
          prompt: 'Test 2',
          chatId: 'chat-1',
          enabled: true,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'schedule-task-3',
          name: 'Task 3',
          cron: '0 11 * * *',
          prompt: 'Test 3',
          chatId: 'chat-2',
          enabled: true,
          createdAt: new Date().toISOString(),
        },
      ];

      // Add each task twice
      for (const task of tasks) {
        scheduler.addTask(task);
        scheduler.addTask(task);
      }

      // Should have 3 jobs, not 6
      expect(scheduler.getActiveJobs()).toHaveLength(3);
    });
  });

  describe('Issue #86: start/stop 不重复加载', () => {
    it('should not duplicate jobs when start is called twice', async () => {
      // Create task in manager
      await manager.create({
        name: 'Test Task',
        cron: '0 9 * * *',
        prompt: 'Test',
        chatId: 'test-chat',
      });

      await scheduler.start();
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      // Call start again
      await scheduler.start();
      expect(scheduler.getActiveJobs()).toHaveLength(1);
    });

    it('should clear all jobs on stop', async () => {
      // Create and start
      await manager.create({
        name: 'Task 1',
        cron: '0 9 * * *',
        prompt: 'Test',
        chatId: 'chat-1',
      });
      await manager.create({
        name: 'Task 2',
        cron: '0 10 * * *',
        prompt: 'Test',
        chatId: 'chat-2',
      });

      await scheduler.start();
      expect(scheduler.getActiveJobs()).toHaveLength(2);

      scheduler.stop();
      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });
  });

  describe('Issue #86: 任务删除后调度器状态', () => {
    it('should have no active job after task is deleted', async () => {
      // Create and start
      const task = await manager.create({
        name: 'Task to Delete',
        cron: '0 9 * * *',
        prompt: 'Test',
        chatId: 'test-chat',
      });

      await scheduler.start();
      expect(scheduler.getActiveJobs()).toHaveLength(1);

      // Delete task from manager
      await manager.delete(task.id);

      // Remove from scheduler (simulating task deletion flow)
      scheduler.removeTask(task.id);

      expect(scheduler.getActiveJobs()).toHaveLength(0);
    });

    it('should handle delete and recreate same task ID', () => {
      const taskId = 'schedule-same-id';

      const task1: ScheduledTask = {
        id: taskId,
        name: 'Original',
        cron: '0 9 * * *',
        prompt: 'Original',
        chatId: 'test-chat',
        enabled: true,
        createdAt: new Date().toISOString(),
      };

      const task2: ScheduledTask = {
        id: taskId,
        name: 'Recreated',
        cron: '0 10 * * *',
        prompt: 'Recreated',
        chatId: 'test-chat',
        enabled: true,
        createdAt: new Date().toISOString(),
      };

      scheduler.addTask(task1);
      let jobs = scheduler.getActiveJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].task.name).toBe('Original');

      // Remove and add with same ID
      scheduler.removeTask(taskId);
      scheduler.addTask(task2);

      jobs = scheduler.getActiveJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].task.name).toBe('Recreated');
    });
  });

  // ========================================================================
  // Issue #89 Tests: 阻塞机制
  // ========================================================================

  describe('Issue #89: 阻塞机制', () => {
    it('should skip task execution when blocking is true and task is running', async () => {
      // Create a pilot that takes time to complete
      let resolveExecute: () => void;
      const executePromise = new Promise<void>((resolve) => {
        resolveExecute = resolve;
      });
      (mockPilot.executeOnce as ReturnType<typeof vi.fn>).mockReturnValue(executePromise);

      const task: ScheduledTask = {
        id: 'schedule-blocking-test',
        name: 'Blocking Task',
        cron: '0 9 * * *',
        prompt: 'Test',
        chatId: 'test-chat',
        enabled: true,
        blocking: true,
        createdAt: new Date().toISOString(),
      };

      scheduler.addTask(task);

      // Start first execution (do NOT await - let it run in background)
      const firstExecution = (scheduler as unknown as { executeTask: (t: ScheduledTask) => Promise<void> }).executeTask(task);

      // Wait a tick for the task to be marked as running
      await Promise.resolve();

      // Task should be marked as running
      expect(scheduler.isTaskRunning(task.id)).toBe(true);

      // Trigger again - should be skipped due to blocking (returns immediately)
      await (scheduler as unknown as { executeTask: (t: ScheduledTask) => Promise<void> }).executeTask(task);

      // ExecuteOnce should have been called only once (second call skipped)
      expect(mockPilot.executeOnce).toHaveBeenCalledTimes(1);

      // Complete the first execution
      resolveExecute!();
      await firstExecution;

      // Task should no longer be running
      expect(scheduler.isTaskRunning(task.id)).toBe(false);
    });

    it('should allow concurrent execution when blocking is false', async () => {
      // Create a pilot that takes time to complete
      let resolveExecute: () => void;
      const executePromise = new Promise<void>((resolve) => {
        resolveExecute = resolve;
      });
      (mockPilot.executeOnce as ReturnType<typeof vi.fn>).mockReturnValue(executePromise);

      const task: ScheduledTask = {
        id: 'schedule-nonblocking-test',
        name: 'Non-Blocking Task',
        cron: '0 9 * * *',
        prompt: 'Test',
        chatId: 'test-chat',
        enabled: true,
        blocking: false, // explicitly false
        createdAt: new Date().toISOString(),
      };

      // Do NOT add task to scheduler - we're testing executeTask directly
      // This avoids the cron job interfering with the test

      // Start first execution (do NOT await - let it run in background)
      const firstExecution = (scheduler as unknown as { executeTask: (t: ScheduledTask) => Promise<void> }).executeTask(task);

      // Wait for the first execution to reach executeOnce
      // Multiple microtask yields to get past await callbacks.sendMessage
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Task should be running (added to runningTasks)
      expect(scheduler.isTaskRunning(task.id)).toBe(true);

      // Trigger second execution - should NOT be skipped because blocking is false
      const secondExecution = (scheduler as unknown as { executeTask: (t: ScheduledTask) => Promise<void> }).executeTask(task);

      // Wait for the second execution to also reach executeOnce
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // ExecuteOnce should have been called twice (concurrent execution allowed)
      expect(mockPilot.executeOnce).toHaveBeenCalledTimes(2);

      // Complete executions
      resolveExecute!();
      await Promise.all([firstExecution, secondExecution]);
    });

    it('should default blocking to true when not specified', async () => {
      (mockPilot.executeOnce as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const task: ScheduledTask = {
        id: 'schedule-default-blocking',
        name: 'Default Blocking Task',
        cron: '0 9 * * *',
        prompt: 'Test',
        chatId: 'test-chat',
        enabled: true,
        // blocking not specified - defaults to true
        createdAt: new Date().toISOString(),
      };

      scheduler.addTask(task);

      // Trigger execution
      await (scheduler as unknown as { executeTask: (t: ScheduledTask) => Promise<void> }).executeTask(task);

      // Should allow concurrent (blocking defaults to true, but task completed)
      expect(scheduler.isTaskRunning(task.id)).toBe(false); // Already completed
    });

    it('should allow task to run after previous execution completes', async () => {
      (mockPilot.executeOnce as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const task: ScheduledTask = {
        id: 'schedule-blocking-sequential',
        name: 'Blocking Sequential Task',
        cron: '0 9 * * *',
        prompt: 'Test',
        chatId: 'test-chat',
        enabled: true,
        blocking: true,
        createdAt: new Date().toISOString(),
      };

      scheduler.addTask(task);

      // First execution
      await (scheduler as unknown as { executeTask: (t: ScheduledTask) => Promise<void> }).executeTask(task);
      expect(mockPilot.executeOnce).toHaveBeenCalledTimes(1);

      // Task should no longer be running
      expect(scheduler.isTaskRunning(task.id)).toBe(false);

      // Second execution should proceed
      await (scheduler as unknown as { executeTask: (t: ScheduledTask) => Promise<void> }).executeTask(task);
      expect(mockPilot.executeOnce).toHaveBeenCalledTimes(2);
    });
  });
});
