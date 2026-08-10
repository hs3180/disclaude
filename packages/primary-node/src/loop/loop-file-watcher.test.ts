/**
 * Tests for LoopFileWatcher (Issue #4283).
 *
 * Verifies: the watcher fires onLoopMd when a LOOP.md is created/changed,
 * debounces repeat events, and ignores non-LOOP.md files.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopFileWatcher } from './loop-file-watcher.js';

describe('LoopFileWatcher (Issue #4283)', () => {
  let dir: string;
  let watcher: LoopFileWatcher;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loopwatch-'));
  });

  afterEach(() => {
    watcher?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fires onLoopMd when a LOOP.md is created', async () => {
    const onLoopMd = vi.fn();
    watcher = new LoopFileWatcher({ loopDir: dir, onLoopMd, debounceMs: 50 });
    await watcher.start();

    writeFileSync(join(dir, 'LOOP.md'), '---\nname: test\nchatId: oc_1\n---\nbody');

    await vi.waitFor(() => {
      expect(onLoopMd).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });

    expect(onLoopMd.mock.calls[0][0]).toContain('LOOP.md');
  });

  it('fires onLoopMd for LOOP.md in a subdirectory', async () => {
    const onLoopMd = vi.fn();
    watcher = new LoopFileWatcher({ loopDir: dir, onLoopMd, debounceMs: 50 });
    await watcher.start();

    mkdirSync(join(dir, 'my-loop'), { recursive: true });
    writeFileSync(join(dir, 'my-loop', 'LOOP.md'), '---\nname: sub\nchatId: oc_2\n---\nbody');

    await vi.waitFor(() => {
      expect(onLoopMd).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });

    expect(onLoopMd.mock.calls[0][0]).toContain('my-loop');
  });

  it('debounces rapid changes to the same file', async () => {
    const onLoopMd = vi.fn();
    watcher = new LoopFileWatcher({ loopDir: dir, onLoopMd, debounceMs: 100 });
    await watcher.start();

    const filePath = join(dir, 'LOOP.md');
    // Write 3 times rapidly — should debounce to 1 call.
    writeFileSync(filePath, 'v1');
    writeFileSync(filePath, 'v2');
    writeFileSync(filePath, 'v3');

    await vi.waitFor(() => {
      expect(onLoopMd).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });
  });

  it('ignores non-LOOP.md files', async () => {
    const onLoopMd = vi.fn();
    watcher = new LoopFileWatcher({ loopDir: dir, onLoopMd, debounceMs: 50 });
    await watcher.start();

    // Write a non-LOOP.md file alongside a LOOP.md sentinel. Waiting for the
    // sentinel's callback proves fs.watch has processed this batch of events,
    // so the README.md event has already been seen and synchronously filtered
    // (basename !== LOOP_MD_FILENAME in the watcher callback). Asserting every
    // recorded call targets LOOP.md confirms README.md never reached the
    // debounced callback — with no fixed wall-clock wait (Issue #4394).
    writeFileSync(join(dir, 'README.md'), 'not a loop file');
    writeFileSync(join(dir, 'LOOP.md'), '---\nname: sentinel\nchatId: oc_s\n---\nbody');

    await vi.waitFor(() => {
      expect(onLoopMd).toHaveBeenCalled();
    }, { timeout: 2000 });

    expect(onLoopMd.mock.calls.every(([p]) => p.endsWith('LOOP.md'))).toBe(true);
  });

  it('stop() prevents further callbacks', async () => {
    const onLoopMd = vi.fn();
    watcher = new LoopFileWatcher({ loopDir: dir, onLoopMd, debounceMs: 50 });
    await watcher.start();

    // Sentinel: prove the watcher was live and delivered a callback before stop.
    writeFileSync(join(dir, 'LOOP.md'), '---\nname: sentinel\nchatId: oc_s\n---\nbody');
    await vi.waitFor(() => {
      expect(onLoopMd).toHaveBeenCalled();
    }, { timeout: 2000 });

    watcher.stop(); // synchronously closes the fs watcher + clears debounce timers
    const callsBefore = onLoopMd.mock.calls.length;

    // A write now has no event source (watcher closed), so onLoopMd cannot be
    // invoked. The closed watcher is a structural guarantee, not a timing race,
    // so no fixed wall-clock wait is needed (Issue #4394).
    writeFileSync(join(dir, 'LOOP.md'), '---\nname: after-stop\n---\nbody');
    expect(onLoopMd.mock.calls.length).toBe(callsBefore);
  });

  it('startup scan fires onLoopMd for a LOOP.md that pre-existed (Issue #4286)', async () => {
    const onLoopMd = vi.fn();
    // Write the LOOP.md BEFORE the watcher starts — its create event is missed
    // by fs.watch, so the startup scan (safety net for missed events) must
    // pick it up.
    writeFileSync(join(dir, 'LOOP.md'), '---\nname: pre\nchatId: oc_pre\n---\nbody');

    watcher = new LoopFileWatcher({ loopDir: dir, onLoopMd, debounceMs: 50 });
    await watcher.start();

    await vi.waitFor(() => {
      expect(onLoopMd).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });
    expect(onLoopMd.mock.calls[0][0]).toContain('LOOP.md');
  });

  it('startup scan discovers a LOOP.md nested deep in a subdirectory', async () => {
    const onLoopMd = vi.fn();
    mkdirSync(join(dir, 'nested', 'deep'), { recursive: true });
    writeFileSync(join(dir, 'nested', 'deep', 'LOOP.md'), '---\nname: deep\nchatId: oc_d\n---\nbody');

    watcher = new LoopFileWatcher({ loopDir: dir, onLoopMd, debounceMs: 50 });
    await watcher.start();

    await vi.waitFor(() => {
      expect(onLoopMd).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });
    expect(onLoopMd.mock.calls[0][0]).toContain('deep');
  });
});
