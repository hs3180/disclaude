/**
 * Tests for EventTriggerWatcher.
 *
 * Verifies file system watching, debounce behavior,
 * and integration with trigger callbacks.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { EventTriggerWatcher } from './event-trigger-watcher.js';

describe('EventTriggerWatcher', () => {
  let tmpDir: string;
  let watchDir: string;
  let watcher: EventTriggerWatcher;
  let onTrigger: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'watcher-test-'));
    watchDir = path.join(tmpDir, 'watched');
    await fsPromises.mkdir(watchDir, { recursive: true });

    onTrigger = vi.fn();
    watcher = new EventTriggerWatcher({
      baseDir: tmpDir,
      onTrigger,
    });
  });

  afterEach(() => {
    watcher.stopAll();
    return fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('constructor', () => {
    it('should create EventTriggerWatcher with baseDir', () => {
      expect(watcher).toBeInstanceOf(EventTriggerWatcher);
      expect(watcher.getWatchCount()).toBe(0);
    });
  });

  describe('watchTask', () => {
    it('should start watching a directory', async () => {
      await watcher.watchTask('task-1', watchDir, 1000);

      expect(watcher.isWatching('task-1')).toBe(true);
      expect(watcher.getWatchCount()).toBe(1);
    });

    it('should watch relative path resolved against baseDir', async () => {
      await watcher.watchTask('task-1', 'watched', 1000);

      expect(watcher.isWatching('task-1')).toBe(true);
    });

    it('should create watch directory if it does not exist', async () => {
      const newDir = path.join(tmpDir, 'new-watched');
      await watcher.watchTask('task-1', newDir, 1000);

      const stat = await fsPromises.stat(newDir);
      expect(stat.isDirectory()).toBe(true);
      expect(watcher.isWatching('task-1')).toBe(true);
    });

    it('should replace existing watch for the same task', async () => {
      await watcher.watchTask('task-1', watchDir, 1000);
      await watcher.watchTask('task-1', watchDir, 2000);

      expect(watcher.getWatchCount()).toBe(1);
      expect(watcher.isWatching('task-1')).toBe(true);
    });
  });

  describe('unwatchTask', () => {
    it('should stop watching a specific task', async () => {
      await watcher.watchTask('task-1', watchDir, 1000);
      expect(watcher.isWatching('task-1')).toBe(true);

      watcher.unwatchTask('task-1');
      expect(watcher.isWatching('task-1')).toBe(false);
      expect(watcher.getWatchCount()).toBe(0);
    });

    it('should handle unwatching non-existent task gracefully', () => {
      expect(() => watcher.unwatchTask('nonexistent')).not.toThrow();
    });
  });

  describe('stopAll', () => {
    it('should stop all watchers', async () => {
      const dir2 = path.join(tmpDir, 'watched-2');
      await fsPromises.mkdir(dir2, { recursive: true });

      await watcher.watchTask('task-1', watchDir, 1000);
      await watcher.watchTask('task-2', dir2, 1000);

      expect(watcher.getWatchCount()).toBe(2);

      watcher.stopAll();
      expect(watcher.getWatchCount()).toBe(0);
    });
  });

  describe('getWatchedTaskIds', () => {
    it('should return all watched task IDs', async () => {
      const dir2 = path.join(tmpDir, 'watched-2');
      await fsPromises.mkdir(dir2, { recursive: true });

      await watcher.watchTask('task-1', watchDir, 1000);
      await watcher.watchTask('task-2', dir2, 1000);

      const ids = watcher.getWatchedTaskIds();
      expect(ids).toContain('task-1');
      expect(ids).toContain('task-2');
      expect(ids).toHaveLength(2);
    });
  });

  describe('file change detection', () => {
    it('should trigger callback when file is added to watched directory', async () => {
      await watcher.watchTask('task-1', watchDir, 500);

      // Write a file to trigger the watcher
      await fsPromises.writeFile(path.join(watchDir, 'test-file.json'), '{}');

      // Wait for debounce + fs.watch detection
      await vi.waitFor(() => {
        expect(onTrigger).toHaveBeenCalledWith('task-1');
      }, { timeout: 3000 });
    });

    it('should trigger callback when file is modified', async () => {
      // Create initial file
      const testFile = path.join(watchDir, 'existing.json');
      await fsPromises.writeFile(testFile, '{"status":"pending"}');

      await watcher.watchTask('task-1', watchDir, 500);

      // Modify the file
      await fsPromises.writeFile(testFile, '{"status":"active"}');

      await vi.waitFor(() => {
        expect(onTrigger).toHaveBeenCalledWith('task-1');
      }, { timeout: 3000 });
    });

    it('should not trigger for hidden files', async () => {
      await watcher.watchTask('task-1', watchDir, 500);

      // Write a hidden file
      await fsPromises.writeFile(path.join(watchDir, '.hidden'), 'data');

      // Wait a bit to ensure no trigger
      await new Promise(resolve => setTimeout(resolve, 800));

      expect(onTrigger).not.toHaveBeenCalled();
    });

    it('should not trigger for trigger files (prevent feedback loops)', async () => {
      await watcher.watchTask('task-1', watchDir, 500);

      // Write a trigger file (which would be written by TriggerManager)
      await fsPromises.writeFile(path.join(watchDir, '.trigger'), 'data');

      // Wait a bit to ensure no trigger
      await new Promise(resolve => setTimeout(resolve, 800));

      expect(onTrigger).not.toHaveBeenCalled();
    });
  });

  describe('debounce', () => {
    it('should debounce rapid file changes', async () => {
      await watcher.watchTask('task-debounce', watchDir, 1000);

      // Rapidly create multiple files
      for (let i = 0; i < 5; i++) {
        await fsPromises.writeFile(
          path.join(watchDir, `file-${i}.json`),
          JSON.stringify({ i })
        );
      }

      // Wait for debounce to settle
      await vi.waitFor(() => {
        expect(onTrigger).toHaveBeenCalledWith('task-debounce');
      }, { timeout: 3000 });

      // Should have been called fewer times than files created due to debounce
      expect(onTrigger.mock.calls.length).toBeLessThan(5);
    });
  });
});
