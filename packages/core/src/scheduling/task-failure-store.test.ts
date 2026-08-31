/**
 * Unit tests for TaskFailureStore (Issue #4648 residual ⑥).
 *
 * Unlike CooldownManager's tests (which mock fs/promises), these use a REAL
 * temp directory: the entire point of ⑥ is persistence semantics — write
 * shape, reload, stale expiry, corrupted-file tolerance — and mocking the
 * filesystem would test the mocks, not the guarantee. Same approach as
 * schedule-manager.test.ts (real mkdtemp workspace).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TaskFailureStore } from './task-failure-store.js';

describe('TaskFailureStore', () => {
  let tempDir: string;
  let store: TaskFailureStore;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'task-failure-store-test-'));
    store = new TaskFailureStore({ dir: tempDir });
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {
      /* teardown must never fail a test */
    });
  });

  describe('recordFailure', () => {
    it('counts 1, 2, 3... and persists each step to disk', async () => {
      expect(await store.recordFailure('daily-report')).toBe(1);
      expect(await store.recordFailure('daily-report')).toBe(2);
      expect(await store.recordFailure('daily-report')).toBe(3);

      const raw = await fsPromises.readFile(path.join(tempDir, 'daily-report.json'), 'utf-8');
      const record = JSON.parse(raw);
      expect(record.taskId).toBe('daily-report');
      expect(record.consecutiveFailures).toBe(3);
      expect(typeof record.lastFailureAt).toBe('string');
    });

    it('keeps tasks independent', async () => {
      await store.recordFailure('task-a');
      await store.recordFailure('task-a');
      expect(await store.recordFailure('task-b')).toBe(1);
      expect(await store.getStreak('task-a')).toBe(2);
    });

    it('sanitizes task ids into safe filenames', async () => {
      await store.recordFailure('weird/id with spaces');
      const files = await fsPromises.readdir(tempDir);
      // path separators and spaces replaced; file still round-trips by taskId
      expect(files.some((f) => f.endsWith('.json') && !f.includes('/'))).toBe(true);
      expect(await store.getStreak('weird/id with spaces')).toBe(1);
    });
  });

  describe('recordSuccess', () => {
    it('breaks the streak: memory and file both cleared', async () => {
      await store.recordFailure('task-1');
      await store.recordFailure('task-1');

      await store.recordSuccess('task-1');

      expect(await store.getStreak('task-1')).toBe(0);
      await expect(
        fsPromises.readFile(path.join(tempDir, 'task-1.json'), 'utf-8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });

      // counting genuinely restarts at 1 after a success
      expect(await store.recordFailure('task-1')).toBe(1);
    });

    it('is a no-op for a task with no streak', async () => {
      await expect(store.recordSuccess('never-failed')).resolves.toBeUndefined();
    });
  });

  describe('⑥ the actual defect: streaks survive restarts', () => {
    it('a fresh instance restores the persisted streak', async () => {
      await store.recordFailure('crash-looper');
      await store.recordFailure('crash-looper');

      // "Restart": brand-new process would build a brand-new store on the
      // same directory. Pre-⑥ the Scheduler's in-memory map came back empty,
      // so the alert threshold was unreachable under frequent restarts.
      const restarted = new TaskFailureStore({ dir: tempDir });
      expect(await restarted.getStreak('crash-looper')).toBe(2);
      expect(await restarted.recordFailure('crash-looper')).toBe(3);
    });

    it('stale streaks (>30 days) are dropped on load and the file removed', async () => {
      await store.recordFailure('ancient');
      // Age the record past STALE_STREAK_MS (30 days)
      const filePath = path.join(tempDir, 'ancient.json');
      const aged = {
        taskId: 'ancient',
        consecutiveFailures: 2,
        lastFailureAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
      };
      await fsPromises.writeFile(filePath, JSON.stringify(aged), 'utf-8');

      const restarted = new TaskFailureStore({ dir: tempDir });
      expect(await restarted.getStreak('ancient')).toBe(0);
      await expect(fsPromises.readFile(filePath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
      // next failure starts a fresh streak, not 3
      expect(await restarted.recordFailure('ancient')).toBe(1);
    });

    it('corrupted record files are dropped without wedging the store', async () => {
      await fsPromises.writeFile(path.join(tempDir, 'corrupt.json'), '{not json', 'utf-8');

      const restarted = new TaskFailureStore({ dir: tempDir });
      expect(await restarted.getStreak('corrupt')).toBe(0);
      // and the healthy sibling record still loads
      await store.recordFailure('healthy');
      const again = new TaskFailureStore({ dir: tempDir });
      expect(await again.getStreak('healthy')).toBe(1);
    });

    it('records with invalid shapes are treated as corrupted', async () => {
      await fsPromises.writeFile(
        path.join(tempDir, 'bad-shape.json'),
        JSON.stringify({ taskId: 42, consecutiveFailures: 'many' }),
        'utf-8',
      );

      const restarted = new TaskFailureStore({ dir: tempDir });
      expect(await restarted.getStreak('bad-shape')).toBe(0);
    });
  });

  describe('persistence failures never break scheduling', () => {
    it('recordFailure still returns the streak when the directory is unwritable', async () => {
      // Force init against a real dir, then point a second store at a path
      // whose parent is a FILE — mkdir fails, store degrades to memory-only.
      const blockerPath = path.join(tempDir, 'blocker');
      await fsPromises.writeFile(blockerPath, 'not a directory', 'utf-8');
      const degraded = new TaskFailureStore({ dir: path.join(blockerPath, 'sub') });

      await expect(degraded.recordFailure('task-x')).resolves.toBe(1);
      await expect(degraded.recordFailure('task-x')).resolves.toBe(2);
      await expect(degraded.getStreak('task-x')).resolves.toBe(2);
    });
  });
});
