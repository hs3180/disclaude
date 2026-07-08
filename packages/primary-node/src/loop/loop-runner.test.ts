import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LoopRunner } from './loop-runner.js';

describe('LoopRunner', () => {
  let mockPush: ReturnType<typeof vi.fn>;
  let runner: LoopRunner;

  beforeEach(() => {
    mockPush = vi.fn().mockResolvedValue(undefined);
    runner = new LoopRunner(mockPush);
  });

  afterEach(() => {
    runner.dispose();
  });

  describe('start', () => {
    it('should return a loop ID', () => {
      const result = runner.start({
        chatId: 'oc_test',
        prompt: 'Continue the task',
      });
      expect(result.loopId).toMatch(/^loop-\d+-\d+$/);
    });

    it('should start executing the loop', async () => {
      runner.start({
        chatId: 'oc_test',
        prompt: 'Step',
        maxSteps: 2,
        stepIntervalMs: 10,
      });

      // Wait for loop to complete
      await vi.waitFor(() => {
        expect(mockPush).toHaveBeenCalledTimes(2);
      }, { timeout: 2000 });
    });

    it('should use default maxSteps of 10', async () => {
      runner.start({
        chatId: 'oc_test',
        prompt: 'Step',
        stepIntervalMs: 10,
      });

      // Check first call happens
      await vi.waitFor(() => {
        expect(mockPush).toHaveBeenCalled();
      }, { timeout: 1000 });
    });

    it('should pass correct chatId and prompt to pushCallback', async () => {
      runner.start({
        chatId: 'oc_abc',
        prompt: 'Hello agent',
        maxSteps: 1,
      });

      await vi.waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('oc_abc', 'Hello agent');
      }, { timeout: 1000 });
    });
  });

  describe('stop', () => {
    it('should stop a running loop', async () => {
      const { loopId } = runner.start({
        chatId: 'oc_test',
        prompt: 'Step',
        maxSteps: 100,
        stepIntervalMs: 50,
      });

      // Wait for first step
      await vi.waitFor(() => {
        expect(mockPush).toHaveBeenCalled();
      }, { timeout: 1000 });

      const callCount = mockPush.mock.calls.length;
      runner.stop(loopId);

      // Wait a bit and verify no more calls
      await new Promise((r) => setTimeout(r, 150));
      expect(mockPush.mock.calls.length).toBe(callCount);

      const status = runner.status(loopId);
      expect(status?.state).toBe('stopped');
    });

    it('should handle stopping an unknown loop gracefully', () => {
      expect(() => runner.stop('unknown')).not.toThrow();
    });

    it('should return true when stopping a known loop and false for an unknown one', () => {
      const { loopId } = runner.start({
        chatId: 'oc_test',
        prompt: 'Step',
        maxSteps: 100,
        stepIntervalMs: 50,
      });
      expect(runner.stop(loopId)).toBe(true);
      // stopping again is still "found" (idempotent), the loop is already stopped
      expect(runner.stop(loopId)).toBe(true);
      expect(runner.stop('does-not-exist')).toBe(false);
    });
  });

  describe('status', () => {
    it('should return null for unknown loop', () => {
      expect(runner.status('nonexistent')).toBeNull();
    });

    it('should return running status during execution', () => {
      const { loopId } = runner.start({
        chatId: 'oc_test',
        prompt: 'Step',
        maxSteps: 100,
        stepIntervalMs: 100,
      });

      // Check immediately — should be running
      const status = runner.status(loopId);
      expect(status).not.toBeNull();
      expect(status!.loopId).toBe(loopId);
      expect(status!.state).toBe('running');
      expect(status!.totalSteps).toBe(100);

      runner.stop(loopId);
    });

    it('should show completed status after all steps', async () => {
      const { loopId } = runner.start({
        chatId: 'oc_test',
        prompt: 'Step',
        maxSteps: 2,
        stepIntervalMs: 10,
      });

      await vi.waitFor(() => {
        const status = runner.status(loopId);
        expect(status?.state).toBe('completed');
      }, { timeout: 2000 });
    });
  });

  describe('maxDurationMs', () => {
    it('should stop when duration is exceeded', async () => {
      const { loopId } = runner.start({
        chatId: 'oc_test',
        prompt: 'Step',
        maxSteps: 100,
        maxDurationMs: 50,
        stepIntervalMs: 30,
      });

      await vi.waitFor(() => {
        const status = runner.status(loopId);
        expect(status?.state).toBe('completed');
      }, { timeout: 2000 });

      const status = runner.status(loopId);
      expect(status!.currentStep).toBeLessThan(100);
    });
  });

  describe('error handling', () => {
    it('should set state to error when pushCallback throws', async () => {
      mockPush.mockRejectedValue(new Error('Push failed'));

      const { loopId } = runner.start({
        chatId: 'oc_test',
        prompt: 'Step',
        maxSteps: 3,
        stepIntervalMs: 10,
      });

      await vi.waitFor(() => {
        const status = runner.status(loopId);
        expect(status?.state).toBe('error');
      }, { timeout: 2000 });
    });
  });

  describe('cleanup', () => {
    it('should remove old completed loops', async () => {
      const { loopId } = runner.start({
        chatId: 'oc_test',
        prompt: 'Step',
        maxSteps: 1,
        stepIntervalMs: 10,
      });

      await vi.waitFor(() => {
        expect(runner.status(loopId)?.state).toBe('completed');
      }, { timeout: 2000 });

      // Cleanup with very short maxAge to remove it
      const removed = runner.cleanup(1);
      expect(removed).toBe(1);
      expect(runner.status(loopId)).toBeNull();
    });

    it('should not remove running loops', () => {
      const { loopId } = runner.start({
        chatId: 'oc_test',
        prompt: 'Step',
        maxSteps: 100,
        stepIntervalMs: 100,
      });

      const removed = runner.cleanup(0);
      expect(removed).toBe(0);
      expect(runner.status(loopId)).not.toBeNull();

      runner.stop(loopId);
    });
  });

  describe('dispose and periodic cleanup', () => {
    it('dispose clears the cleanup timer and is idempotent', () => {
      const clearSpy = vi.spyOn(globalThis, 'clearInterval');
      runner.dispose();
      expect(clearSpy).toHaveBeenCalledTimes(1);
      // second call is a no-op (timer already cleared)
      expect(() => runner.dispose()).not.toThrow();
      expect(clearSpy).toHaveBeenCalledTimes(1);
      clearSpy.mockRestore();
    });

    it('periodically prunes finished loops via the cleanup interval', async () => {
      const sweeper = new LoopRunner(mockPush, { cleanupIntervalMs: 40, cleanupMaxAgeMs: 1 });

      // A finished loop (>1ms old) is evicted by the periodic sweep.
      const finished = sweeper.start({
        chatId: 'oc_test',
        prompt: 'done',
        maxSteps: 1,
        stepIntervalMs: 5,
      });
      await vi.waitFor(() => {
        expect(sweeper.status(finished.loopId)).toBeNull();
      }, { timeout: 2000 });

      // A still-running loop survives the sweep (cleanup only removes non-running loops).
      const running = sweeper.start({
        chatId: 'oc_test',
        prompt: 'run',
        maxSteps: 100,
        stepIntervalMs: 50,
      });
      await new Promise((r) => setTimeout(r, 120)); // > cleanupInterval, sweep has fired
      expect(sweeper.status(running.loopId)?.state).toBe('running');

      sweeper.stop(running.loopId);
      sweeper.dispose();
    });
  });

  describe('waitForInterval abort-listener cleanup (Issue #4063)', () => {
    it('removes the per-step abort listener once the interval times out', async () => {
      // Each inter-step wait attaches an 'abort' listener to the loop's
      // AbortSignal. The fixed waitForInterval removes it on the timeout path
      // so a long-running loop does not accumulate one listener per step.
      const addSpy = vi.spyOn(EventTarget.prototype, 'addEventListener');
      const removeSpy = vi.spyOn(EventTarget.prototype, 'removeEventListener');

      runner.start({
        chatId: 'oc_listeners',
        prompt: 'step',
        maxSteps: 5, // -> 4 inter-step waits
        stepIntervalMs: 5,
      });
      await vi.waitFor(() => {
        expect(mockPush).toHaveBeenCalledTimes(5);
      }, { timeout: 2000 });
      // Let the final timer's removeEventListener flush.
      await new Promise((r) => setTimeout(r, 20));

      const abortAdds = addSpy.mock.calls.filter(([event]) => event === 'abort').length;
      const abortRemoves = removeSpy.mock.calls.filter(([event]) => event === 'abort').length;

      expect(abortAdds).toBe(4); // one per inter-step wait
      expect(abortRemoves).toBe(4); // each removed on its timeout path

      addSpy.mockRestore();
      removeSpy.mockRestore();
    });
  });

  describe('concurrent loops', () => {
    it('should run multiple loops with unique IDs independently', async () => {
      const result1 = runner.start({
        chatId: 'oc_a',
        prompt: 'Task A',
        maxSteps: 3,
        stepIntervalMs: 20,
      });
      const result2 = runner.start({
        chatId: 'oc_b',
        prompt: 'Task B',
        maxSteps: 3,
        stepIntervalMs: 20,
      });

      expect(result1.loopId).not.toBe(result2.loopId);

      // Both should complete independently
      await vi.waitFor(() => {
        expect(runner.status(result1.loopId)?.state).toBe('completed');
        expect(runner.status(result2.loopId)?.state).toBe('completed');
      }, { timeout: 3000 });

      // Both should have pushed to their respective chatIds
      expect(mockPush).toHaveBeenCalledWith('oc_a', 'Task A');
      expect(mockPush).toHaveBeenCalledWith('oc_b', 'Task B');
    });

    it('should stop one loop without affecting others', async () => {
      const result1 = runner.start({
        chatId: 'oc_a',
        prompt: 'Task A',
        maxSteps: 100,
        stepIntervalMs: 50,
      });
      const result2 = runner.start({
        chatId: 'oc_b',
        prompt: 'Task B',
        maxSteps: 2,
        stepIntervalMs: 20,
      });

      // Stop loop 1
      runner.stop(result1.loopId);
      expect(runner.status(result1.loopId)?.state).toBe('stopped');

      // Loop 2 should still complete normally
      await vi.waitFor(() => {
        expect(runner.status(result2.loopId)?.state).toBe('completed');
      }, { timeout: 2000 });
    });
  });

  describe('parameter validation', () => {
    it('should clamp maxSteps to at least 1', async () => {
      const { loopId } = runner.start({
        chatId: 'oc_test',
        prompt: 'Step',
        maxSteps: 0,
        stepIntervalMs: 10,
      });

      await vi.waitFor(() => {
        const status = runner.status(loopId);
        expect(status?.state).toBe('completed');
      }, { timeout: 1000 });

      // With maxSteps clamped to 1, should have pushed exactly once
      expect(mockPush).toHaveBeenCalledTimes(1);
    });

    it('should clamp negative maxSteps to 1', async () => {
      const { loopId } = runner.start({
        chatId: 'oc_test',
        prompt: 'Step',
        maxSteps: -5,
        stepIntervalMs: 10,
      });

      await vi.waitFor(() => {
        expect(runner.status(loopId)?.state).toBe('completed');
      }, { timeout: 1000 });
      expect(mockPush).toHaveBeenCalledTimes(1);
    });
  });

  describe('startFromLoopMd (Issue #4193)', () => {
    let tmpDir: string;
    let loopMdPath: string;
    let mdRunner: LoopRunner;
    let mdPush: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'loopmd-'));
      loopMdPath = join(tmpDir, 'LOOP.md');
      mdPush = vi.fn();
      mdRunner = new LoopRunner(mdPush);
    });

    afterEach(() => {
      mdRunner.dispose();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    /** Write a LOOP.md with the given prompt body and frontmatter overrides. */
    const writeLoopMd = (body: string, extra: Record<string, string | number> = {}): void => {
      const fields: Record<string, string | number> = { name: 'test', chatId: 'oc_md', ...extra };
      const frontmatter = Object.entries(fields)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
      writeFileSync(loopMdPath, `---\n${frontmatter}\n---\n\n${body}\n`, 'utf-8');
    };

    it('reads chatId + prompt from LOOP.md and pushes them', async () => {
      writeLoopMd('do the thing', { maxSteps: 2, stepInterval: '5ms' });

      const { loopId } = mdRunner.startFromLoopMd(loopMdPath);
      expect(loopId).toMatch(/^loop-\d+-\d+$/);

      await vi.waitFor(() => expect(mdPush).toHaveBeenCalledTimes(2), { timeout: 2000 });
      // chatId came from the frontmatter; prompt came from the body.
      expect(mdPush).toHaveBeenCalledWith('oc_md', 'do the thing');
    });

    it('re-reads the prompt each iteration (mid-loop edits are picked up)', async () => {
      writeLoopMd('first prompt', { maxSteps: 2, stepInterval: '5ms' });

      let calls = 0;
      mdPush.mockImplementation((_chatId: string, _message: string) => {
        calls += 1;
        if (calls === 1) {
          // An editor changes the prompt between step 1 and step 2.
          writeLoopMd('second prompt', { maxSteps: 2, stepInterval: '5ms' });
        }
      });

      mdRunner.startFromLoopMd(loopMdPath);

      await vi.waitFor(() => expect(mdPush).toHaveBeenCalledTimes(2), { timeout: 2000 });
      const messages = mdPush.mock.calls.map(([, message]) => message);
      expect(messages).toEqual(['first prompt', 'second prompt']);
    });

    it('falls back to the last known prompt when LOOP.md briefly becomes unreadable', async () => {
      writeLoopMd('stable', { maxSteps: 3, stepInterval: '5ms' });

      let calls = 0;
      mdPush.mockImplementation((_chatId: string, _message: string) => {
        calls += 1;
        if (calls === 2) {
          // Remove the file so the next iteration's re-read fails.
          rmSync(loopMdPath, { force: true });
        }
      });

      const { loopId } = mdRunner.startFromLoopMd(loopMdPath);

      await vi.waitFor(() => expect(mdRunner.status(loopId)?.state).toBe('completed'), { timeout: 2000 });
      // All three steps pushed; the third used the fallback (no crash, no error state).
      expect(mdPush).toHaveBeenCalledTimes(3);
      expect(mdPush.mock.calls.every(([, message]) => message === 'stable')).toBe(true);
    });

    it('throws when the LOOP.md path does not exist', () => {
      expect(() => mdRunner.startFromLoopMd(join(tmpDir, 'nope.md'))).toThrow();
    });

    it('throws when the frontmatter lacks chatId', () => {
      writeFileSync(loopMdPath, '---\nname: nochat\n---\n\nprompt\n', 'utf-8');
      expect(() => mdRunner.startFromLoopMd(loopMdPath)).toThrow(/chatId/);
    });

    it('clamps maxSteps from the frontmatter (floor at 1)', async () => {
      writeLoopMd('one shot', { maxSteps: 0, stepInterval: '5ms' });

      const { loopId } = mdRunner.startFromLoopMd(loopMdPath);

      await vi.waitFor(() => expect(mdRunner.status(loopId)?.state).toBe('completed'), { timeout: 2000 });
      expect(mdPush).toHaveBeenCalledTimes(1);
    });
  });
});
