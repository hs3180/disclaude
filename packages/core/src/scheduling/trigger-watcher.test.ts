/**
 * Tests for TriggerWatcher.
 *
 * Verifies event-driven schedule triggering via signal files.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { TriggerWatcher } from './trigger-watcher.js';
import type { Scheduler } from './scheduler.js';

async function mkdir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function rmdir(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
}

describe('TriggerWatcher', () => {
  let tmpDir: string;
  let triggersDir: string;
  let mockOnTrigger: ReturnType<typeof vi.fn>;
  let watcher: TriggerWatcher;

  beforeEach(async () => {
    tmpDir = path.join(process.env['TMPDIR'] || '/tmp', `tw-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    triggersDir = path.join(tmpDir, '.triggers');
    await mkdir(tmpDir);
    mockOnTrigger = vi.fn().mockResolvedValue(undefined);
    watcher = new TriggerWatcher({
      schedulesDir: tmpDir,
      onTrigger: mockOnTrigger,
      debounceMs: 50,
    });
  });

  afterEach(async () => {
    watcher.stop();
    await rmdir(tmpDir);
  });

  describe('constructor', () => {
    it('should create TriggerWatcher with triggersDir set to .triggers subdirectory', () => {
      expect(watcher.getTriggersDir()).toBe(triggersDir);
    });

    it('should not be running initially', () => {
      expect(watcher.isRunning()).toBe(false);
    });
  });

  describe('start / stop', () => {
    it('should start and set running to true', async () => {
      await watcher.start();
      expect(watcher.isRunning()).toBe(true);
    });

    it('should create .triggers directory on start', async () => {
      await watcher.start();
      const stat = await fs.stat(triggersDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should not start if already running', async () => {
      await watcher.start();
      await watcher.start(); // second start
      // No error thrown
    });

    it('should stop and set running to false', async () => {
      await watcher.start();
      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it('should handle stop when not running', () => {
      expect(() => watcher.stop()).not.toThrow();
    });
  });

  describe('trigger signal processing', () => {
    it('should process existing trigger files on start', async () => {
      // Write a trigger before starting watcher
      await mkdir(triggersDir);
      await TriggerWatcher.writeTrigger(tmpDir, 'chats-activation', 'test-setup');

      await watcher.start();

      // Wait for processing
      await vi.waitFor(() => {
        expect(mockOnTrigger).toHaveBeenCalledTimes(1);
      }, { timeout: 3000 });

      expect(mockOnTrigger).toHaveBeenCalledWith('chats-activation', 'test-setup');
    });

    it('should process new trigger files written after start', async () => {
      await watcher.start();

      // Write trigger after watcher started
      await TriggerWatcher.writeTrigger(tmpDir, 'pr-scanner', 'test-runtime');

      await vi.waitFor(() => {
        expect(mockOnTrigger).toHaveBeenCalledTimes(1);
      }, { timeout: 3000 });

      expect(mockOnTrigger).toHaveBeenCalledWith('pr-scanner', 'test-runtime');
    });

    it('should delete trigger file after processing', async () => {
      await watcher.start();

      await TriggerWatcher.writeTrigger(tmpDir, 'cleanup', 'test');
      await vi.waitFor(() => {
        expect(mockOnTrigger).toHaveBeenCalledTimes(1);
      }, { timeout: 3000 });

      // Trigger file should be deleted
      const triggerPath = path.join(triggersDir, 'cleanup.trigger');
      await expect(fs.access(triggerPath)).rejects.toThrow();
    });

    it('should handle trigger file with no JSON content', async () => {
      await watcher.start();

      // Write empty trigger file
      const triggerPath = path.join(triggersDir, 'empty.trigger');
      await fs.writeFile(triggerPath, '', 'utf-8');

      await vi.waitFor(() => {
        expect(mockOnTrigger).toHaveBeenCalledTimes(1);
      }, { timeout: 3000 });

      expect(mockOnTrigger).toHaveBeenCalledWith('empty', undefined);
    });

    it('should ignore non-.trigger files', async () => {
      await watcher.start();

      await mkdir(triggersDir);
      await fs.writeFile(path.join(triggersDir, 'readme.txt'), 'hello', 'utf-8');
      await fs.writeFile(path.join(triggersDir, 'other.json'), '{}', 'utf-8');

      // Wait a bit to ensure no triggers are called
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(mockOnTrigger).not.toHaveBeenCalled();
    });
  });

  describe('TriggerWatcher.writeTrigger (static)', () => {
    it('should write a valid trigger signal file', async () => {
      await TriggerWatcher.writeTrigger(tmpDir, 'test-schedule', 'skill:chat');

      const triggerPath = path.join(triggersDir, 'test-schedule.trigger');
      const content = await fs.readFile(triggerPath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.triggeredBy).toBe('skill:chat');
      expect(parsed.triggeredAt).toBeDefined();
    });

    it('should create .triggers directory if it does not exist', async () => {
      // .triggers dir doesn't exist yet
      await TriggerWatcher.writeTrigger(tmpDir, 'new-schedule');

      const stat = await fs.stat(triggersDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should use "unknown" as default source', async () => {
      await TriggerWatcher.writeTrigger(tmpDir, 'default-source');

      const triggerPath = path.join(triggersDir, 'default-source.trigger');
      const content = await fs.readFile(triggerPath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.triggeredBy).toBe('unknown');
    });
  });

  describe('integration with Scheduler', () => {
    it('should construct taskId correctly from scheduleName', async () => {
      const mockScheduler = {
        invoke: vi.fn().mockResolvedValue(true),
      } as unknown as Scheduler;

      const integWatcher = new TriggerWatcher({
        schedulesDir: tmpDir,
        onTrigger: async (scheduleName: string, source?: string) => {
          const taskId = `schedule-${scheduleName}`;
          await mockScheduler.invoke(taskId, source ?? 'trigger-signal');
        },
        debounceMs: 50,
      });

      await integWatcher.start();
      await TriggerWatcher.writeTrigger(tmpDir, 'chats-activation', 'skill:chat');

      await vi.waitFor(() => {
        expect(mockScheduler.invoke).toHaveBeenCalledTimes(1);
      }, { timeout: 3000 });

      expect(mockScheduler.invoke).toHaveBeenCalledWith(
        'schedule-chats-activation',
        'skill:chat',
      );

      integWatcher.stop();
    });
  });
});
