/**
 * Tests for TaskFileWatcher module.
 *
 * Tests the following functionality:
 * - Detecting new task.md files via fs.watch
 * - Task metadata parsing
 * - Callback triggering
 * - Serial execution
 *
 * Uses mocked file system to avoid real FS dependencies and timing issues.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { TaskFileWatcher, type OnTaskCreated } from './task-file-watcher.js';

// Mock file system state
interface MockFile {
  content: string;
  isDirectory: boolean;
}

let mockFiles: Map<string, MockFile>;
let watchCallback: ((eventType: string, filename: string) => void) | null = null;
let watcherErrorCallback: ((error: Error) => void) | null = null;
let watchClosed = false;

// Mock FSWatcher class
class MockFSWatcher extends EventEmitter {
  close() {
    watchClosed = true;
    watchCallback = null;
    watcherErrorCallback = null;
  }
}

let currentWatcher: MockFSWatcher | null = null;

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  })),
}));

// Mock fs module
vi.mock('fs', () => ({
  promises: {
    mkdir: vi.fn(async (dir: string) => {
      if (!mockFiles.has(dir)) {
        mockFiles.set(dir, { content: '', isDirectory: true });
      }
      return undefined;
    }),
    readdir: vi.fn(async (dir: string, options?: { withFileTypes?: boolean }) => {
      if (dir === '/mock-tasks') {
        const entries: { name: string; isDirectory(): boolean }[] = [];
        for (const [path, info] of mockFiles.entries()) {
          if (path.startsWith('/mock-tasks/') && !path.slice('/mock-tasks/'.length).includes('/')) {
            if (info.isDirectory) {
              entries.push({
                name: path.split('/').pop()!,
                isDirectory: () => true,
              });
            }
          }
        }
        return entries;
      }
      return [];
    }),
    access: vi.fn(async (filePath: string) => {
      if (mockFiles.has(filePath)) {
        return undefined;
      }
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }),
    readFile: vi.fn(async (filePath: string) => {
      const file = mockFiles.get(filePath);
      if (file && !file.isDirectory) {
        return file.content;
      }
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }),
  },
  watch: vi.fn((_dir: string, _options: unknown, callback: (eventType: string, filename: string) => void) => {
    watchClosed = false;
    watchCallback = callback;
    currentWatcher = new MockFSWatcher();
    currentWatcher.on('error', (error: Error) => {
      watcherErrorCallback?.(error);
    });
    return currentWatcher;
  }),
}));

// Helper to simulate file creation
const simulateFileCreation = (dirName: string, content: string) => {
  const taskDir = `/mock-tasks/${dirName}`;
  const taskFile = `${taskDir}/task.md`;

  // Add directory
  mockFiles.set(taskDir, { content: '', isDirectory: true });
  // Add task.md file
  mockFiles.set(taskFile, { content, isDirectory: false });

  // Trigger fs.watch callback if active
  if (watchCallback) {
    watchCallback('rename', `${dirName}/task.md`);
  }
};

// Helper to wait for callback to be called
const waitForCallback = (fn: ReturnType<typeof vi.fn>, timeout = 3000) => {
  return new Promise<void>((resolve, reject) => {
    const startTime = Date.now();
    const check = () => {
      if (fn.mock.calls.length > 0) {
        resolve();
      } else if (Date.now() - startTime > timeout) {
        reject(new Error('Timeout waiting for callback'));
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
};

describe('TaskFileWatcher', () => {
  let watcher: TaskFileWatcher;
  let onTaskCreated: OnTaskCreated;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset mock file system
    mockFiles = new Map();
    mockFiles.set('/mock-tasks', { content: '', isDirectory: true });
    watchCallback = null;
    watcherErrorCallback = null;
    watchClosed = false;
    currentWatcher = null;

    onTaskCreated = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (watcher) {
      watcher.stop();
    }
    vi.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should create instance with options', () => {
      watcher = new TaskFileWatcher({
        tasksDir: '/mock-tasks',
        onTaskCreated,
      });

      expect(watcher).toBeInstanceOf(TaskFileWatcher);
    });
  });

  describe('start/stop', () => {
    it('should start and stop watching', async () => {
      watcher = new TaskFileWatcher({
        tasksDir: '/mock-tasks',
        onTaskCreated,
      });

      await watcher.start();
      expect(watcher.isRunning()).toBe(true);

      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it('should not start twice', async () => {
      watcher = new TaskFileWatcher({
        tasksDir: '/mock-tasks',
        onTaskCreated,
      });

      await watcher.start();
      await watcher.start(); // Second call should be ignored

      expect(watcher.isRunning()).toBe(true);

      watcher.stop();
    });

    it('should create tasks directory if not exists', async () => {
      watcher = new TaskFileWatcher({
        tasksDir: '/mock-tasks-new',
        onTaskCreated,
      });

      await watcher.start();

      expect(mockFiles.has('/mock-tasks-new')).toBe(true);

      watcher.stop();
    });
  });

  describe('Task Detection', () => {
    beforeEach(async () => {
      watcher = new TaskFileWatcher({
        tasksDir: '/mock-tasks',
        onTaskCreated,
      });

      await watcher.start();
      // Wait for initial scan to complete
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    afterEach(() => {
      watcher.stop();
    });

    it('should detect new task.md files', async () => {
      const taskContent = `# Task: Test Task

**Task ID**: msg_test123
**Created**: 2024-01-01T00:00:00Z
**Chat ID**: chat_abc123
**User**: user_xyz

## Description
Test task description.
`;

      simulateFileCreation('msg_test123', taskContent);

      await waitForCallback(onTaskCreated);

      expect(onTaskCreated).toHaveBeenCalledWith(
        '/mock-tasks/msg_test123/task.md',
        'msg_test123',
        'chat_abc123'
      );
    });

    it('should not trigger callback for existing tasks on start', async () => {
      // Add an existing task before starting a new watcher
      const existingTaskContent = `# Task: Existing Task

**Task ID**: msg_existing
**Chat ID**: chat_existing
`;
      mockFiles.set('/mock-tasks/msg_existing', { content: '', isDirectory: true });
      mockFiles.set('/mock-tasks/msg_existing/task.md', { content: existingTaskContent, isDirectory: false });

      watcher.stop();

      const newOnTaskCreated = vi.fn().mockResolvedValue(undefined);
      const newWatcher = new TaskFileWatcher({
        tasksDir: '/mock-tasks',
        onTaskCreated: newOnTaskCreated,
      });

      await newWatcher.start();
      // Wait briefly for watcher to settle
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should not trigger for existing task
      expect(newOnTaskCreated).not.toHaveBeenCalled();

      newWatcher.stop();
    });

    it('should ignore files without required metadata', async () => {
      const incompleteContent = `# Task: Incomplete Task

**Task ID**: msg_incomplete
**Created**: 2024-01-01T00:00:00Z
`;

      simulateFileCreation('msg_incomplete', incompleteContent);

      // Wait for a short period - invalid task should not trigger callback
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(onTaskCreated).not.toHaveBeenCalled();
    });

    it('should not process the same file twice', async () => {
      const taskContent = `# Task: Test

**Task ID**: msg_duplicate
**Chat ID**: chat_dup
`;

      simulateFileCreation('msg_duplicate', taskContent);

      await waitForCallback(onTaskCreated);

      // Modify the file (update content)
      mockFiles.set('/mock-tasks/msg_duplicate/task.md', {
        content: `${taskContent}\n\nMore content`,
        isDirectory: false,
      });

      // Trigger watch event again
      if (watchCallback) {
        watchCallback('change', 'msg_duplicate/task.md');
      }

      // Wait briefly - modified file should not retrigger
      await new Promise(resolve => setTimeout(resolve, 200));

      // Should only be called once
      expect(onTaskCreated).toHaveBeenCalledTimes(1);
    });
  });

  describe('Serial Execution', () => {
    it('should process tasks serially', async () => {
      const executionOrder: string[] = [];

      const slowCallback = vi.fn(async (_taskPath: string, messageId: string) => {
        executionOrder.push(`start-${messageId}`);
        await new Promise(resolve => setTimeout(resolve, 50));
        executionOrder.push(`end-${messageId}`);
      });

      watcher = new TaskFileWatcher({
        tasksDir: '/mock-tasks',
        onTaskCreated: slowCallback,
      });

      await watcher.start();
      await new Promise(resolve => setTimeout(resolve, 50));

      // Create two tasks quickly
      simulateFileCreation('msg_task1', '**Task ID**: msg_task1\n**Chat ID**: chat1');
      simulateFileCreation('msg_task2', '**Task ID**: msg_task2\n**Chat ID**: chat2');

      // Wait for both tasks to complete
      await new Promise<void>((resolve) => {
        const check = () => {
          if (slowCallback.mock.calls.length >= 2) {
            resolve();
          } else {
            setTimeout(check, 50);
          }
        };
        setTimeout(check, 50);
      });

      // Wait a bit more for execution order to be recorded
      await new Promise(resolve => setTimeout(resolve, 150));

      // Verify serial execution: first task should complete before second starts
      expect(executionOrder).toEqual([
        'start-msg_task1',
        'end-msg_task1',
        'start-msg_task2',
        'end-msg_task2',
      ]);

      watcher.stop();
    });

    it('should continue processing after task failure', async () => {
      const executionOrder: string[] = [];

      const failingCallback = vi.fn((_taskPath: string, messageId: string): Promise<void> => {
        if (messageId === 'msg_fail') {
          return Promise.reject(new Error('Task failed'));
        }
        executionOrder.push(messageId);
        return Promise.resolve();
      });

      watcher = new TaskFileWatcher({
        tasksDir: '/mock-tasks',
        onTaskCreated: failingCallback,
      });

      await watcher.start();
      await new Promise(resolve => setTimeout(resolve, 50));

      // Create failing task first
      simulateFileCreation('msg_fail', '**Task ID**: msg_fail\n**Chat ID**: chat1');

      // Wait for failure to process
      await new Promise<void>((resolve) => {
        const check = () => {
          if (failingCallback.mock.calls.length >= 1) {
            resolve();
          } else {
            setTimeout(check, 50);
          }
        };
        setTimeout(check, 50);
      });

      // Create success task
      simulateFileCreation('msg_success', '**Task ID**: msg_success\n**Chat ID**: chat2');

      // Wait for success task to process
      await new Promise<void>((resolve) => {
        const check = () => {
          if (failingCallback.mock.calls.length >= 2) {
            resolve();
          } else {
            setTimeout(check, 50);
          }
        };
        setTimeout(check, 50);
      });

      // Both tasks should have been attempted
      expect(failingCallback).toHaveBeenCalledTimes(2);
      expect(executionOrder).toContain('msg_success');

      watcher.stop();
    });
  });

  describe('Error Handling', () => {
    it('should handle fs.watch errors gracefully', async () => {
      watcher = new TaskFileWatcher({
        tasksDir: '/mock-tasks',
        onTaskCreated,
      });

      await watcher.start();
      await new Promise(resolve => setTimeout(resolve, 50));

      // Simulate fs.watch error
      if (currentWatcher) {
        currentWatcher.emit('error', new Error('Watch error'));
      }

      // Watcher should still be running
      expect(watcher.isRunning()).toBe(true);

      watcher.stop();
    });
  });
});
