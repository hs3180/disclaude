/**
 * Tests for TriggerManager.
 *
 * Verifies signal-file-based triggering, fs.watch detection,
 * debounce behavior, and consumption of trigger files.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TriggerManager } from './trigger-manager.js';

describe('TriggerManager', () => {
  let tmpDir: string;
  let triggerDir: string;
  let manager: TriggerManager;

  beforeEach(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'trigger-test-'));
    triggerDir = path.join(tmpDir, '.triggers');
    manager = new TriggerManager({ triggerDir });
  });

  afterEach(async () => {
    manager.stop();
    await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('constructor', () => {
    it('should create TriggerManager with triggerDir', () => {
      expect(manager).toBeInstanceOf(TriggerManager);
      expect(manager.getTriggerDir()).toBe(triggerDir);
      expect(manager.isRunning()).toBe(false);
    });
  });

  describe('start / stop', () => {
    it('should start and create trigger directory', async () => {
      await manager.start();
      expect(manager.isRunning()).toBe(true);

      // Verify directory was created
      const stat = await fsPromises.stat(triggerDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should not start if already running', async () => {
      await manager.start();
      await manager.start(); // second start

      // Should only have called mkdir once effectively
      expect(manager.isRunning()).toBe(true);
    });

    it('should stop and clean up resources', async () => {
      await manager.start();
      expect(manager.isRunning()).toBe(true);

      manager.stop();
      expect(manager.isRunning()).toBe(false);
    });

    it('should handle stop when not running', () => {
      expect(() => manager.stop()).not.toThrow();
    });
  });

  describe('trigger', () => {
    it('should write a trigger signal file', async () => {
      await manager.trigger('schedule-test-task');

      // Verify trigger file exists
      const filePath = path.join(triggerDir, 'schedule-test-task.trigger');
      const content = await fsPromises.readFile(filePath, 'utf-8');
      expect(content).toBeTruthy();

      // Verify it's a valid ISO date
      const date = new Date(content);
      expect(date.getTime()).not.toBeNaN();
    });

    it('should sanitize task ID in filename', async () => {
      await manager.trigger('task/with/slashes');

      // Sanitized: slashes become underscores
      const filePath = path.join(triggerDir, 'task_with_slashes.trigger');
      const stat = await fsPromises.stat(filePath);
      expect(stat.isFile()).toBe(true);
    });

    it('should create trigger directory if it does not exist', async () => {
      const newTriggerDir = path.join(tmpDir, 'nested', '.triggers');
      const newManager = new TriggerManager({ triggerDir: newTriggerDir });

      await newManager.trigger('task-1');

      const stat = await fsPromises.stat(newTriggerDir);
      expect(stat.isDirectory()).toBe(true);

      newManager.stop();
    });
  });

  describe('onTrigger callback', () => {
    it('should fire callback when trigger file is detected', async () => {
      const callback = vi.fn();
      manager.onTrigger(callback);
      await manager.start();

      // Write trigger file
      await manager.trigger('schedule-test-task');

      // Wait for fs.watch to detect and process
      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalledWith('schedule-test-task');
      }, { timeout: 3000 });
    });

    it('should support multiple callbacks', async () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      manager.onTrigger(callback1);
      manager.onTrigger(callback2);
      await manager.start();

      await manager.trigger('schedule-multi');

      await vi.waitFor(() => {
        expect(callback1).toHaveBeenCalledWith('schedule-multi');
        expect(callback2).toHaveBeenCalledWith('schedule-multi');
      }, { timeout: 3000 });
    });

    it('should allow unsubscribing via returned function', async () => {
      const callback = vi.fn();
      const unsubscribe = manager.onTrigger(callback);
      await manager.start();

      // Unsubscribe before triggering
      unsubscribe();

      await manager.trigger('schedule-unsub');

      // Wait a bit to ensure the trigger would have been processed
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(callback).not.toHaveBeenCalled();
    });

    it('should handle callback errors gracefully', async () => {
      const errorCallback = vi.fn(() => {
        throw new Error('callback error');
      });
      const goodCallback = vi.fn();
      manager.onTrigger(errorCallback);
      manager.onTrigger(goodCallback);
      await manager.start();

      await manager.trigger('schedule-error');

      // Good callback should still be called even if error callback throws
      await vi.waitFor(() => {
        expect(goodCallback).toHaveBeenCalledWith('schedule-error');
      }, { timeout: 3000 });
    });
  });

  describe('consumeAll', () => {
    it('should return and delete pending trigger files', async () => {
      // Write trigger files directly
      await fsPromises.mkdir(triggerDir, { recursive: true });
      await fsPromises.writeFile(path.join(triggerDir, 'task-1.trigger'), new Date().toISOString());
      await fsPromises.writeFile(path.join(triggerDir, 'task-2.trigger'), new Date().toISOString());

      const triggered = await manager.consumeAll();

      expect(triggered).toHaveLength(2);
      expect(triggered).toContain('task-1');
      expect(triggered).toContain('task-2');

      // Files should be deleted
      const files = await fsPromises.readdir(triggerDir);
      expect(files.filter(f => f.endsWith('.trigger'))).toHaveLength(0);
    });

    it('should return empty array when no trigger files exist', async () => {
      const triggered = await manager.consumeAll();
      expect(triggered).toHaveLength(0);
    });

    it('should ignore non-trigger files', async () => {
      await fsPromises.mkdir(triggerDir, { recursive: true });
      await fsPromises.writeFile(path.join(triggerDir, 'task-1.trigger'), new Date().toISOString());
      await fsPromises.writeFile(path.join(triggerDir, 'other.txt'), 'not a trigger');

      const triggered = await manager.consumeAll();

      expect(triggered).toHaveLength(1);
      expect(triggered).toContain('task-1');
    });
  });

  describe('debounce behavior', () => {
    it('should debounce rapid triggers for the same task', async () => {
      const callback = vi.fn();
      manager.onTrigger(callback);
      await manager.start();

      // Rapidly trigger the same task multiple times
      await manager.trigger('schedule-debounce');
      await manager.trigger('schedule-debounce');
      await manager.trigger('schedule-debounce');

      // Wait for debounce to settle (300ms internal + margin)
      await new Promise(resolve => setTimeout(resolve, 800));

      // Should have been called, but debounced (ideally once, but at least less than 3)
      expect(callback.mock.calls.length).toBeLessThan(3);
    });
  });
});
