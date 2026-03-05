/**
 * Tests for TaskStateManager.
 *
 * Issue #468: 任务控制指令 - deep task 执行管理
 * Issue #734: 使用 vi.useFakeTimers() 消除时间依赖，避免 flaky test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TaskStateManager, resetTaskStateManager } from './task-state-manager.js';

describe('TaskStateManager', () => {
  let tempDir: string;
  let manager: TaskStateManager;

  beforeEach(async () => {
    // Reset singleton for each test
    resetTaskStateManager();

    // Use fake timers to ensure deterministic time-based behavior
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    // Create a temporary directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-state-test-'));
    manager = new TaskStateManager(tempDir);
  });

  afterEach(async () => {
    // Clean up the temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });
    resetTaskStateManager();

    // Restore real timers
    vi.useRealTimers();
  });

  describe('startTask', () => {
    it('should start a new task', async () => {
      const task = await manager.startTask('Test task prompt', 'oc_test_chat', 'ou_test_user');

      expect(task.id).toMatch(/^task_\d+_[a-z0-9]+$/);
      expect(task.prompt).toBe('Test task prompt');
      expect(task.status).toBe('running');
      expect(task.progress).toBe(0);
      expect(task.chatId).toBe('oc_test_chat');
      expect(task.userId).toBe('ou_test_user');
      expect(task.createdAt).toBeDefined();
      expect(task.updatedAt).toBeDefined();
    });

    it('should throw error if task already running', async () => {
      await manager.startTask('First task', 'oc_test_chat');

      await expect(manager.startTask('Second task', 'oc_test_chat'))
        .rejects.toThrow('已有任务正在执行中');
    });

    it('should allow starting new task after previous one is completed', async () => {
      await manager.startTask('First task', 'oc_test_chat');
      await manager.completeTask();

      const secondTask = await manager.startTask('Second task', 'oc_test_chat');
      expect(secondTask.prompt).toBe('Second task');
    });
  });

  describe('getCurrentTask', () => {
    it('should return null when no task is running', async () => {
      const task = await manager.getCurrentTask();
      expect(task).toBeNull();
    });

    it('should return current task', async () => {
      await manager.startTask('Test task', 'oc_test_chat');
      const task = await manager.getCurrentTask();

      expect(task).not.toBeNull();
      expect(task?.prompt).toBe('Test task');
    });
  });

  describe('updateProgress', () => {
    it('should update task progress', async () => {
      await manager.startTask('Test task', 'oc_test_chat');
      await manager.updateProgress(50, 'Processing files');

      const task = await manager.getCurrentTask();
      expect(task?.progress).toBe(50);
      expect(task?.currentStep).toBe('Processing files');
    });

    it('should clamp progress to 0-100', async () => {
      await manager.startTask('Test task', 'oc_test_chat');

      await manager.updateProgress(150);
      let task = await manager.getCurrentTask();
      expect(task?.progress).toBe(100);

      await manager.updateProgress(-10);
      task = await manager.getCurrentTask();
      expect(task?.progress).toBe(0);
    });

    it('should do nothing if no current task', async () => {
      // Should not throw
      await manager.updateProgress(50);
      const task = await manager.getCurrentTask();
      expect(task).toBeNull();
    });
  });

  describe('pauseTask', () => {
    it('should pause running task', async () => {
      await manager.startTask('Test task', 'oc_test_chat');
      const pausedTask = await manager.pauseTask();

      expect(pausedTask?.status).toBe('paused');
    });

    it('should return null if no task to pause', async () => {
      const result = await manager.pauseTask();
      expect(result).toBeNull();
    });

    it('should throw error if task is not running', async () => {
      await manager.startTask('Test task', 'oc_test_chat');
      await manager.pauseTask();

      await expect(manager.pauseTask())
        .rejects.toThrow('无法暂停');
    });
  });

  describe('resumeTask', () => {
    it('should resume paused task', async () => {
      await manager.startTask('Test task', 'oc_test_chat');
      await manager.pauseTask();

      const resumedTask = await manager.resumeTask();
      expect(resumedTask?.status).toBe('running');
    });

    it('should return null if no task to resume', async () => {
      const result = await manager.resumeTask();
      expect(result).toBeNull();
    });

    it('should throw error if task is not paused', async () => {
      await manager.startTask('Test task', 'oc_test_chat');

      await expect(manager.resumeTask())
        .rejects.toThrow('无法恢复');
    });
  });

  describe('cancelTask', () => {
    it('should cancel running task', async () => {
      await manager.startTask('Test task', 'oc_test_chat');
      const cancelledTask = await manager.cancelTask();

      expect(cancelledTask?.status).toBe('cancelled');

      // Current task should be cleared
      const currentTask = await manager.getCurrentTask();
      expect(currentTask).toBeNull();
    });

    it('should cancel paused task', async () => {
      await manager.startTask('Test task', 'oc_test_chat');
      await manager.pauseTask();

      const cancelledTask = await manager.cancelTask();
      expect(cancelledTask?.status).toBe('cancelled');
    });

    it('should return null if no task to cancel', async () => {
      const result = await manager.cancelTask();
      expect(result).toBeNull();
    });

    it('should throw error if task cannot be cancelled', async () => {
      await manager.startTask('Test task', 'oc_test_chat');
      await manager.completeTask();

      // Try to cancel a non-existent current task
      const result = await manager.cancelTask();
      expect(result).toBeNull();
    });
  });

  describe('completeTask', () => {
    it('should complete running task', async () => {
      await manager.startTask('Test task', 'oc_test_chat');
      const completedTask = await manager.completeTask();

      expect(completedTask?.status).toBe('completed');
      expect(completedTask?.progress).toBe(100);

      // Current task should be cleared
      const currentTask = await manager.getCurrentTask();
      expect(currentTask).toBeNull();
    });

    it('should return null if no task to complete', async () => {
      const result = await manager.completeTask();
      expect(result).toBeNull();
    });
  });

  describe('setTaskError', () => {
    it('should set task error', async () => {
      await manager.startTask('Test task', 'oc_test_chat');
      const errorTask = await manager.setTaskError('Something went wrong');

      expect(errorTask?.status).toBe('error');
      expect(errorTask?.error).toBe('Something went wrong');

      // Current task should be cleared
      const currentTask = await manager.getCurrentTask();
      expect(currentTask).toBeNull();
    });

    it('should return null if no task', async () => {
      const result = await manager.setTaskError('Error');
      expect(result).toBeNull();
    });
  });

  describe('listTaskHistory', () => {
    it('should return empty array when no history', async () => {
      const history = await manager.listTaskHistory();
      expect(history).toEqual([]);
    });

    it('should list completed tasks', async () => {
      // Use a fresh manager for this test
      const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-state-list-'));
      const listManager = new TaskStateManager(testDir);

      // Task 1: Create at time T
      await listManager.startTask('Task 1', 'oc_chat');
      await listManager.completeTask();

      // Advance time by 1 second to ensure different timestamps
      vi.advanceTimersByTime(1000);

      // Task 2: Create at time T+1s
      await listManager.startTask('Task 2', 'oc_chat');
      await listManager.cancelTask();

      const history = await listManager.listTaskHistory();
      expect(history.length).toBe(2);
      expect(history[0].prompt).toBe('Task 2'); // Most recent first
      expect(history[1].prompt).toBe('Task 1');

      await fs.rm(testDir, { recursive: true, force: true });
    });

    it('should respect limit parameter', async () => {
      // Use a fresh manager for this test
      const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-state-limit-'));
      const limitManager = new TaskStateManager(testDir);

      // Create 5 tasks with time advancement to ensure stable ordering
      for (let i = 0; i < 5; i++) {
        await limitManager.startTask(`Task ${i}`, 'oc_chat');
        await limitManager.completeTask();
        // Advance time by 100ms between tasks
        vi.advanceTimersByTime(100);
      }

      const history = await limitManager.listTaskHistory(3);
      expect(history.length).toBe(3);

      await fs.rm(testDir, { recursive: true, force: true });
    });
  });

  describe('persistence', () => {
    it('should persist current task to disk', async () => {
      await manager.startTask('Test task', 'oc_test_chat');

      // Create a new manager instance to test persistence
      const newManager = new TaskStateManager(tempDir);
      const task = await newManager.getCurrentTask();

      expect(task?.prompt).toBe('Test task');
    });

    it('should persist task history to disk', async () => {
      await manager.startTask('Task 1', 'oc_chat');
      await manager.completeTask();

      // Create a new manager instance
      const newManager = new TaskStateManager(tempDir);
      const history = await newManager.listTaskHistory();

      expect(history.length).toBe(1);
      expect(history[0].prompt).toBe('Task 1');
    });
  });
});
