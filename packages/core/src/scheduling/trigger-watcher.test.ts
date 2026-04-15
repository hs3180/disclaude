/**
 * Tests for TriggerWatcher.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Verifies:
 * - Adding and removing watches
 * - Debounce behavior
 * - Multiple tasks watching the same directory
 * - Lifecycle (start/stop)
 * - Handling non-existent directories
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TriggerWatcher } from './trigger-watcher.js';

describe('TriggerWatcher', () => {
  let tmpDir: string;
  let onTrigger: ReturnType<typeof vi.fn>;
  let watcher: TriggerWatcher;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trigger-watcher-test-'));
    onTrigger = vi.fn();
    watcher = new TriggerWatcher({
      basePath: tmpDir,
      onTrigger,
    });
  });

  afterEach(async () => {
    watcher.stop();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create a TriggerWatcher with required options', () => {
      expect(watcher).toBeInstanceOf(TriggerWatcher);
      expect(watcher.isRunning()).toBe(false);
    });
  });

  describe('start / stop', () => {
    it('should start and stop the watcher', async () => {
      const watchDir = path.join(tmpDir, 'data');
      await fs.promises.mkdir(watchDir, { recursive: true });

      watcher.addWatch('task-1', 'data');
      await watcher.start();

      expect(watcher.isRunning()).toBe(true);
      expect(watcher.getWatchCount()).toBe(1);

      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it('should not start if already running', async () => {
      await watcher.start();
      await watcher.start(); // second start
      expect(watcher.isRunning()).toBe(true);
    });

    it('should handle stop when not running', () => {
      expect(() => watcher.stop()).not.toThrow();
    });
  });

  describe('addWatch / removeWatch', () => {
    it('should add a watch and track it', async () => {
      watcher.addWatch('task-1', 'workspace/chats', 5000);
      expect(watcher.getTaskWatchCount()).toBe(1);

      await watcher.start();
      expect(watcher.getWatchCount()).toBe(1);
    });

    it('should add multiple watches for different directories', async () => {
      watcher.addWatch('task-1', 'workspace/chats');
      watcher.addWatch('task-2', 'workspace/data');
      expect(watcher.getTaskWatchCount()).toBe(2);

      await watcher.start();
      expect(watcher.getWatchCount()).toBe(2);
    });

    it('should allow multiple tasks to watch the same directory', async () => {
      watcher.addWatch('task-1', 'workspace/chats', 1000);
      watcher.addWatch('task-2', 'workspace/chats', 2000);
      expect(watcher.getTaskWatchCount()).toBe(2);

      await watcher.start();
      // Only one directory watcher for both tasks
      expect(watcher.getWatchCount()).toBe(1);
    });

    it('should remove a watch and stop directory watcher when no tasks remain', async () => {
      watcher.addWatch('task-1', 'workspace/chats');
      await watcher.start();
      expect(watcher.getWatchCount()).toBe(1);

      watcher.removeWatch('task-1');
      expect(watcher.getTaskWatchCount()).toBe(0);
      expect(watcher.getWatchCount()).toBe(0);
    });

    it('should not stop directory watcher when other tasks still watching', async () => {
      watcher.addWatch('task-1', 'workspace/chats');
      watcher.addWatch('task-2', 'workspace/chats');
      await watcher.start();

      watcher.removeWatch('task-1');
      expect(watcher.getWatchCount()).toBe(1);
      expect(watcher.getTaskWatchCount()).toBe(1);
    });

    it('should handle removing non-existent watch gracefully', () => {
      expect(() => watcher.removeWatch('non-existent')).not.toThrow();
    });
  });

  describe('trigger behavior', () => {
    it('should trigger on file creation in watched directory', async () => {
      const watchDir = path.join(tmpDir, 'watched');
      await fs.promises.mkdir(watchDir, { recursive: true });

      watcher.addWatch('task-1', 'watched', 50); // 50ms debounce for fast test
      await watcher.start();

      // Create a file in the watched directory
      await fs.promises.writeFile(path.join(watchDir, 'test.txt'), 'hello');

      // Wait for debounce + trigger
      await vi.waitFor(() => {
        expect(onTrigger).toHaveBeenCalledWith('task-1');
      }, { timeout: 2000 });
    });

    it('should trigger on file change in watched directory', async () => {
      const watchDir = path.join(tmpDir, 'watched');
      await fs.promises.mkdir(watchDir, { recursive: true });
      const filePath = path.join(watchDir, 'existing.txt');
      await fs.promises.writeFile(filePath, 'initial');

      watcher.addWatch('task-1', 'watched', 50);
      await watcher.start();

      // Modify the file
      await fs.promises.writeFile(filePath, 'modified');

      await vi.waitFor(() => {
        expect(onTrigger).toHaveBeenCalledWith('task-1');
      }, { timeout: 2000 });
    });

    it('should debounce multiple rapid file changes', async () => {
      const watchDir = path.join(tmpDir, 'watched');
      await fs.promises.mkdir(watchDir, { recursive: true });

      watcher.addWatch('task-1', 'watched', 200); // 200ms debounce
      await watcher.start();

      // Rapidly create multiple files
      for (let i = 0; i < 5; i++) {
        await fs.promises.writeFile(path.join(watchDir, `file-${i}.txt`), `content-${i}`);
      }

      // Wait for debounce
      await new Promise(resolve => setTimeout(resolve, 500));

      // Should have been called only once (debounced)
      expect(onTrigger).toHaveBeenCalledTimes(1);
      expect(onTrigger).toHaveBeenCalledWith('task-1');
    });

    it('should trigger multiple tasks watching the same directory', async () => {
      const watchDir = path.join(tmpDir, 'watched');
      await fs.promises.mkdir(watchDir, { recursive: true });

      watcher.addWatch('task-1', 'watched', 50);
      watcher.addWatch('task-2', 'watched', 50);
      await watcher.start();

      await fs.promises.writeFile(path.join(watchDir, 'test.txt'), 'hello');

      await vi.waitFor(() => {
        expect(onTrigger).toHaveBeenCalledWith('task-1');
        expect(onTrigger).toHaveBeenCalledWith('task-2');
      }, { timeout: 2000 });
    });

    it('should not trigger after watch is removed', async () => {
      const watchDir = path.join(tmpDir, 'watched');
      await fs.promises.mkdir(watchDir, { recursive: true });

      watcher.addWatch('task-1', 'watched', 50);
      await watcher.start();

      // Remove watch before creating file
      watcher.removeWatch('task-1');

      await fs.promises.writeFile(path.join(watchDir, 'test.txt'), 'hello');

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(onTrigger).not.toHaveBeenCalled();
    });

    it('should not trigger after watcher is stopped', async () => {
      const watchDir = path.join(tmpDir, 'watched');
      await fs.promises.mkdir(watchDir, { recursive: true });

      watcher.addWatch('task-1', 'watched', 50);
      await watcher.start();

      // Stop watcher before creating file
      watcher.stop();

      await fs.promises.writeFile(path.join(watchDir, 'test.txt'), 'hello');

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(onTrigger).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('should handle non-existent watch directory by creating it', async () => {
      watcher.addWatch('task-1', 'non-existent-dir', 50);
      await watcher.start();

      expect(watcher.getWatchCount()).toBe(1);
      // Directory should be created
      expect(fs.existsSync(path.join(tmpDir, 'non-existent-dir'))).toBe(true);
    });

    it('should use default debounce when not specified', async () => {
      const watchDir = path.join(tmpDir, 'watched');
      await fs.promises.mkdir(watchDir, { recursive: true });

      // No debounce specified - uses default 1000ms
      watcher.addWatch('task-1', 'watched');
      await watcher.start();

      await fs.promises.writeFile(path.join(watchDir, 'test.txt'), 'hello');

      // Should trigger within default debounce + buffer
      await vi.waitFor(() => {
        expect(onTrigger).toHaveBeenCalledWith('task-1');
      }, { timeout: 3000 });
    });

    it('should handle absolute watch paths', async () => {
      const absDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'abs-watch-'));

      watcher.addWatch('task-1', absDir, 50);
      await watcher.start();

      await fs.promises.writeFile(path.join(absDir, 'test.txt'), 'hello');

      await vi.waitFor(() => {
        expect(onTrigger).toHaveBeenCalledWith('task-1');
      }, { timeout: 2000 });

      await fs.promises.rm(absDir, { recursive: true, force: true });
    });
  });

  describe('addWatch after start', () => {
    it('should start watching new paths added after start()', async () => {
      await watcher.start();

      const watchDir = path.join(tmpDir, 'late-watch');
      watcher.addWatch('task-1', 'late-watch', 50);

      await fs.promises.writeFile(path.join(watchDir, 'test.txt'), 'hello');

      await vi.waitFor(() => {
        expect(onTrigger).toHaveBeenCalledWith('task-1');
      }, { timeout: 2000 });
    });
  });
});
