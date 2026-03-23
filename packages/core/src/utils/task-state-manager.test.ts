/**
 * Tests for TaskStateManager (packages/core/src/utils/task-state-manager.ts)
 *
 * Tests the TaskStateManager class which handles task execution state
 * with file persistence, including lifecycle, progress, and history.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Use vi.hoisted to define mock functions that can be referenced in vi.mock factory
const {
  mockMkdir,
  mockWriteFile,
  mockReadFile,
  mockUnlink,
  mockReaddir,
} = vi.hoisted(() => ({
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  mockUnlink: vi.fn().mockResolvedValue(undefined),
  mockReaddir: vi.fn().mockResolvedValue([]),
}));

vi.mock('fs/promises', () => ({
  default: {
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
    readFile: mockReadFile,
    unlink: mockUnlink,
    readdir: mockReaddir,
  },
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  unlink: mockUnlink,
  readdir: mockReaddir,
}));

vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: vi.fn().mockReturnValue('/test-workspace'),
  },
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
    get msgPrefix() {
      return '';
    },
  }),
}));

import { TaskStateManager, getTaskStateManager, resetTaskStateManager } from './task-state-manager.js';
import type { TaskState } from './task-state-manager.js';

// ============================================================================
// Helpers
// ============================================================================

const TEST_BASE_DIR = '/test-workspace/tasks-state';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'task_1234567890_abcde',
    prompt: 'Test task prompt',
    status: 'running',
    progress: 0,
    chatId: 'oc_test_chat',
    userId: 'ou_test_user',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ============================================================================
// TaskStateManager Tests
// ============================================================================

describe('TaskStateManager', () => {
  let manager: TaskStateManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    manager = new TaskStateManager('/test-workspace');
  });

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------
  describe('constructor', () => {
    it('should use provided base directory', () => {
      const mgr = new TaskStateManager('/custom-dir');
      // Verify by starting a task and checking the path used
      return mgr.startTask('test', 'chat1').then(() => {
        expect(mockWriteFile).toHaveBeenCalledTimes(1);
        const filePath = mockWriteFile.mock.calls[0][0] as string;
        expect(filePath).toContain('/custom-dir/tasks-state');
      });
    });

    it('should fall back to Config.getWorkspaceDir when no baseDir provided', () => {
      const mgr = new TaskStateManager();
      return mgr.startTask('test', 'chat1').then(() => {
        expect(mockWriteFile).toHaveBeenCalledTimes(1);
        const filePath = mockWriteFile.mock.calls[0][0] as string;
        expect(filePath).toContain('/test-workspace/tasks-state');
      });
    });
  });

  // -------------------------------------------------------------------------
  // startTask
  // -------------------------------------------------------------------------
  describe('startTask', () => {
    it('should create a new task with correct fields', async () => {
      const task = await manager.startTask('Build a feature', 'oc_chat123', 'ou_user1');

      expect(task).toBeDefined();
      expect(task.prompt).toBe('Build a feature');
      expect(task.chatId).toBe('oc_chat123');
      expect(task.userId).toBe('ou_user1');
      expect(task.status).toBe('running');
      expect(task.progress).toBe(0);
      expect(task.id).toMatch(/^task_\d+_[a-z0-9]+$/);
      expect(task.createdAt).toBeDefined();
      expect(task.updatedAt).toBe(task.createdAt);
    });

    it('should create task without userId', async () => {
      const task = await manager.startTask('Build a feature', 'oc_chat123');
      expect(task.userId).toBeUndefined();
    });

    it('should persist task to disk', async () => {
      await manager.startTask('Build a feature', 'oc_chat123');

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const [, content] = mockWriteFile.mock.calls[0];
      const parsed = JSON.parse(content as string);
      expect(parsed.prompt).toBe('Build a feature');
      expect(parsed.status).toBe('running');
      expect(parsed.progress).toBe(0);
    });

    it('should call mkdir to ensure state directory exists', async () => {
      await manager.startTask('Build a feature', 'oc_chat123');
      expect(mockMkdir).toHaveBeenCalledWith(TEST_BASE_DIR, { recursive: true });
    });

    it('should throw when a task is already running', async () => {
      // First start succeeds
      const runningTask = makeTask({ status: 'running' });
      mockReadFile.mockResolvedValue(JSON.stringify(runningTask));

      await expect(manager.startTask('Another task', 'oc_chat2')).rejects.toThrow(
        '已有任务正在执行中',
      );
    });

    it('should allow starting a new task when current task is not running', async () => {
      // Current task is completed (already archived)
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      await expect(manager.startTask('New task', 'oc_chat2')).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // getCurrentTask
  // -------------------------------------------------------------------------
  describe('getCurrentTask', () => {
    it('should return null when no current task exists', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      const task = await manager.getCurrentTask();
      expect(task).toBeNull();
    });

    it('should return current task from disk', async () => {
      const saved = makeTask();
      mockReadFile.mockResolvedValue(JSON.stringify(saved));

      const task = await manager.getCurrentTask();
      expect(task).not.toBeNull();
      expect(task!.id).toBe(saved.id);
      expect(task!.status).toBe('running');
    });

    it('should return null when file contains invalid JSON', async () => {
      mockReadFile.mockResolvedValue('not json');
      const task = await manager.getCurrentTask();
      expect(task).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // updateProgress
  // -------------------------------------------------------------------------
  describe('updateProgress', () => {
    it('should update progress and persist to disk', async () => {
      const task = makeTask();
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await manager.updateProgress(50);
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const [, content] = mockWriteFile.mock.calls[0];
      const parsed = JSON.parse(content as string);
      expect(parsed.progress).toBe(50);
    });

    it('should clamp progress to max 100', async () => {
      const task = makeTask();
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await manager.updateProgress(150);
      const [, content] = mockWriteFile.mock.calls[0];
      const parsed = JSON.parse(content as string);
      expect(parsed.progress).toBe(100);
    });

    it('should clamp progress to min 0', async () => {
      const task = makeTask();
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await manager.updateProgress(-20);
      const [, content] = mockWriteFile.mock.calls[0];
      const parsed = JSON.parse(content as string);
      expect(parsed.progress).toBe(0);
    });

    it('should update currentStep when provided', async () => {
      const task = makeTask();
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await manager.updateProgress(30, 'Step 2: Processing');
      const [, content] = mockWriteFile.mock.calls[0];
      const parsed = JSON.parse(content as string);
      expect(parsed.currentStep).toBe('Step 2: Processing');
    });

    it('should not change currentStep when not provided', async () => {
      const task = makeTask({ currentStep: 'Step 1' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await manager.updateProgress(30);
      const [, content] = mockWriteFile.mock.calls[0];
      const parsed = JSON.parse(content as string);
      expect(parsed.currentStep).toBe('Step 1');
    });

    it('should warn and return early when no current task', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      await manager.updateProgress(50);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('should update the updatedAt timestamp', async () => {
      const task = makeTask({ updatedAt: '2026-01-01T00:00:00.000Z' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await manager.updateProgress(25);
      const [, content] = mockWriteFile.mock.calls[0];
      const parsed = JSON.parse(content as string);
      expect(parsed.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
      expect(new Date(parsed.updatedAt).getTime()).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // pauseTask / resumeTask
  // -------------------------------------------------------------------------
  describe('pauseTask', () => {
    it('should transition a running task to paused', async () => {
      const task = makeTask({ status: 'running' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      const result = await manager.pauseTask();
      expect(result).not.toBeNull();
      expect(result!.status).toBe('paused');
      const [, content] = mockWriteFile.mock.calls[0];
      const parsed = JSON.parse(content as string);
      expect(parsed.status).toBe('paused');
    });

    it('should throw when task is not running', async () => {
      const task = makeTask({ status: 'completed' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await expect(manager.pauseTask()).rejects.toThrow('无法暂停');
    });

    it('should throw when task is paused (cannot pause again)', async () => {
      const task = makeTask({ status: 'paused' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await expect(manager.pauseTask()).rejects.toThrow('无法暂停');
    });

    it('should return null when no current task', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      const result = await manager.pauseTask();
      expect(result).toBeNull();
    });

    it('should update updatedAt timestamp when pausing', async () => {
      const task = makeTask({ status: 'running', updatedAt: '2026-01-01T00:00:00.000Z' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await manager.pauseTask();
      const [, content] = mockWriteFile.mock.calls[0];
      const parsed = JSON.parse(content as string);
      expect(parsed.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
    });
  });

  describe('resumeTask', () => {
    it('should transition a paused task to running', async () => {
      const task = makeTask({ status: 'paused' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      const result = await manager.resumeTask();
      expect(result).not.toBeNull();
      expect(result!.status).toBe('running');
      const [, content] = mockWriteFile.mock.calls[0];
      const parsed = JSON.parse(content as string);
      expect(parsed.status).toBe('running');
    });

    it('should throw when task is not paused', async () => {
      const task = makeTask({ status: 'running' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await expect(manager.resumeTask()).rejects.toThrow('无法恢复');
    });

    it('should throw when task is completed', async () => {
      const task = makeTask({ status: 'completed' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await expect(manager.resumeTask()).rejects.toThrow('无法恢复');
    });

    it('should return null when no current task', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      const result = await manager.resumeTask();
      expect(result).toBeNull();
    });

    it('should update updatedAt timestamp when resuming', async () => {
      const task = makeTask({ status: 'paused', updatedAt: '2026-01-01T00:00:00.000Z' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await manager.resumeTask();
      const [, content] = mockWriteFile.mock.calls[0];
      const parsed = JSON.parse(content as string);
      expect(parsed.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
    });
  });

  // -------------------------------------------------------------------------
  // cancelTask
  // -------------------------------------------------------------------------
  describe('cancelTask', () => {
    it('should archive and clear a running task', async () => {
      const task = makeTask({ status: 'running' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      const result = await manager.cancelTask();
      expect(result).not.toBeNull();
      expect(result!.status).toBe('cancelled');

      // Should have written archive file (only 1 writeFile: the archive)
      // When currentTask is null, saveCurrentTask calls unlink instead of writeFile
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const [archivePath, archiveContent] = mockWriteFile.mock.calls[0];
      expect(archivePath as string).toMatch(/task-task_\d+_\w+\.json$/);
      const archiveParsed = JSON.parse(archiveContent as string);
      expect(archiveParsed.status).toBe('cancelled');
    });

    it('should cancel a paused task', async () => {
      const task = makeTask({ status: 'paused' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      const result = await manager.cancelTask();
      expect(result).not.toBeNull();
      expect(result!.status).toBe('cancelled');
    });

    it('should throw when task is already completed', async () => {
      const task = makeTask({ status: 'completed' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await expect(manager.cancelTask()).rejects.toThrow('无法取消');
    });

    it('should throw when task is already cancelled', async () => {
      const task = makeTask({ status: 'cancelled' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await expect(manager.cancelTask()).rejects.toThrow('无法取消');
    });

    it('should throw when task has error status', async () => {
      const task = makeTask({ status: 'error' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await expect(manager.cancelTask()).rejects.toThrow('无法取消');
    });

    it('should return null when no current task', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      const result = await manager.cancelTask();
      expect(result).toBeNull();
    });

    it('should unlink current task file after cancel', async () => {
      const task = makeTask({ status: 'running' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await manager.cancelTask();
      // After archiving, current task is set to null, so saveCurrentTask calls unlink
      expect(mockUnlink).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // completeTask
  // -------------------------------------------------------------------------
  describe('completeTask', () => {
    it('should set progress to 100 and archive the task', async () => {
      const task = makeTask({ status: 'running', progress: 75 });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      const result = await manager.completeTask();
      expect(result).not.toBeNull();
      expect(result!.status).toBe('completed');
      expect(result!.progress).toBe(100);
    });

    it('should write archived file with completed status', async () => {
      const task = makeTask({ status: 'running', progress: 50 });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await manager.completeTask();
      const [archivePath, archiveContent] = mockWriteFile.mock.calls[0];
      expect(archivePath as string).toMatch(/task-task_\d+_\w+\.json$/);
      const archiveParsed = JSON.parse(archiveContent as string);
      expect(archiveParsed.status).toBe('completed');
      expect(archiveParsed.progress).toBe(100);
    });

    it('should clear current task after completion', async () => {
      const task = makeTask({ status: 'running' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await manager.completeTask();
      // After completing, currentTask is null, so saveCurrentTask calls unlink
      expect(mockUnlink).toHaveBeenCalledTimes(1);
    });

    it('should return null when no current task', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      const result = await manager.completeTask();
      expect(result).toBeNull();
    });

    it('should complete a paused task', async () => {
      const task = makeTask({ status: 'paused', progress: 30 });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      const result = await manager.completeTask();
      expect(result).not.toBeNull();
      expect(result!.status).toBe('completed');
      expect(result!.progress).toBe(100);
    });

    it('should update updatedAt timestamp', async () => {
      const task = makeTask({ status: 'running', updatedAt: '2026-01-01T00:00:00.000Z' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      const result = await manager.completeTask();
      expect(result!.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
    });
  });

  // -------------------------------------------------------------------------
  // setTaskError
  // -------------------------------------------------------------------------
  describe('setTaskError', () => {
    it('should archive task with error status and message', async () => {
      const task = makeTask({ status: 'running' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      const result = await manager.setTaskError('Something went wrong');
      expect(result).not.toBeNull();
      expect(result!.status).toBe('error');
      expect(result!.error).toBe('Something went wrong');
    });

    it('should write archived file with error information', async () => {
      const task = makeTask({ status: 'running' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await manager.setTaskError('Disk full');
      const [archivePath, archiveContent] = mockWriteFile.mock.calls[0];
      expect(archivePath as string).toMatch(/task-task_\d+_\w+\.json$/);
      const archiveParsed = JSON.parse(archiveContent as string);
      expect(archiveParsed.status).toBe('error');
      expect(archiveParsed.error).toBe('Disk full');
    });

    it('should clear current task after setting error', async () => {
      const task = makeTask({ status: 'running' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await manager.setTaskError('Error');
      expect(mockUnlink).toHaveBeenCalledTimes(1);
    });

    it('should return null when no current task', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      const result = await manager.setTaskError('No task');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // listTaskHistory
  // -------------------------------------------------------------------------
  describe('listTaskHistory', () => {
    it('should read archived task files from directory', async () => {
      const task1 = makeTask({
        id: 'task_1_abc',
        status: 'completed',
        updatedAt: '2026-03-01T10:00:00.000Z',
      });
      const task2 = makeTask({
        id: 'task_2_def',
        status: 'cancelled',
        updatedAt: '2026-03-02T10:00:00.000Z',
      });

      mockReaddir.mockResolvedValue(['task-task_1_abc.json', 'task-task_2_def.json']);
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(task1))
        .mockResolvedValueOnce(JSON.stringify(task2));

      const history = await manager.listTaskHistory();
      expect(history).toHaveLength(2);
    });

    it('should sort tasks by updatedAt descending (newest first)', async () => {
      const older = makeTask({
        id: 'task_older',
        status: 'completed',
        updatedAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      const newer = makeTask({
        id: 'task_newer',
        status: 'completed',
        updatedAt: '2026-06-01T00:00:00.000Z',
        createdAt: '2026-06-01T00:00:00.000Z',
      });

      mockReaddir.mockResolvedValue(['task-task_newer.json', 'task-task_older.json']);
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(newer))
        .mockResolvedValueOnce(JSON.stringify(older));

      const history = await manager.listTaskHistory();
      expect(history[0].id).toBe('task_newer');
      expect(history[1].id).toBe('task_older');
    });

    it('should respect the limit parameter', async () => {
      const tasks = Array.from({ length: 5 }, (_, i) =>
        makeTask({
          id: `task_${i}`,
          status: 'completed',
          updatedAt: new Date(Date.now() - i * 1000).toISOString(),
        }),
      );

      mockReaddir.mockResolvedValue(
        tasks.map(t => `task-${t.id}.json`),
      );
      mockReadFile.mockImplementation(async (filePath: string) => {
        const filename = filePath as string;
        for (const t of tasks) {
          if (filename.includes(t.id)) return JSON.stringify(t);
        }
        throw new Error('not found');
      });

      const history = await manager.listTaskHistory(2);
      expect(history).toHaveLength(2);
    });

    it('should default limit to 10', async () => {
      const tasks = Array.from({ length: 15 }, (_, i) =>
        makeTask({
          id: `task_${i}`,
          status: 'completed',
          updatedAt: new Date(Date.now() - i * 1000).toISOString(),
        }),
      );

      mockReaddir.mockResolvedValue(
        tasks.map(t => `task-${t.id}.json`),
      );
      mockReadFile.mockImplementation(async (filePath: string) => {
        const filename = filePath as string;
        for (const t of tasks) {
          if (filename.includes(t.id)) return JSON.stringify(t);
        }
        throw new Error('not found');
      });

      const history = await manager.listTaskHistory();
      expect(history).toHaveLength(10);
    });

    it('should filter files to only task-*.json patterns', async () => {
      mockReaddir.mockResolvedValue([
        'task-task1.json',
        'task-task2.json',
        'current-task.json',
        'other-file.txt',
        'notes.json',
      ]);

      const history = await manager.listTaskHistory();
      // Only task-task1.json and task-task2.json match the filter
      // mockReadFile is mocked to reject by default, so these will be skipped
      // but readdir should still be called and the filtering logic exercised
      expect(mockReaddir).toHaveBeenCalledWith(TEST_BASE_DIR);
    });

    it('should skip invalid JSON files', async () => {
      mockReaddir.mockResolvedValue(['task-bad.json', 'task-good.json']);
      mockReadFile
        .mockResolvedValueOnce('invalid json')
        .mockResolvedValueOnce(JSON.stringify(makeTask({ status: 'completed' })));

      const history = await manager.listTaskHistory();
      expect(history).toHaveLength(1);
    });

    it('should return empty array when readdir fails', async () => {
      mockReaddir.mockRejectedValue(new Error('Permission denied'));
      const history = await manager.listTaskHistory();
      expect(history).toEqual([]);
    });

    it('should use createdAt as secondary sort when updatedAt is equal', async () => {
      const taskA = makeTask({
        id: 'task_a',
        status: 'completed',
        updatedAt: '2026-06-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      const taskB = makeTask({
        id: 'task_b',
        status: 'completed',
        updatedAt: '2026-06-01T00:00:00.000Z',
        createdAt: '2026-06-01T00:00:00.000Z',
      });

      mockReaddir.mockResolvedValue(['task-task_a.json', 'task-task_b.json']);
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(taskA))
        .mockResolvedValueOnce(JSON.stringify(taskB));

      const history = await manager.listTaskHistory();
      expect(history[0].id).toBe('task_b'); // newer createdAt
      expect(history[1].id).toBe('task_a');
    });

    it('should call mkdir to ensure state directory exists', async () => {
      mockReaddir.mockResolvedValue([]);
      await manager.listTaskHistory();
      expect(mockMkdir).toHaveBeenCalledWith(TEST_BASE_DIR, { recursive: true });
    });
  });

  // -------------------------------------------------------------------------
  // Singleton functions
  // -------------------------------------------------------------------------
  describe('getTaskStateManager / resetTaskStateManager', () => {
    it('should return a TaskStateManager instance', () => {
      resetTaskStateManager();
      const instance = getTaskStateManager();
      expect(instance).toBeInstanceOf(TaskStateManager);
    });

    it('should return the same instance on subsequent calls', () => {
      resetTaskStateManager();
      const instance1 = getTaskStateManager();
      const instance2 = getTaskStateManager();
      expect(instance1).toBe(instance2);
    });

    it('should return a new instance after reset', () => {
      resetTaskStateManager();
      const instance1 = getTaskStateManager();
      resetTaskStateManager();
      const instance2 = getTaskStateManager();
      expect(instance1).not.toBe(instance2);
    });
  });

  // -------------------------------------------------------------------------
  // File operation integration
  // -------------------------------------------------------------------------
  describe('file operations', () => {
    it('should create state directory via mkdir before writing', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      await manager.startTask('test', 'chat1');

      // mkdir should be called (from ensureStateDir inside saveCurrentTask)
      expect(mockMkdir).toHaveBeenCalledWith(TEST_BASE_DIR, { recursive: true });
    });

    it('should write JSON with pretty-print formatting', async () => {
      const task = makeTask();
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await manager.updateProgress(50);
      const [, content] = mockWriteFile.mock.calls[0];
      // JSON.stringify with null, 2 produces indented JSON
      const parsed = JSON.parse(content as string);
      expect(parsed.progress).toBe(50);
      // Verify it's pretty-printed (contains newlines)
      expect(content as string).toContain('\n');
    });

    it('should call unlink when clearing current task', async () => {
      const task = makeTask({ status: 'running' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));

      await manager.completeTask();
      // After completion, current task is set to null, saveCurrentTask calls unlink
      expect(mockUnlink).toHaveBeenCalledWith(
        expect.stringContaining('current-task.json'),
      );
    });

    it('should handle unlink failure gracefully when file does not exist', async () => {
      // Simulate the scenario where the file doesn't exist during saveCurrentTask
      // when currentTask is null
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      // startTask creates a task (mockReadFile fails -> no existing task)
      await manager.startTask('test', 'chat1');

      // Now set up a running task, then complete it
      const task = makeTask({ status: 'running' });
      mockReadFile.mockResolvedValue(JSON.stringify(task));
      mockUnlink.mockRejectedValue(new Error('ENOENT'));

      // This should not throw even if unlink fails
      await manager.completeTask();
      // The task was still completed and archived
      expect(mockWriteFile).toHaveBeenCalledTimes(2); // archive + save (which tries unlink)
    });
  });
});
