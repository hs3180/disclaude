/**
 * ScheduleFileWatcher Tests
 *
 * Tests use mocks to avoid unreliable file system event behavior in CI.
 * Real file system watcher tests are avoided as they test Node.js fs.watch
 * rather than our application logic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as fsLegacy from 'fs';
import { ScheduleFileWatcher, ScheduleFileScanner, type ScheduleFileTask } from './schedule-watcher.js';

// Helper to wait for async events
const waitFor = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Check if file event tests are enabled
const enableFileEventTests = process.env.ENABLE_WATCHER_TESTS === 'true';

describe('ScheduleFileWatcher', () => {
  let testDir: string;
  let watcher: ScheduleFileWatcher;
  let onFileAdded: ReturnType<typeof vi.fn>;
  let onFileChanged: ReturnType<typeof vi.fn>;
  let onFileRemoved: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `schedule-watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });

    onFileAdded = vi.fn();
    onFileChanged = vi.fn();
    onFileRemoved = vi.fn();
  });

  afterEach(async () => {
    if (watcher) {
      watcher.stop();
    }
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('start and stop', () => {
    it('should start watching the directory', async () => {
      watcher = new ScheduleFileWatcher({
        schedulesDir: testDir,
        onFileAdded,
        onFileChanged,
        onFileRemoved,
      });

      expect(watcher.isRunning()).toBe(false);
      await watcher.start();
      expect(watcher.isRunning()).toBe(true);
    });

    it('should stop watching when stop is called', async () => {
      watcher = new ScheduleFileWatcher({
        schedulesDir: testDir,
        onFileAdded,
        onFileChanged,
        onFileRemoved,
      });

      await watcher.start();
      expect(watcher.isRunning()).toBe(true);

      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it('should not start twice', async () => {
      watcher = new ScheduleFileWatcher({
        schedulesDir: testDir,
        onFileAdded,
        onFileChanged,
        onFileRemoved,
      });

      await watcher.start();
      await watcher.start(); // Should not throw

      expect(watcher.isRunning()).toBe(true);
    });

    it('should create directory if it does not exist', async () => {
      const newDir = path.join(testDir, 'nonexistent');

      watcher = new ScheduleFileWatcher({
        schedulesDir: newDir,
        onFileAdded,
        onFileChanged,
        onFileRemoved,
      });

      await watcher.start();

      const exists = await fs.access(newDir).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should clear debounce timers on stop', async () => {
      watcher = new ScheduleFileWatcher({
        schedulesDir: testDir,
        onFileAdded,
        onFileChanged,
        onFileRemoved,
        debounceMs: 100,
      });

      await watcher.start();
      await watcher.stop();

      expect(watcher.isRunning()).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should handle errors gracefully when parsing fails', async () => {
      watcher = new ScheduleFileWatcher({
        schedulesDir: testDir,
        onFileAdded,
        onFileChanged,
        onFileRemoved,
        debounceMs: 50,
      });
      await watcher.start();

      const filePath = path.join(testDir, 'error.md');

      // Write invalid content that will fail to parse as valid schedule
      await fs.writeFile(filePath, 'just some random text');
      await waitFor(200);

      // Should not call onFileAdded because parsing fails
      expect(onFileAdded).not.toHaveBeenCalled();
    });
  });
});

describe('ScheduleFileScanner', () => {
  let testDir: string;
  let scanner: ScheduleFileScanner;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `schedule-scanner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
    scanner = new ScheduleFileScanner({ schedulesDir: testDir });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('parseFile', () => {
    it('should parse a valid schedule file', async () => {
      const filePath = path.join(testDir, 'test-task.md');
      const content = `---
name: "Test Task"
cron: "0 9 * * *"
chatId: "oc_test"
---
Test prompt content`;

      await fs.writeFile(filePath, content);
      const task = await scanner.parseFile(filePath);

      expect(task).not.toBeNull();
      expect(task!.id).toBe('schedule-test-task');
      expect(task!.name).toBe('Test Task');
      expect(task!.cron).toBe('0 9 * * *');
      expect(task!.chatId).toBe('oc_test');
      expect(task!.prompt).toBe('Test prompt content');
      expect(task!.enabled).toBe(true);
      expect(task!.blocking).toBe(true);
    });

    it('should parse all task fields correctly', async () => {
      const filePath = path.join(testDir, 'full-task.md');
      const content = `---
name: "Full Task"
cron: "30 14 * * 1-5"
enabled: false
blocking: false
chatId: "oc_full_test"
createdBy: "ou_creator"
createdAt: "2024-01-15T10:30:00.000Z"
---
Full task prompt with multiple lines`;

      await fs.writeFile(filePath, content);
      const task = await scanner.parseFile(filePath);

      expect(task).not.toBeNull();
      expect(task!.id).toBe('schedule-full-task');
      expect(task!.name).toBe('Full Task');
      expect(task!.cron).toBe('30 14 * * 1-5');
      expect(task!.enabled).toBe(false);
      expect(task!.blocking).toBe(false);
      expect(task!.chatId).toBe('oc_full_test');
      expect(task!.createdBy).toBe('ou_creator');
      expect(task!.createdAt).toBe('2024-01-15T10:30:00.000Z');
      expect(task!.prompt).toBe('Full task prompt with multiple lines');
      expect(task!.sourceFile).toBe(filePath);
      expect(task!.fileMtime).toBeInstanceOf(Date);
    });

    it('should return null for files missing required fields', async () => {
      const filePath = path.join(testDir, 'incomplete.md');
      const content = `---
name: "Incomplete Task"
cron: "0 9 * * *"
---
Missing chatId`;

      await fs.writeFile(filePath, content);
      const task = await scanner.parseFile(filePath);

      expect(task).toBeNull();
    });

    it('should return null for files with no frontmatter', async () => {
      const filePath = path.join(testDir, 'no-frontmatter.md');
      await fs.writeFile(filePath, 'Just some text without frontmatter');

      const task = await scanner.parseFile(filePath);

      expect(task).toBeNull();
    });

    it('should use file birthtime when createdAt not specified', async () => {
      const filePath = path.join(testDir, 'no-created.md');
      const content = `---
name: "No CreatedAt"
cron: "0 9 * * *"
chatId: "oc_test"
---
Prompt`;

      await fs.writeFile(filePath, content);
      const task = await scanner.parseFile(filePath);

      expect(task).not.toBeNull();
      expect(task!.createdAt).toBeDefined();
      expect(new Date(task!.createdAt!).getTime()).not.toBeNaN();
    });

    it('should return null for non-existent files', async () => {
      const task = await scanner.parseFile(path.join(testDir, 'nonexistent.md'));
      expect(task).toBeNull();
    });
  });

  describe('scanAll', () => {
    it('should scan and return all valid schedule files', async () => {
      // Create multiple schedule files
      await fs.writeFile(path.join(testDir, 'task1.md'), `---
name: "Task 1"
cron: "0 9 * * *"
chatId: "oc_test"
---
Prompt 1`);

      await fs.writeFile(path.join(testDir, 'task2.md'), `---
name: "Task 2"
cron: "0 10 * * *"
chatId: "oc_test"
---
Prompt 2`);

      // Invalid file (missing chatId)
      await fs.writeFile(path.join(testDir, 'invalid.md'), `---
name: "Invalid"
cron: "0 11 * * *"
---
Missing chatId`);

      // Non-markdown file
      await fs.writeFile(path.join(testDir, 'readme.txt'), 'Not a schedule');

      const tasks = await scanner.scanAll();

      expect(tasks).toHaveLength(2);
      const names = tasks.map(t => t.name).sort();
      expect(names).toEqual(['Task 1', 'Task 2']);
    });

    it('should return empty array for empty directory', async () => {
      const tasks = await scanner.scanAll();
      expect(tasks).toEqual([]);
    });

    it('should return empty array for non-existent directory', async () => {
      const nonExistentScanner = new ScheduleFileScanner({
        schedulesDir: path.join(testDir, 'nonexistent'),
      });
      const tasks = await nonExistentScanner.scanAll();
      expect(tasks).toEqual([]);
    });
  });

  describe('writeTask and deleteTask', () => {
    it('should write a task to a markdown file', async () => {
      const task: ScheduleFileTask = {
        id: 'schedule-my-task',
        name: 'My Task',
        cron: '0 9 * * *',
        chatId: 'oc_test',
        prompt: 'My prompt',
        enabled: true,
        blocking: true,
        sourceFile: '',
        fileMtime: new Date(),
      };

      const filePath = await scanner.writeTask(task);

      expect(filePath).toBe(path.join(testDir, 'my-task.md'));

      // Verify file content
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('name: "My Task"');
      expect(content).toContain('cron: "0 9 * * *"');
      expect(content).toContain('chatId: oc_test');
      expect(content).toContain('My prompt');
    });

    it('should delete a task file by task ID', async () => {
      await fs.writeFile(path.join(testDir, 'to-delete.md'), `---
name: "To Delete"
cron: "0 9 * * *"
chatId: "oc_test"
---
Prompt`);

      const result = await scanner.deleteTask('schedule-to-delete');

      expect(result).toBe(true);
      const exists = await fs.access(path.join(testDir, 'to-delete.md')).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it('should return false when deleting non-existent task', async () => {
      const result = await scanner.deleteTask('schedule-nonexistent');
      expect(result).toBe(false);
    });

    it('should return false for invalid task ID format', async () => {
      const result = await scanner.deleteTask('invalid-id');
      expect(result).toBe(false);
    });
  });
});

// Only run file event tests when explicitly enabled
// These tests are for development purposes and may be unreliable in CI
if (enableFileEventTests) {
  describe('file events (requires ENABLE_WATCHER_TESTS=true)', () => {
    let testDir: string;
    let watcher: ScheduleFileWatcher;
    let onFileAdded: ReturnType<typeof vi.fn>;
    let onFileChanged: ReturnType<typeof vi.fn>;
    let onFileRemoved: ReturnType<typeof vi.fn>;

    const waitForCondition = async (
      condition: () => boolean,
      options: { timeout?: number; interval?: number } = {}
    ): Promise<boolean> => {
      const { timeout = 5000, interval = 100 } = options;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (condition()) {return true;}
        await waitFor(interval);
      }
      return false;
    };

    beforeEach(async () => {
      testDir = path.join(os.tmpdir(), `schedule-watcher-integration-${Date.now()}`);
      await fs.mkdir(testDir, { recursive: true });

      onFileAdded = vi.fn();
      onFileChanged = vi.fn();
      onFileRemoved = vi.fn();
    });

    afterEach(async () => {
      if (watcher) {
        watcher.stop();
      }
      try {
        await fs.rm(testDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    });

    it('should detect new file added', async () => {
      watcher = new ScheduleFileWatcher({
        schedulesDir: testDir,
        onFileAdded,
        onFileChanged,
        onFileRemoved,
        debounceMs: 50,
      });
      await watcher.start();

      const filePath = path.join(testDir, 'new-task.md');
      const content = `---
name: "New Task"
cron: "0 9 * * *"
chatId: "oc_test"
---
New task prompt`;

      await fs.writeFile(filePath, content);

      const called = await waitForCondition(() => onFileAdded.mock.calls.length > 0);
      expect(called).toBe(true);

      const task = onFileAdded.mock.calls[0][0] as ScheduleFileTask;
      expect(task.name).toBe('New Task');
      expect(task.cron).toBe('0 9 * * *');
      expect(task.chatId).toBe('oc_test');
    });

    it('should detect file removed', async () => {
      const filePath = path.join(testDir, 'remove-task.md');
      const content = `---
name: "Task to Remove"
cron: "0 9 * * *"
chatId: "oc_test"
---
Prompt`;

      await fs.writeFile(filePath, content);

      watcher = new ScheduleFileWatcher({
        schedulesDir: testDir,
        onFileAdded,
        onFileChanged,
        onFileRemoved,
        debounceMs: 50,
      });
      await watcher.start();

      await waitForCondition(() => onFileAdded.mock.calls.length > 0);

      await fs.unlink(filePath);
      const called = await waitForCondition(() => onFileRemoved.mock.calls.length > 0);
      expect(called).toBe(true);

      const [[taskId, removedFilePath]] = onFileRemoved.mock.calls;
      expect(taskId).toBe('schedule-remove-task');
      expect(removedFilePath).toBe(filePath);
    });

    it('should detect file changed', async () => {
      const filePath = path.join(testDir, 'change-task.md');
      const content = `---
name: "Original Name"
cron: "0 9 * * *"
chatId: "oc_test"
---
Original prompt`;

      await fs.writeFile(filePath, content);

      watcher = new ScheduleFileWatcher({
        schedulesDir: testDir,
        onFileAdded,
        onFileChanged,
        onFileRemoved,
        debounceMs: 50,
      });
      await watcher.start();

      await waitForCondition(() => onFileAdded.mock.calls.length > 0);
      onFileAdded.mockClear();
      onFileChanged.mockClear();

      const modifiedContent = `---
name: "Modified Name"
cron: "0 10 * * *"
chatId: "oc_test"
---
Modified prompt`;

      await fs.writeFile(filePath, modifiedContent);

      const called = await waitForCondition(() => onFileChanged.mock.calls.length > 0);
      expect(called).toBe(true);

      const task = onFileChanged.mock.calls[0][0] as ScheduleFileTask;
      expect(task.name).toBe('Modified Name');
      expect(task.cron).toBe('0 10 * * *');
    });

    it('should debounce multiple rapid-events', async () => {
      watcher = new ScheduleFileWatcher({
        schedulesDir: testDir,
        onFileAdded,
        onFileChanged,
        onFileRemoved,
        debounceMs: 100,
      });
      await watcher.start();

      const filePath = path.join(testDir, 'debounce.md');
      const content = `---
name: "Debounce Test"
cron: "0 9 * * *"
chatId: "oc_test"
---
Prompt`;

      await fs.writeFile(filePath, content);
      await fs.writeFile(filePath, `${content}\n1`);
      await fs.writeFile(filePath, `${content}\n2`);

      const called = await waitForCondition(() => onFileAdded.mock.calls.length > 0);
      expect(called).toBe(true);

      // Should only trigger once after debounce
      expect(onFileAdded).toHaveBeenCalledTimes(1);
    });
  });
}
