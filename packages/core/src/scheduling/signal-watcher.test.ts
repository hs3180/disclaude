/**
 * Tests for SignalWatcher and writeSignal utility.
 *
 * Verifies signal file creation, detection, parsing, and consumption.
 *
 * Issue #1953: Event-driven trigger support.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SignalWatcher, writeSignal, type Signal } from './signal-watcher.js';

describe('SignalWatcher', () => {
  let tmpDir: string;
  let signalsDir: string;
  let onSignal: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-test-'));
    signalsDir = path.join(tmpDir, 'signals');
    onSignal = vi.fn();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('constructor', () => {
    it('should create a SignalWatcher instance', () => {
      const watcher = new SignalWatcher({ signalsDir, onSignal });
      expect(watcher).toBeInstanceOf(SignalWatcher);
      expect(watcher.isRunning()).toBe(false);
    });
  });

  describe('start / stop', () => {
    it('should start and stop the watcher', async () => {
      const watcher = new SignalWatcher({ signalsDir, onSignal });

      await watcher.start();
      expect(watcher.isRunning()).toBe(true);

      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it('should not start if already running', async () => {
      const watcher = new SignalWatcher({ signalsDir, onSignal });

      await watcher.start();
      await watcher.start(); // second start

      // Should still be running
      expect(watcher.isRunning()).toBe(true);

      watcher.stop();
    });

    it('should create the signals directory on start', async () => {
      const watcher = new SignalWatcher({ signalsDir, onSignal });

      await watcher.start();

      const exists = await fs.access(signalsDir).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      watcher.stop();
    });

    it('should handle stop when not running', () => {
      const watcher = new SignalWatcher({ signalsDir, onSignal });
      expect(() => watcher.stop()).not.toThrow();
    });
  });

  describe('signal processing', () => {
    it('should process a valid signal file and call onSignal', async () => {
      const watcher = new SignalWatcher({ signalsDir, onSignal, debounceMs: 10 });
      await watcher.start();

      // Write a signal file
      const signal: Signal = {
        targetTaskId: 'schedule-pr-scanner',
        eventType: 'github.pr.opened',
        payload: { prNumber: 42 },
        timestamp: new Date().toISOString(),
      };

      await fs.writeFile(
        path.join(signalsDir, 'test-signal.json'),
        JSON.stringify(signal),
        'utf-8'
      );

      // Wait for the watcher to process
      await vi.waitFor(() => {
        expect(onSignal).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      const received = onSignal.mock.calls[0][0] as Signal;
      expect(received.targetTaskId).toBe('schedule-pr-scanner');
      expect(received.eventType).toBe('github.pr.opened');
      expect(received.payload).toEqual({ prNumber: 42 });

      watcher.stop();
    });

    it('should consume (delete) signal files after processing', async () => {
      const watcher = new SignalWatcher({ signalsDir, onSignal, debounceMs: 10 });
      await watcher.start();

      const signalPath = path.join(signalsDir, 'consume-test.json');
      await fs.writeFile(
        signalPath,
        JSON.stringify({
          targetTaskId: 'task-1',
          eventType: 'test.event',
          timestamp: new Date().toISOString(),
        }),
        'utf-8'
      );

      await vi.waitFor(() => {
        expect(onSignal).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      // File should be deleted after processing
      const exists = await fs.access(signalPath).then(() => true).catch(() => false);
      expect(exists).toBe(false);

      watcher.stop();
    });

    it('should reject signal files missing targetTaskId', async () => {
      const watcher = new SignalWatcher({ signalsDir, onSignal, debounceMs: 10 });
      await watcher.start();

      await fs.writeFile(
        path.join(signalsDir, 'invalid-no-task.json'),
        JSON.stringify({
          eventType: 'test.event',
          timestamp: new Date().toISOString(),
        }),
        'utf-8'
      );

      // Wait briefly for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      // onSignal should NOT be called
      expect(onSignal).not.toHaveBeenCalled();

      watcher.stop();
    });

    it('should reject signal files missing eventType', async () => {
      const watcher = new SignalWatcher({ signalsDir, onSignal, debounceMs: 10 });
      await watcher.start();

      await fs.writeFile(
        path.join(signalsDir, 'invalid-no-event.json'),
        JSON.stringify({
          targetTaskId: 'task-1',
          timestamp: new Date().toISOString(),
        }),
        'utf-8'
      );

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(onSignal).not.toHaveBeenCalled();

      watcher.stop();
    });

    it('should reject non-JSON files', async () => {
      const watcher = new SignalWatcher({ signalsDir, onSignal, debounceMs: 10 });
      await watcher.start();

      await fs.writeFile(
        path.join(signalsDir, 'bad.json'),
        'this is not json {{{',
        'utf-8'
      );

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(onSignal).not.toHaveBeenCalled();

      watcher.stop();
    });

    it('should auto-generate timestamp if missing', async () => {
      const watcher = new SignalWatcher({ signalsDir, onSignal, debounceMs: 10 });
      await watcher.start();

      await fs.writeFile(
        path.join(signalsDir, 'no-timestamp.json'),
        JSON.stringify({
          targetTaskId: 'task-1',
          eventType: 'test.event',
        }),
        'utf-8'
      );

      await vi.waitFor(() => {
        expect(onSignal).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      const received = onSignal.mock.calls[0][0] as Signal;
      expect(received.timestamp).toBeDefined();
      // Should be a valid ISO date
      expect(new Date(received.timestamp).getTime()).not.toBeNaN();

      watcher.stop();
    });
  });

  describe('existing signal recovery', () => {
    it('should process signals that existed before start', async () => {
      // Write a signal BEFORE starting the watcher
      await fs.mkdir(signalsDir, { recursive: true });
      await fs.writeFile(
        path.join(signalsDir, 'pre-existing.json'),
        JSON.stringify({
          targetTaskId: 'task-existing',
          eventType: 'test.recovery',
          timestamp: new Date().toISOString(),
        }),
        'utf-8'
      );

      const watcher = new SignalWatcher({ signalsDir, onSignal, debounceMs: 10 });
      await watcher.start();

      // Should process the existing signal on start
      await vi.waitFor(() => {
        expect(onSignal).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      const received = onSignal.mock.calls[0][0] as Signal;
      expect(received.targetTaskId).toBe('task-existing');

      watcher.stop();
    });
  });

  describe('non-JSON files', () => {
    it('should ignore files without .json extension', async () => {
      const watcher = new SignalWatcher({ signalsDir, onSignal, debounceMs: 10 });
      await watcher.start();

      // Write a non-JSON file
      await fs.writeFile(
        path.join(signalsDir, 'readme.txt'),
        'Hello World',
        'utf-8'
      );

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(onSignal).not.toHaveBeenCalled();

      watcher.stop();
    });
  });
});

describe('writeSignal', () => {
  let tmpDir: string;
  let signalsDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-write-test-'));
    signalsDir = path.join(tmpDir, 'signals');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('should write a valid signal file', async () => {
    const filePath = await writeSignal(signalsDir, {
      targetTaskId: 'task-write',
      eventType: 'test.write',
      payload: { key: 'value' },
    });

    // File should exist
    const exists = await fs.access(filePath).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    // Content should be valid JSON
    const content = await fs.readFile(filePath, 'utf-8');
    const signal = JSON.parse(content);

    expect(signal.targetTaskId).toBe('task-write');
    expect(signal.eventType).toBe('test.write');
    expect(signal.payload).toEqual({ key: 'value' });
    expect(signal.timestamp).toBeDefined();
  });

  it('should auto-generate timestamp', async () => {
    const filePath = await writeSignal(signalsDir, {
      targetTaskId: 'task-ts',
      eventType: 'test.ts',
    });

    const content = await fs.readFile(filePath, 'utf-8');
    const signal = JSON.parse(content);

    expect(signal.timestamp).toBeDefined();
    expect(new Date(signal.timestamp).getTime()).not.toBeNaN();
  });

  it('should use provided timestamp if given', async () => {
    const customTs = '2026-01-15T10:30:00.000Z';
    const filePath = await writeSignal(signalsDir, {
      targetTaskId: 'task-custom-ts',
      eventType: 'test.custom.ts',
      timestamp: customTs,
    });

    const content = await fs.readFile(filePath, 'utf-8');
    const signal = JSON.parse(content);

    expect(signal.timestamp).toBe(customTs);
  });

  it('should create the signals directory if it does not exist', async () => {
    const nestedDir = path.join(tmpDir, 'a', 'b', 'signals');

    const filePath = await writeSignal(nestedDir, {
      targetTaskId: 'task-nested',
      eventType: 'test.nested',
    });

    const exists = await fs.access(filePath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it('should generate unique filenames for concurrent signals', async () => {
    const paths = await Promise.all([
      writeSignal(signalsDir, {
        targetTaskId: 'task-1',
        eventType: 'test.concurrent',
      }),
      writeSignal(signalsDir, {
        targetTaskId: 'task-2',
        eventType: 'test.concurrent',
      }),
      writeSignal(signalsDir, {
        targetTaskId: 'task-3',
        eventType: 'test.concurrent',
      }),
    ]);

    // All paths should be unique
    const uniquePaths = new Set(paths);
    expect(uniquePaths.size).toBe(3);
  });
});
