/**
 * Tests for TaskFileWatcher module.
 *
 * Tests the following functionality:
 * - Detecting new task.md files via fs.watch
 * - Task metadata parsing
 * - Callback triggering
 * - Serial execution
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TaskFileWatcher, type OnTaskCreated } from './task-file-watcher.js';

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  })),
}));

describe('TaskFileWatcher', () => {
  let watcher: TaskFileWatcher;
  let tempDir: string;
  let onTaskCreated: OnTaskCreated;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create temp directory for tests
    tempDir = path.join('/tmp', `task-watcher-test-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    onTaskCreated = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (watcher) {
      watcher.stop();
    }

    // Clean up temp directory
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    vi.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should create instance with options', () => {
      watcher = new TaskFileWatcher({
        tasksDir: tempDir,
        onTaskCreated,
      });

      expect(watcher).toBeInstanceOf(TaskFileWatcher);
    });
  });

  describe('start/stop', () => {
    it('should start and stop watching', async () => {
      watcher = new TaskFileWatcher({
        tasksDir: tempDir,
        onTaskCreated,
      });

      await watcher.start();
      expect(watcher.isRunning()).toBe(true);

      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it('should not start twice', async () => {
      watcher = new TaskFileWatcher({
        tasksDir: tempDir,
        onTaskCreated,
      });

      await watcher.start();
      await watcher.start(); // Second call should be ignored

      expect(watcher.isRunning()).toBe(true);

      watcher.stop();
    });

    it('should create tasks directory if not exists', async () => {
      const nonExistentDir = path.join(tempDir, 'non-existent');
      watcher = new TaskFileWatcher({
        tasksDir: nonExistentDir,
        onTaskCreated,
      });

      await watcher.start();

      const exists = await fs.promises.access(nonExistentDir)
        .then(() => true)
        .catch(() => false);

      expect(exists).toBe(true);

      watcher.stop();
    });
  });

  describe('Task Detection', () => {
    beforeEach(async () => {
      watcher = new TaskFileWatcher({
        tasksDir: tempDir,
        onTaskCreated,
      });

      await watcher.start();
    });

    afterEach(() => {
      watcher.stop();
    });

    it('should detect new task.md files', async () => {
      // Create a task directory and file
      const taskDir = path.join(tempDir, 'msg_test123');
      await fs.promises.mkdir(taskDir, { recursive: true });

      const taskFile = path.join(taskDir, 'task.md');
      const taskContent = `# Task: Test Task

**Task ID**: msg_test123
**Created**: 2024-01-01T00:00:00Z
**Chat ID**: chat_abc123
**User**: user_xyz

## Description
Test task description.
`;

      await fs.promises.writeFile(taskFile, taskContent, 'utf-8');

      // Wait for detection via fs.watch
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(onTaskCreated).toHaveBeenCalledWith(
        taskFile,
        'msg_test123',
        'chat_abc123'
      );
    });

    it('should not trigger callback for existing tasks on start', async () => {
      // Create a task before starting the watcher
      const taskDir = path.join(tempDir, 'msg_existing');
      await fs.promises.mkdir(taskDir, { recursive: true });

      const taskFile = path.join(taskDir, 'task.md');
      const taskContent = `# Task: Existing Task

**Task ID**: msg_existing
**Chat ID**: chat_existing
`;

      await fs.promises.writeFile(taskFile, taskContent, 'utf-8');

      // Stop and restart watcher
      watcher.stop();

      const newOnTaskCreated = vi.fn().mockResolvedValue(undefined);
      const newWatcher = new TaskFileWatcher({
        tasksDir: tempDir,
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
      const taskDir = path.join(tempDir, 'msg_incomplete');
      await fs.promises.mkdir(taskDir, { recursive: true });

      const taskFile = path.join(taskDir, 'task.md');
      const taskContent = `# Task: Incomplete Task

**Task ID**: msg_incomplete
**Created**: 2024-01-01T00:00:00Z
`;

      await fs.promises.writeFile(taskFile, taskContent, 'utf-8');

      // Wait briefly - invalid task should not trigger callback
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(onTaskCreated).not.toHaveBeenCalled();
    });

    it('should not process the same file twice', async () => {
      const taskDir = path.join(tempDir, 'msg_duplicate');
      await fs.promises.mkdir(taskDir, { recursive: true });

      const taskFile = path.join(taskDir, 'task.md');
      const taskContent = `# Task: Test

**Task ID**: msg_duplicate
**Chat ID**: chat_dup
`;

      await fs.promises.writeFile(taskFile, taskContent, 'utf-8');

      // Wait for first processing
      await new Promise(resolve => setTimeout(resolve, 500));

      // Modify the file
      await fs.promises.writeFile(taskFile, taskContent + '\n\nMore content', 'utf-8');

      // Wait briefly - modified file should not retrigger
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should only be called once
      expect(onTaskCreated).toHaveBeenCalledTimes(1);
    });
  });

  describe('Serial Execution', () => {
    it('should process tasks serially', async () => {
      const executionOrder: string[] = [];

      const slowCallback = vi.fn(async (taskPath: string, messageId: string) => {
        executionOrder.push(`start-${messageId}`);
        await new Promise(resolve => setTimeout(resolve, 100));
        executionOrder.push(`end-${messageId}`);
      });

      watcher = new TaskFileWatcher({
        tasksDir: tempDir,
        onTaskCreated: slowCallback,
      });

      await watcher.start();

      // Create two tasks quickly
      for (let i = 1; i <= 2; i++) {
        const taskDir = path.join(tempDir, `msg_task${i}`);
        await fs.promises.mkdir(taskDir, { recursive: true });
        const taskFile = path.join(taskDir, 'task.md');
        await fs.promises.writeFile(taskFile, `**Task ID**: msg_task${i}\n**Chat ID**: chat${i}`, 'utf-8');
      }

      // Wait for both tasks to complete
      await new Promise(resolve => setTimeout(resolve, 800));

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

      const failingCallback = vi.fn(async (taskPath: string, messageId: string) => {
        if (messageId === 'msg_fail') {
          throw new Error('Task failed');
        }
        executionOrder.push(messageId);
      });

      watcher = new TaskFileWatcher({
        tasksDir: tempDir,
        onTaskCreated: failingCallback,
      });

      await watcher.start();

      // Create failing task first
      const failDir = path.join(tempDir, 'msg_fail');
      await fs.promises.mkdir(failDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(failDir, 'task.md'),
        '**Task ID**: msg_fail\n**Chat ID**: chat1',
        'utf-8'
      );

      // Wait a bit then create success task
      await new Promise(resolve => setTimeout(resolve, 500));

      const successDir = path.join(tempDir, 'msg_success');
      await fs.promises.mkdir(successDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(successDir, 'task.md'),
        '**Task ID**: msg_success\n**Chat ID**: chat2',
        'utf-8'
      );

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Both tasks should have been attempted
      expect(failingCallback).toHaveBeenCalledTimes(2);
      expect(executionOrder).toContain('msg_success');

      watcher.stop();
    });
  });
});
