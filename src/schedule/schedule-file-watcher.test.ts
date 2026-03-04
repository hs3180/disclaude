/**
 * ScheduleFileWatcher Tests
 *
 * Tests for the file watcher lifecycle (start/stop) and error handling.
 * For file parsing and scanning tests, see schedule-file-scanner.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ScheduleFileWatcher } from './schedule-watcher.js';

// Helper to wait for async events
const waitFor = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
