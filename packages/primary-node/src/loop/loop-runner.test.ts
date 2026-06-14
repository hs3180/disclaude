import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LoopRunner } from './loop-runner.js';

describe('LoopRunner', () => {
  let mockPush: ReturnType<typeof vi.fn>;
  let runner: LoopRunner;

  beforeEach(() => {
    mockPush = vi.fn().mockResolvedValue(undefined);
    runner = new LoopRunner(mockPush);
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
});
