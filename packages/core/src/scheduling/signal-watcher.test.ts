/**
 * Tests for SignalWatcher.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 * Tests verify signal file detection, context reading, and cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SignalWatcher, type OnTrigger } from './signal-watcher.js';

describe('SignalWatcher', () => {
  let tempDir: string;
  let schedulesDir: string;
  let triggerResults: Array<{ taskId: string; context?: string }>;
  let mockOnTrigger: OnTrigger;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-test-'));
    schedulesDir = path.join(tempDir, 'schedules');
    await fs.mkdir(schedulesDir, { recursive: true });

    triggerResults = [];
    mockOnTrigger = vi.fn().mockImplementation((taskId: string, context?: string) => {
      triggerResults.push({ taskId, context });
      return Promise.resolve({ ok: true });
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('start / stop', () => {
    it('should start and stop cleanly', async () => {
      const watcher = new SignalWatcher({
        schedulesDir,
        onTrigger: mockOnTrigger,
        pollIntervalMs: 100,
      });

      await watcher.start();
      expect(watcher.isRunning()).toBe(true);

      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it('should not start if already running', async () => {
      const watcher = new SignalWatcher({
        schedulesDir,
        onTrigger: mockOnTrigger,
        pollIntervalMs: 100,
      });

      await watcher.start();
      await watcher.start(); // Should not throw

      watcher.stop();
    });

    it('should handle stop when not running', () => {
      const watcher = new SignalWatcher({
        schedulesDir,
        onTrigger: mockOnTrigger,
      });

      expect(() => watcher.stop()).not.toThrow();
    });
  });

  describe('signal file detection', () => {
    it('should detect trigger file and invoke callback', async () => {
      // Create schedule directory with trigger file
      const slug = 'my-task';
      const taskDir = path.join(schedulesDir, slug);
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, '.trigger'), '', 'utf-8');

      const watcher = new SignalWatcher({
        schedulesDir,
        onTrigger: mockOnTrigger,
        pollIntervalMs: 50,
      });

      await watcher.start();

      // Wait for polling to detect the signal
      await vi.waitFor(() => {
        expect(triggerResults.length).toBeGreaterThan(0);
      }, { timeout: 2000 });

      expect(triggerResults[0]).toEqual({
        taskId: 'schedule-my-task',
        context: undefined,
      });

      // Signal file should be cleaned up
      await expect(fs.access(path.join(taskDir, '.trigger'))).rejects.toThrow();

      watcher.stop();
    });

    it('should read trigger context from .trigger.context file', async () => {
      const slug = 'context-task';
      const taskDir = path.join(schedulesDir, slug);
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, '.trigger'), '', 'utf-8');
      await fs.writeFile(
        path.join(taskDir, '.trigger.context'),
        JSON.stringify({ reason: 'PR #42 opened', details: 'New pull request' }),
        'utf-8',
      );

      const watcher = new SignalWatcher({
        schedulesDir,
        onTrigger: mockOnTrigger,
        pollIntervalMs: 50,
      });

      await watcher.start();

      await vi.waitFor(() => {
        expect(triggerResults.length).toBeGreaterThan(0);
      }, { timeout: 2000 });

      expect(triggerResults[0].taskId).toBe('schedule-context-task');
      expect(triggerResults[0].context).toContain('PR #42 opened');
      expect(triggerResults[0].context).toContain('New pull request');

      // Both signal files should be cleaned up
      await expect(fs.access(path.join(taskDir, '.trigger'))).rejects.toThrow();
      await expect(fs.access(path.join(taskDir, '.trigger.context'))).rejects.toThrow();

      watcher.stop();
    });

    it('should skip directories starting with dot', async () => {
      const dotDir = path.join(schedulesDir, '.cooldown');
      await fs.mkdir(dotDir, { recursive: true });
      await fs.writeFile(path.join(dotDir, '.trigger'), '', 'utf-8');

      const watcher = new SignalWatcher({
        schedulesDir,
        onTrigger: mockOnTrigger,
        pollIntervalMs: 50,
      });

      await watcher.start();

      // Wait a bit to ensure polling happens
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(triggerResults.length).toBe(0);

      watcher.stop();
    });

    it('should handle trigger failure gracefully', async () => {
      const failTrigger = vi.fn().mockResolvedValue({ ok: false, error: 'Task not invocable' });

      const slug = 'fail-task';
      const taskDir = path.join(schedulesDir, slug);
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, '.trigger'), '', 'utf-8');

      const watcher = new SignalWatcher({
        schedulesDir,
        onTrigger: failTrigger,
        pollIntervalMs: 50,
      });

      await watcher.start();

      await vi.waitFor(() => {
        expect(failTrigger).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      // Signal file should still be cleaned up even on failure
      await expect(fs.access(path.join(taskDir, '.trigger'))).rejects.toThrow();

      watcher.stop();
    });

    it('should handle invalid JSON in context file gracefully', async () => {
      const slug = 'bad-json';
      const taskDir = path.join(schedulesDir, slug);
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, '.trigger'), '', 'utf-8');
      await fs.writeFile(path.join(taskDir, '.trigger.context'), 'not valid json{', 'utf-8');

      const watcher = new SignalWatcher({
        schedulesDir,
        onTrigger: mockOnTrigger,
        pollIntervalMs: 50,
      });

      await watcher.start();

      await vi.waitFor(() => {
        expect(triggerResults.length).toBeGreaterThan(0);
      }, { timeout: 2000 });

      // Should still trigger, just without context
      expect(triggerResults[0].taskId).toBe('schedule-bad-json');
      expect(triggerResults[0].context).toBeUndefined();

      watcher.stop();
    });
  });

  describe('writeSignal utility', () => {
    it('should write a simple trigger file', async () => {
      await SignalWatcher.writeSignal(schedulesDir, 'my-task');

      const triggerFile = path.join(schedulesDir, 'my-task', '.trigger');
      await expect(fs.access(triggerFile)).resolves.toBeUndefined();
    });

    it('should write trigger with context', async () => {
      await SignalWatcher.writeSignal(schedulesDir, 'my-task', {
        reason: 'PR opened',
        details: 'PR #42 needs review',
      });

      const contextFile = path.join(schedulesDir, 'my-task', '.trigger.context');
      const content = await fs.readFile(contextFile, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.reason).toBe('PR opened');
      expect(parsed.details).toBe('PR #42 needs review');
    });
  });
});
