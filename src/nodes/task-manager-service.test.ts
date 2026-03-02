/**
 * Tests for TaskManagerService.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TaskManagerService } from './task-manager-service.js';

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/tmp/test-workspace-task-manager',
  },
}));

describe('TaskManagerService', () => {
  let service: TaskManagerService;
  let tempDir: string;

  beforeEach(async () => {
    // Create unique temp directory for each test
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'task-manager-test-'));
    service = new TaskManagerService({ baseDir: tempDir });
  });

  afterEach(async () => {
    // Cleanup temp directory
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('startTask', () => {
    it('should start a new task', async () => {
      const task = await service.startTask('Test task prompt', 'chat-123');

      expect(task).toBeDefined();
      expect(task.id).toMatch(/^task_/);
      expect(task.prompt).toBe('Test task prompt');
      expect(task.status).toBe('running');
      expect(task.progress).toBe(0);
      expect(task.chatId).toBe('chat-123');
      expect(task.createdAt).toBeDefined();
      expect(task.updatedAt).toBeDefined();
    });

    it('should cancel existing running task when starting new one', async () => {
      const task1 = await service.startTask('First task', 'chat-123');
      const task2 = await service.startTask('Second task', 'chat-456');

      const status = await service.getStatus();
      expect(status).toBeDefined();
      expect(status?.id).toBe(task2.id);

      const history = await service.listHistory();
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe(task1.id);
      expect(history[0].status).toBe('cancelled');
    });
  });

  describe('getStatus', () => {
    it('should return null when no current task', async () => {
      const status = await service.getStatus();
      expect(status).toBeNull();
    });

    it('should return current task status', async () => {
      await service.startTask('Test task', 'chat-123');
      const status = await service.getStatus();

      expect(status).toBeDefined();
      expect(status?.prompt).toBe('Test task');
    });
  });

  describe('listHistory', () => {
    it('should return empty history initially', async () => {
      const history = await service.listHistory();
      expect(history).toEqual([]);
    });

    it('should return task history after tasks are completed', async () => {
      await service.startTask('Task 1', 'chat-123');
      await service.completeTask('Done');

      await service.startTask('Task 2', 'chat-456');
      await service.completeTask('Done');

      const history = await service.listHistory();
      expect(history).toHaveLength(2);
      expect(history[0].prompt).toBe('Task 2'); // Most recent first
      expect(history[1].prompt).toBe('Task 1');
    });

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 15; i++) {
        await service.startTask(`Task ${i}`, 'chat-123');
        await service.completeTask('Done');
      }

      const history = await service.listHistory(5);
      expect(history).toHaveLength(5);
    });
  });

  describe('cancelTask', () => {
    it('should cancel running task', async () => {
      await service.startTask('Test task', 'chat-123');
      const cancelled = await service.cancelTask();

      expect(cancelled).toBeDefined();
      expect(cancelled?.status).toBe('cancelled');

      const status = await service.getStatus();
      expect(status).toBeNull();
    });

    it('should return null when no task to cancel', async () => {
      const cancelled = await service.cancelTask();
      expect(cancelled).toBeNull();
    });
  });

  describe('pauseTask', () => {
    it('should pause running task', async () => {
      await service.startTask('Test task', 'chat-123');
      const paused = await service.pauseTask();

      expect(paused).toBeDefined();
      expect(paused?.status).toBe('paused');

      const status = await service.getStatus();
      expect(status?.status).toBe('paused');
    });

    it('should return null when no running task', async () => {
      const paused = await service.pauseTask();
      expect(paused).toBeNull();
    });
  });

  describe('resumeTask', () => {
    it('should resume paused task', async () => {
      await service.startTask('Test task', 'chat-123');
      await service.pauseTask();

      const resumed = await service.resumeTask();
      expect(resumed).toBeDefined();
      expect(resumed?.status).toBe('running');

      const status = await service.getStatus();
      expect(status?.status).toBe('running');
    });

    it('should return null when no paused task', async () => {
      const resumed = await service.resumeTask();
      expect(resumed).toBeNull();
    });
  });

  describe('updateProgress', () => {
    it('should update task progress', async () => {
      await service.startTask('Test task', 'chat-123');
      await service.updateProgress(50);

      const status = await service.getStatus();
      expect(status?.progress).toBe(50);
    });

    it('should clamp progress to 0-100', async () => {
      await service.startTask('Test task', 'chat-123');

      await service.updateProgress(150);
      expect((await service.getStatus())?.progress).toBe(100);

      await service.updateProgress(-10);
      expect((await service.getStatus())?.progress).toBe(0);
    });
  });

  describe('completeTask', () => {
    it('should complete task with result', async () => {
      await service.startTask('Test task', 'chat-123');
      const completed = await service.completeTask('Task completed successfully');

      expect(completed).toBeDefined();
      expect(completed?.status).toBe('completed');
      expect(completed?.progress).toBe(100);
      expect(completed?.result).toBe('Task completed successfully');

      const status = await service.getStatus();
      expect(status).toBeNull();
    });
  });

  describe('failTask', () => {
    it('should fail task with error', async () => {
      await service.startTask('Test task', 'chat-123');
      const failed = await service.failTask('Something went wrong');

      expect(failed).toBeDefined();
      expect(failed?.status).toBe('cancelled');
      expect(failed?.error).toBe('Something went wrong');

      const status = await service.getStatus();
      expect(status).toBeNull();
    });
  });

  describe('persistence', () => {
    it('should persist tasks to file', async () => {
      await service.startTask('Test task', 'chat-123');

      // Create new service instance to load from disk
      const service2 = new TaskManagerService({ baseDir: tempDir });
      const status = await service2.getStatus();

      expect(status).toBeDefined();
      expect(status?.prompt).toBe('Test task');
    });

    it('should not restore completed tasks as current', async () => {
      await service.startTask('Test task', 'chat-123');
      await service.completeTask('Done');

      // Create new service instance
      const service2 = new TaskManagerService({ baseDir: tempDir });
      const status = await service2.getStatus();

      expect(status).toBeNull();
    });

    it('should restore paused tasks as current', async () => {
      await service.startTask('Test task', 'chat-123');
      await service.pauseTask();

      // Create new service instance
      const service2 = new TaskManagerService({ baseDir: tempDir });
      const status = await service2.getStatus();

      expect(status).toBeDefined();
      expect(status?.status).toBe('paused');
    });
  });

  describe('getCurrentTask', () => {
    it('should return current task synchronously', async () => {
      const task = await service.startTask('Test task', 'chat-123');
      const current = service.getCurrentTask();

      expect(current).toBeDefined();
      expect(current?.id).toBe(task.id);
    });
  });
});
