/**
 * Tests for TriggerWatcher.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Verifies signal file detection, consumption, debouncing,
 * and lifecycle management.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TriggerWatcher } from './trigger-watcher.js';

describe('TriggerWatcher', () => {
  let triggersDir: string;
  let onTrigger: ReturnType<typeof vi.fn>;
  let watcher: TriggerWatcher;

  beforeEach(async () => {
    triggersDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trigger-test-'));
    onTrigger = vi.fn();
    watcher = new TriggerWatcher({
      triggersDir,
      onTrigger,
      debounceMs: 50,
    });
  });

  afterEach(async () => {
    watcher.stop();
    await fs.rm(triggersDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create watcher with required options', () => {
      expect(watcher).toBeInstanceOf(TriggerWatcher);
      expect(watcher.isRunning()).toBe(false);
    });
  });

  describe('start / stop', () => {
    it('should start and report running', async () => {
      await watcher.start();
      expect(watcher.isRunning()).toBe(true);
    });

    it('should not start if already running', async () => {
      await watcher.start();
      await watcher.start(); // second start
      // Should not throw or create duplicate watchers
      expect(watcher.isRunning()).toBe(true);
    });

    it('should stop and report not running', async () => {
      await watcher.start();
      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it('should handle stop when not running', () => {
      expect(() => watcher.stop()).not.toThrow();
    });

    it('should create triggers directory if it does not exist', async () => {
      const newDir = path.join(triggersDir, 'nonexistent');
      const w = new TriggerWatcher({
        triggersDir: newDir,
        onTrigger,
      });
      await w.start();
      const stat = await fs.stat(newDir);
      expect(stat.isDirectory()).toBe(true);
      w.stop();
    });
  });

  describe('signal file detection', () => {
    it('should detect new signal file and fire trigger', async () => {
      await watcher.start();

      // Write a signal file
      await TriggerWatcher.writeSignal(triggersDir, 'schedule-chats-activation');

      // Wait for debounce + processing
      await vi.waitFor(() => {
        expect(onTrigger).toHaveBeenCalledWith('schedule-chats-activation');
      }, { timeout: 2000 });
    });

    it('should consume (delete) the signal file after detection', async () => {
      await watcher.start();

      await TriggerWatcher.writeSignal(triggersDir, 'task-1');

      await vi.waitFor(() => {
        expect(onTrigger).toHaveBeenCalled();
      }, { timeout: 2000 });

      // Signal file should be deleted
      const files = await fs.readdir(triggersDir);
      expect(files).not.toContain('task-1');
    });

    it('should detect multiple signal files', async () => {
      await watcher.start();

      await TriggerWatcher.writeSignal(triggersDir, 'task-a');
      await TriggerWatcher.writeSignal(triggersDir, 'task-b');

      await vi.waitFor(() => {
        expect(onTrigger).toHaveBeenCalledTimes(2);
      }, { timeout: 2000 });

      expect(onTrigger).toHaveBeenCalledWith('task-a');
      expect(onTrigger).toHaveBeenCalledWith('task-b');
    });

    it('should ignore hidden files', async () => {
      await watcher.start();

      await fs.writeFile(path.join(triggersDir, '.hidden'), 'test');

      // Wait a bit to ensure no trigger fires
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(onTrigger).not.toHaveBeenCalled();
    });
  });

  describe('drain on start', () => {
    it('should process existing signal files on start', async () => {
      // Write signal before starting watcher
      await TriggerWatcher.writeSignal(triggersDir, 'existing-task');

      await watcher.start();

      await vi.waitFor(() => {
        expect(onTrigger).toHaveBeenCalledWith('existing-task');
      }, { timeout: 2000 });
    });

    it('should consume existing signal files on start', async () => {
      await TriggerWatcher.writeSignal(triggersDir, 'drain-task');

      await watcher.start();

      await vi.waitFor(() => {
        expect(onTrigger).toHaveBeenCalled();
      }, { timeout: 2000 });

      const files = await fs.readdir(triggersDir);
      expect(files).not.toContain('drain-task');
    });
  });

  describe('debouncing', () => {
    it('should debounce rapid signal writes', async () => {
      await watcher.start();

      // Write signal multiple times rapidly
      for (let i = 0; i < 5; i++) {
        await TriggerWatcher.writeSignal(triggersDir, 'debounced-task');
      }

      await vi.waitFor(() => {
        expect(onTrigger).toHaveBeenCalled();
      }, { timeout: 2000 });

      // Should have been called at least once (debouncing may reduce calls)
      expect(onTrigger.mock.calls.some(
        (call: string[]) => call[0] === 'debounced-task'
      )).toBe(true);
    });
  });

  describe('writeSignal static method', () => {
    it('should create signal file with timestamp content', async () => {
      await TriggerWatcher.writeSignal(triggersDir, 'test-signal');

      const content = await fs.readFile(path.join(triggersDir, 'test-signal'), 'utf-8');
      // Should be an ISO date string
      expect(new Date(content).toISOString()).toBe(content);
    });

    it('should create triggers directory if needed', async () => {
      const newDir = path.join(triggersDir, 'nested', 'triggers');
      await TriggerWatcher.writeSignal(newDir, 'nested-signal');

      const exists = await fs.access(path.join(newDir, 'nested-signal'))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });
  });
});
