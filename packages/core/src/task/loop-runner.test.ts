/**
 * Tests for Loop Runner (Phase 0b).
 *
 * Related #4074: Loop Runner Core.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LoopRunner, type PushToAgentFn } from './loop-runner.js';
import { readLoopState } from './loop-state.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-runner-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock pushToAgent that succeeds every time. */
function successPush(): PushToAgentFn {
  return vi.fn<PushToAgentFn>().mockResolvedValue({ success: true });
}

/** Create a mock pushToAgent that fails every time. */
function failurePush(error = 'API error'): PushToAgentFn {
  return vi.fn<PushToAgentFn>().mockResolvedValue({ success: false, error });
}

/** Create a mock pushToAgent that throws. */
function throwingPush(error = new Error('Connection refused')): PushToAgentFn {
  return vi.fn<PushToAgentFn>().mockRejectedValue(error);
}

/** Create a runner with very short intervals for fast tests. */
function createRunner(pushFn: PushToAgentFn): LoopRunner {
  return new LoopRunner(pushFn, {
    stepIntervalMs: 10,
    retryIntervalMs: 10,
    cleanupDelayMs: 50,
  });
}

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

describe('LoopRunner', () => {
  describe('start', () => {
    it('should return a loopId', async () => {
      const runner = createRunner(successPush());
      const result = await runner.start({
        chatId: 'oc_test',
        workDir: tempDir,
        prompt: 'Do the thing',
      });

      expect(result.loopId).toMatch(/^loop_/);
    });

    it('should persist initial state to disk', async () => {
      const runner = createRunner(successPush());
      const { loopId } = await runner.start({
        chatId: 'oc_test',
        workDir: tempDir,
        prompt: 'Do the thing',
        maxSteps: 3,
      });

      // Wait for loop to complete
      await vi.waitFor(() => {
        expect(runner.has(loopId)).toBe(false);
      }, { timeout: 5000 });

      const state = await readLoopState(tempDir);
      expect(state).not.toBeNull();
      expect(state?.loopId).toBe(loopId);
      expect(state?.state).toBe('completed');
    });

    it('should track the loop in memory while running', async () => {
      const runner = createRunner(successPush());
      const { loopId } = await runner.start({
        chatId: 'oc_test',
        workDir: tempDir,
        prompt: 'test',
        maxSteps: 2,
      });

      // Should be in memory initially
      expect(runner.has(loopId)).toBe(true);

      // Wait for completion
      await vi.waitFor(() => {
        expect(runner.has(loopId)).toBe(false);
      }, { timeout: 5000 });
    });
  });

  // -------------------------------------------------------------------------
  // Normal execution
  // -------------------------------------------------------------------------

  describe('normal loop execution', () => {
    it('should complete all steps and reach completed state', async () => {
      const push = successPush();
      const runner = createRunner(push);
      const { loopId } = await runner.start({
        chatId: 'oc_test',
        workDir: tempDir,
        prompt: 'test',
        maxSteps: 3,
      });

      await vi.waitFor(() => {
        expect(runner.has(loopId)).toBe(false);
      }, { timeout: 5000 });

      const state = await readLoopState(tempDir);
      expect(state?.state).toBe('completed');
      expect(state?.currentStep).toBe(3);
      expect(state?.steps).toHaveLength(3);

      // All steps should be successful
      for (const step of state?.steps ?? []) {
        expect(step.result).toBe('success');
      }

      // pushToAgent should have been called exactly maxSteps times
      expect(push).toHaveBeenCalledTimes(3);
    });

    it('should use the same prompt for every step', async () => {
      const push = successPush();
      const runner = createRunner(push);
      await runner.start({
        chatId: 'oc_abc',
        workDir: tempDir,
        prompt: 'Fix the bug',
        maxSteps: 2,
      });

      await vi.waitFor(async () => {
        const state = await readLoopState(tempDir);
        expect(state?.state).toBe('completed');
      }, { timeout: 5000 });

      expect(push).toHaveBeenCalledWith('oc_abc', 'Fix the bug');
    });
  });

  // -------------------------------------------------------------------------
  // pushToAgent failure handling
  // -------------------------------------------------------------------------

  describe('push failure', () => {
    it('should treat pushToAgent { success: false } as failure', async () => {
      const push = failurePush('Rate limited');
      const runner = createRunner(push);
      const { loopId } = await runner.start({
        chatId: 'oc_test',
        workDir: tempDir,
        prompt: 'test',
        maxSteps: 5,
        maxConsecutiveFailures: 2,
      });

      await vi.waitFor(() => {
        expect(runner.has(loopId)).toBe(false);
      }, { timeout: 5000 });

      const state = await readLoopState(tempDir);
      expect(state?.state).toBe('failed');
      expect(state?.consecutiveFailures).toBe(2);
      // Should have stopped after 2 consecutive failures (not 5 steps)
      expect(state?.currentStep).toBe(2);
    });

    it('should treat thrown exceptions as failure', async () => {
      const push = throwingPush(new Error('Connection refused'));
      const runner = createRunner(push);
      const { loopId } = await runner.start({
        chatId: 'oc_test',
        workDir: tempDir,
        prompt: 'test',
        maxSteps: 5,
        maxConsecutiveFailures: 1,
      });

      await vi.waitFor(() => {
        expect(runner.has(loopId)).toBe(false);
      }, { timeout: 5000 });

      const state = await readLoopState(tempDir);
      expect(state?.state).toBe('failed');
      expect(state?.steps[0]?.error).toBe('Connection refused');
    });
  });

  // -------------------------------------------------------------------------
  // Consecutive failures
  // -------------------------------------------------------------------------

  describe('consecutive failures', () => {
    it('should reset consecutive failures on success', async () => {
      // Fail, fail, succeed, succeed
      const results = [
        { success: false, error: 'err1' },
        { success: false, error: 'err2' },
        { success: true },
        { success: true },
      ];
      const push = vi.fn<PushToAgentFn>().mockImplementation(() => {
        const r = results.shift();
        return Promise.resolve(r ?? { success: true });
      });

      const runner = createRunner(push);
      const { loopId } = await runner.start({
        chatId: 'oc_test',
        workDir: tempDir,
        prompt: 'test',
        maxSteps: 4,
        maxConsecutiveFailures: 3,
      });

      await vi.waitFor(() => {
        expect(runner.has(loopId)).toBe(false);
      }, { timeout: 5000 });

      const state = await readLoopState(tempDir);
      expect(state?.state).toBe('completed');
      expect(state?.currentStep).toBe(4);
      expect(state?.consecutiveFailures).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------------

  describe('stop', () => {
    it('should stop a running loop', async () => {
      // Use a push that takes time so we can stop mid-execution
      const push = vi.fn<PushToAgentFn>().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 200)),
      );
      const runner = createRunner(push);
      const { loopId } = await runner.start({
        chatId: 'oc_test',
        workDir: tempDir,
        prompt: 'test',
        maxSteps: 100,
      });

      // Wait a bit for first step, then stop
      await new Promise((r) => { setTimeout(r, 50); });
      expect(runner.has(loopId)).toBe(true);

      await runner.stop({ loopId });

      await vi.waitFor(() => {
        expect(runner.has(loopId)).toBe(false);
      }, { timeout: 5000 });

      const state = await readLoopState(tempDir);
      expect(state?.state).toBe('stopped');
    });

    it('should be a no-op for unknown loopId', async () => {
      const runner = createRunner(successPush());
      // Should not throw
      await runner.stop({ loopId: 'nonexistent' });
    });

    it('should stop all loops with stopAll', async () => {
      const push = vi.fn<PushToAgentFn>().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 200)),
      );
      const runner = createRunner(push);

      const dir1 = path.join(tempDir, 'loop1');
      const dir2 = path.join(tempDir, 'loop2');
      await fs.mkdir(dir1, { recursive: true });
      await fs.mkdir(dir2, { recursive: true });

      const r1 = await runner.start({ chatId: 'oc_1', workDir: dir1, prompt: 'p1', maxSteps: 100 });
      const r2 = await runner.start({ chatId: 'oc_2', workDir: dir2, prompt: 'p2', maxSteps: 100 });

      expect(runner.has(r1.loopId)).toBe(true);
      expect(runner.has(r2.loopId)).toBe(true);

      await runner.stopAll();

      await vi.waitFor(() => {
        expect(runner.has(r1.loopId)).toBe(false);
        expect(runner.has(r2.loopId)).toBe(false);
      }, { timeout: 5000 });
    });
  });

  // -------------------------------------------------------------------------
  // status()
  // -------------------------------------------------------------------------

  describe('status', () => {
    it('should return status for a running loop', async () => {
      const push = vi.fn<PushToAgentFn>().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 100)),
      );
      const runner = createRunner(push);
      const { loopId } = await runner.start({
        chatId: 'oc_test',
        workDir: tempDir,
        prompt: 'test',
        maxSteps: 100,
      });

      // Check status while running
      const status = runner.status({ loopId });
      expect(status).not.toBeNull();
      expect(status?.loopId).toBe(loopId);
      expect(status?.state).toBe('running');
      expect(status?.totalSteps).toBe(100);

      // Clean up
      await runner.stop({ loopId });
    });

    it('should return null for unknown loop', () => {
      const runner = createRunner(successPush());
      expect(runner.status({ loopId: 'nonexistent' })).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // getState()
  // -------------------------------------------------------------------------

  describe('getState', () => {
    it('should return state for a running loop', async () => {
      const push = vi.fn<PushToAgentFn>().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 100)),
      );
      const runner = createRunner(push);
      const { loopId } = await runner.start({
        chatId: 'oc_test',
        workDir: tempDir,
        prompt: 'test',
        maxSteps: 100,
      });

      const state = runner.getState(loopId);
      expect(state).not.toBeNull();
      expect(state?.loopId).toBe(loopId);
      expect(state?.prompt).toBe('test');

      await runner.stop({ loopId });
    });

    it('should return null for unknown loop', () => {
      const runner = createRunner(successPush());
      expect(runner.getState('nonexistent')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Memory cleanup
  // -------------------------------------------------------------------------

  describe('memory cleanup', () => {
    it('should remove completed loops from memory after delay', async () => {
      const runner = createRunner(successPush());
      const { loopId } = await runner.start({
        chatId: 'oc_test',
        workDir: tempDir,
        prompt: 'test',
        maxSteps: 1,
      });

      // Wait for completion + cleanup delay
      await vi.waitFor(() => {
        expect(runner.has(loopId)).toBe(false);
      }, { timeout: 5000 });

      // State should still be on disk
      const state = await readLoopState(tempDir);
      expect(state?.state).toBe('completed');
    });
  });

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  describe('timeout', () => {
    it('should terminate when maxDuration is exceeded', async () => {
      const push = vi.fn<PushToAgentFn>().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 200)),
      );
      const runner = createRunner(push);
      const { loopId } = await runner.start({
        chatId: 'oc_test',
        workDir: tempDir,
        prompt: 'test',
        maxSteps: 100,
        maxDuration: '0.1s', // 100ms — will timeout after first step
      });

      await vi.waitFor(() => {
        expect(runner.has(loopId)).toBe(false);
      }, { timeout: 5000 });

      const state = await readLoopState(tempDir);
      expect(state?.state).toBe('timeout');
    });
  });

  // -------------------------------------------------------------------------
  // maxSteps semantics
  // -------------------------------------------------------------------------

  describe('maxSteps semantics', () => {
    it('should count all attempts including failures toward maxSteps', async () => {
      // Alternating: fail, succeed, fail, succeed
      const results = [
        { success: false, error: 'err' },
        { success: true },
        { success: false, error: 'err' },
        { success: true },
      ];
      const push = vi.fn<PushToAgentFn>().mockImplementation(() => {
        const r = results.shift();
        return Promise.resolve(r ?? { success: true });
      });

      const runner = createRunner(push);
      const { loopId } = await runner.start({
        chatId: 'oc_test',
        workDir: tempDir,
        prompt: 'test',
        maxSteps: 4,
        maxConsecutiveFailures: 5, // High enough to not trigger
      });

      await vi.waitFor(() => {
        expect(runner.has(loopId)).toBe(false);
      }, { timeout: 5000 });

      const state = await readLoopState(tempDir);
      expect(state?.state).toBe('completed');
      expect(state?.currentStep).toBe(4);
      expect(push).toHaveBeenCalledTimes(4);
    });
  });
});
