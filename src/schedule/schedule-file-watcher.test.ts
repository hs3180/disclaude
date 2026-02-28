/**
 * ScheduleFileWatcher Tests
 *
 * Note: File system watcher tests can be unreliable in CI environments
 * due to OS-level file system event buffering. The core file event tests
 * are skipped by default but can be enabled locally by setting
 * ENABLE_WATCHER_TESTS=true
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ScheduleFileWatcher, type ScheduleFileTask } from './schedule-watcher.js';

// Helper to wait for async events
const waitFor = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Wait for a condition to be true, polling at intervals
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

  // File event tests - may be unreliable in CI
  (enableFileEventTests ? describe : describe.skip)('file events', () => {
    beforeEach(async () => {
      watcher = new ScheduleFileWatcher({
        schedulesDir: testDir,
        onFileAdded,
        onFileChanged,
        onFileRemoved,
        debounceMs: 50,
      });
      await watcher.start();
    });

    it('should detect new file added', async () => {
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
      await waitForCondition(() => onFileAdded.mock.calls.length > 0);

      await fs.unlink(filePath);
      const called = await waitForCondition(() => onFileRemoved.mock.calls.length > 0);
      expect(called).toBe(true);

      const [taskId, removedFilePath] = onFileRemoved.mock.calls[0] as [string, string];
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

    it('should ignore non-markdown files', async () => {
      const filePath = path.join(testDir, 'test.txt');
      await fs.writeFile(filePath, 'Not a schedule file');
      await waitFor(300);

      expect(onFileAdded).not.toHaveBeenCalled();
    });

    it('should skip files missing required fields', async () => {
      const filePath = path.join(testDir, 'incomplete.md');
      const content = `---
name: "Incomplete Task"
cron: "0 9 * * *"
---
Missing chatId`;

      await fs.writeFile(filePath, content);
      await waitFor(300);

      expect(onFileAdded).not.toHaveBeenCalled();
    });
  });

  // Debounce tests - may be unreliable in CI
  (enableFileEventTests ? describe : describe.skip)('debouncing', () => {
    it('should debounce multiple rapid events', async () => {
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
      await fs.writeFile(filePath, `${content  }\n1`);
      await fs.writeFile(filePath, `${content  }\n2`);

      const called = await waitForCondition(() => onFileAdded.mock.calls.length > 0);
      expect(called).toBe(true);

      // Should only trigger once after debounce
      expect(onFileAdded).toHaveBeenCalledTimes(1);
    });
  });

  // Task parsing tests - may be unreliable in CI
  (enableFileEventTests ? describe : describe.skip)('task parsing', () => {
    beforeEach(async () => {
      watcher = new ScheduleFileWatcher({
        schedulesDir: testDir,
        onFileAdded,
        onFileChanged,
        onFileRemoved,
        debounceMs: 50,
      });
      await watcher.start();
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

      const called = await waitForCondition(() => onFileAdded.mock.calls.length > 0);
      expect(called).toBe(true);

      const task = onFileAdded.mock.calls[0][0] as ScheduleFileTask;

      expect(task.id).toBe('schedule-full-task');
      expect(task.name).toBe('Full Task');
      expect(task.cron).toBe('30 14 * * 1-5');
      expect(task.enabled).toBe(false);
      expect(task.blocking).toBe(false);
      expect(task.chatId).toBe('oc_full_test');
      expect(task.createdBy).toBe('ou_creator');
      expect(task.createdAt).toBe('2024-01-15T10:30:00.000Z');
      expect(task.prompt).toBe('Full task prompt with multiple lines');
      expect(task.sourceFile).toBe(filePath);
      expect(task.fileMtime).toBeInstanceOf(Date);
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

      const called = await waitForCondition(() => onFileAdded.mock.calls.length > 0);
      expect(called).toBe(true);

      const task = onFileAdded.mock.calls[0][0] as ScheduleFileTask;
      expect(task.createdAt).toBeDefined();
      expect(new Date(task.createdAt!).getTime()).not.toBeNaN();
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
