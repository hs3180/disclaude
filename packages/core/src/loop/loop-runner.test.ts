/**
 * Unit tests for Loop Runner — core types and LoopRunner class.
 *
 * Issue #4063 (Phase 0): Tests for the Loop Runner execution engine.
 *
 * Tests cover:
 * - LoopState persistence (read/write/create)
 * - Step lifecycle (begin/finish)
 * - Termination condition checking
 * - LoopRunner: start, stop, status, step execution, failure handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  LoopRunner,
  readLoopState,
  writeLoopState,
  createInitialLoopState,
  beginStep,
  finishStep,
  checkTermination,
} from './index.js';
import type { LoopStateFile, LoopRunnerCallbacks, LoopStartConfig } from './loop-types.js';

// ============================================================================
// Test helpers
// ============================================================================

function createMockCallbacks(overrides?: Partial<LoopRunnerCallbacks>): LoopRunnerCallbacks {
  return {
    pushToAgent: vi.fn().mockResolvedValue({ success: true }),
    onLoopComplete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function defaultConfig(workDir: string, overrides?: Partial<LoopStartConfig>): LoopStartConfig {
  return {
    chatId: 'oc_test_chat',
    workDir,
    prompt: 'Execute the next step.',
    maxSteps: 3,
    maxDurationMs: 60000,
    ...overrides,
  };
}

// ============================================================================
// Loop State persistence tests
// ============================================================================

describe('Loop State persistence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-state-'));
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('readLoopState / writeLoopState', () => {
    it('should return null when state file does not exist', async () => {
      const state = await readLoopState(tempDir);
      expect(state).toBeNull();
    });

    it('should round-trip state to disk', async () => {
      const state = createInitialLoopState('test-id', defaultConfig(tempDir), 3);
      await writeLoopState(tempDir, state);

      const loaded = await readLoopState(tempDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.loopId).toBe('test-id');
      expect(loaded!.state).toBe('running');
      expect(loaded!.completedSteps).toBe(0);
      expect(loaded!.consecutiveFailures).toBe(0);
    });

    it('should persist steps', async () => {
      let state = createInitialLoopState('test-id', defaultConfig(tempDir), 3);
      const withStep = beginStep(state);
      state = finishStep(state, withStep.currentStep, true);
      await writeLoopState(tempDir, state);

      const loaded = await readLoopState(tempDir);
      expect(loaded!.steps).toHaveLength(1);
      expect(loaded!.steps[0].success).toBe(true);
      expect(loaded!.completedSteps).toBe(1);
    });
  });

  describe('createInitialLoopState', () => {
    it('should create valid initial state', () => {
      const config = defaultConfig(tempDir);
      const state = createInitialLoopState('loop-1', config, 3);

      expect(state.loopId).toBe('loop-1');
      expect(state.state).toBe('running');
      expect(state.startedAt).toBeTruthy();
      expect(state.config).toBe(config);
      expect(state.completedSteps).toBe(0);
      expect(state.consecutiveFailures).toBe(0);
      expect(state.maxConsecutiveFailures).toBe(3);
      expect(state.steps).toEqual([]);
      expect(state.endedAt).toBeUndefined();
    });
  });

  describe('beginStep / finishStep', () => {
    it('should begin a step with correct step number', () => {
      const state = createInitialLoopState('test', defaultConfig(tempDir), 3);
      const withStep = beginStep(state);

      expect(withStep.currentStep.step).toBe(1);
      expect(withStep.currentStep.startedAt).toBeTruthy();
      expect(withStep.currentStep.success).toBe(false);
    });

    it('should track step numbers incrementally', () => {
      const state = createInitialLoopState('test', defaultConfig(tempDir), 3);
      const s1 = beginStep(state);
      const afterS1 = finishStep(state, s1.currentStep, true);
      const s2 = beginStep(afterS1);

      expect(s2.currentStep.step).toBe(2);
    });

    it('should finish a successful step', () => {
      const state = createInitialLoopState('test', defaultConfig(tempDir), 3);
      const withStep = beginStep(state);
      const finished = finishStep(state, withStep.currentStep, true);

      expect(finished.steps).toHaveLength(1);
      expect(finished.steps[0].success).toBe(true);
      expect(finished.steps[0].endedAt).toBeTruthy();
      expect(finished.completedSteps).toBe(1);
      expect(finished.consecutiveFailures).toBe(0);
    });

    it('should finish a failed step and increment consecutive failures', () => {
      const state = createInitialLoopState('test', defaultConfig(tempDir), 3);
      const withStep = beginStep(state);
      const finished = finishStep(state, withStep.currentStep, false, {
        failureReason: 'agent_error',
        error: 'Something went wrong',
      });

      expect(finished.steps).toHaveLength(1);
      expect(finished.steps[0].success).toBe(false);
      expect(finished.steps[0].failureReason).toBe('agent_error');
      expect(finished.steps[0].error).toBe('Something went wrong');
      expect(finished.completedSteps).toBe(0);
      expect(finished.consecutiveFailures).toBe(1);
    });

    it('should reset consecutive failures on success', () => {
      let state = createInitialLoopState('test', defaultConfig(tempDir), 3);
      // Fail twice
      const s1 = beginStep(state);
      state = finishStep(state, s1.currentStep, false, { failureReason: 'agent_error' });
      const s2 = beginStep(state);
      state = finishStep(state, s2.currentStep, false, { failureReason: 'agent_error' });
      expect(state.consecutiveFailures).toBe(2);

      // Succeed
      const s3 = beginStep(state);
      state = finishStep(state, s3.currentStep, true);
      expect(state.consecutiveFailures).toBe(0);
      expect(state.completedSteps).toBe(1);
    });
  });

  describe('checkTermination', () => {
    it('should return null when no termination condition is met', () => {
      const state = createInitialLoopState('test', defaultConfig(tempDir), 3);
      const result = checkTermination(state, 10, 60000);
      expect(result).toBeNull();
    });

    it('should return "failed" when consecutive failures exceed max', () => {
      let state = createInitialLoopState('test', defaultConfig(tempDir), 3);
      for (let i = 0; i < 3; i++) {
        const s = beginStep(state);
        state = finishStep(state, s.currentStep, false, { failureReason: 'agent_error' });
      }

      const result = checkTermination(state, 10, 60000);
      expect(result).toBe('failed');
    });

    it('should return "completed" when step limit reached', () => {
      let state = createInitialLoopState('test', defaultConfig(tempDir), 3);
      for (let i = 0; i < 3; i++) {
        const s = beginStep(state);
        state = finishStep(state, s.currentStep, true);
      }

      const result = checkTermination(state, 3, 60000);
      expect(result).toBe('completed');
    });

    it('should return "timeout" when duration exceeded', () => {
      const state: LoopStateFile = {
        loopId: 'test',
        state: 'running',
        config: defaultConfig(tempDir),
        startedAt: new Date(Date.now() - 120000).toISOString(), // 2 min ago
        completedSteps: 0,
        consecutiveFailures: 0,
        maxConsecutiveFailures: 3,
        steps: [],
      };

      const result = checkTermination(state, 10, 60000); // 60s max
      expect(result).toBe('timeout');
    });
  });
});

// ============================================================================
// LoopRunner class tests
// ============================================================================

describe('LoopRunner', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-runner-'));
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('start', () => {
    it('should start a loop and return a loopId', async () => {
      const callbacks = createMockCallbacks();
      const runner = new LoopRunner(callbacks, { stepDelayMs: 0 });

      const loopId = await runner.start(defaultConfig(tempDir));
      expect(loopId).toBeTruthy();
      expect(typeof loopId).toBe('string');

      // Wait for loop to complete
      await new Promise(r => setTimeout(r, 200));

      expect(callbacks.pushToAgent).toHaveBeenCalled();
    });

    it('should persist state to disk', async () => {
      const callbacks = createMockCallbacks();
      const runner = new LoopRunner(callbacks, { stepDelayMs: 0 });

      await runner.start(defaultConfig(tempDir));
      await new Promise(r => setTimeout(r, 200));

      const state = await readLoopState(tempDir);
      expect(state).not.toBeNull();
      expect(state!.state).toMatch(/^(completed|running)$/);
    });
  });

  describe('stop', () => {
    it('should stop a running loop', async () => {
      const callbacks = createMockCallbacks();
      // Make pushToAgent slow so we can stop mid-loop
      callbacks.pushToAgent = vi.fn().mockImplementation(() => new Promise(r => setTimeout(() => r({ success: true }), 500)));

      const runner = new LoopRunner(callbacks, { stepDelayMs: 0 });
      const loopId = await runner.start(defaultConfig(tempDir, { maxSteps: 100 }));

      // Wait a bit for first step to start
      await new Promise(r => setTimeout(r, 50));

      const stopped = await runner.stop(loopId);
      expect(stopped).toBe(true);

      // Check final state
      const state = await readLoopState(tempDir);
      expect(state).not.toBeNull();
      expect(state!.state).toBe('stopped');
    });

    it('should return false for non-existent loop', async () => {
      const runner = new LoopRunner(createMockCallbacks());
      const stopped = await runner.stop('non-existent');
      expect(stopped).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('should return status for an active loop', async () => {
      const callbacks = createMockCallbacks();
      // Slow pushToAgent to ensure loop is still running when we check
      callbacks.pushToAgent = vi.fn().mockImplementation(() => new Promise(r => setTimeout(() => r({ success: true }), 2000)));

      const runner = new LoopRunner(callbacks, { stepDelayMs: 0 });
      const loopId = await runner.start(defaultConfig(tempDir, { maxSteps: 100 }));

      // Wait briefly for loop to start first step
      await new Promise(r => setTimeout(r, 50));

      const status = runner.getStatus(loopId);
      expect(status).not.toBeNull();
      expect(status!.loopId).toBe(loopId);
      expect(['running', 'completed']).toContain(status!.state);

      // Clean up
      await runner.stop(loopId);
    });

    it('should return null for non-existent loop', () => {
      const runner = new LoopRunner(createMockCallbacks());
      const status = runner.getStatus('non-existent');
      expect(status).toBeNull();
    });
  });

  describe('getStatusFromDisk', () => {
    it('should read status from disk', async () => {
      const callbacks = createMockCallbacks();
      const runner = new LoopRunner(callbacks, { stepDelayMs: 0 });
      const loopId = await runner.start(defaultConfig(tempDir));

      // Wait for completion
      await new Promise(r => setTimeout(r, 300));

      const status = await runner.getStatusFromDisk(tempDir);
      expect(status).not.toBeNull();
      expect(status!.loopId).toBe(loopId);
    });

    it('should return null when state file does not exist', async () => {
      const runner = new LoopRunner(createMockCallbacks());
      const status = await runner.getStatusFromDisk('/nonexistent/path');
      expect(status).toBeNull();
    });
  });

  describe('listActiveLoops', () => {
    it('should list active loop IDs', async () => {
      const callbacks = createMockCallbacks();
      callbacks.pushToAgent = vi.fn().mockImplementation(() => new Promise(r => setTimeout(() => r({ success: true }), 500)));

      const runner = new LoopRunner(callbacks, { stepDelayMs: 0 });
      const loopId1 = await runner.start(defaultConfig(tempDir, { maxSteps: 100 }));
      const loopId2 = await runner.start(defaultConfig(join(tempDir, 'loop2'), { maxSteps: 100 }));

      await new Promise(r => setTimeout(r, 50));

      const active = runner.listActiveLoops();
      expect(active).toHaveLength(2);
      expect(active).toContain(loopId1);
      expect(active).toContain(loopId2);

      await runner.stop(loopId1);
      await runner.stop(loopId2);
    });
  });

  describe('failure handling', () => {
    it('should mark steps as failed when pushToAgent throws', async () => {
      const callbacks = createMockCallbacks();
      callbacks.pushToAgent = vi.fn().mockRejectedValue(new Error('Agent unreachable'));

      const runner = new LoopRunner(callbacks, {
        stepDelayMs: 0,
        defaultMaxConsecutiveFailures: 2,
      });

      await runner.start(defaultConfig(tempDir, { maxSteps: 5 }));
      await new Promise(r => setTimeout(r, 500));

      const state = await readLoopState(tempDir);
      expect(state).not.toBeNull();
      expect(state!.state).toBe('failed');
      expect(state!.consecutiveFailures).toBeGreaterThanOrEqual(2);

      // All steps should be failures
      const failedSteps = state!.steps.filter(s => !s.success);
      expect(failedSteps.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('step limit', () => {
    it('should stop after reaching maxSteps', async () => {
      const callbacks = createMockCallbacks();
      const runner = new LoopRunner(callbacks, { stepDelayMs: 0 });

      await runner.start(defaultConfig(tempDir, { maxSteps: 2 }));
      await new Promise(r => setTimeout(r, 300));

      const state = await readLoopState(tempDir);
      expect(state).not.toBeNull();
      expect(state!.state).toBe('completed');
      expect(state!.steps).toHaveLength(2);
      expect(state!.completedSteps).toBe(2);
    });
  });

  describe('onLoopComplete callback', () => {
    it('should call onLoopComplete when loop finishes', async () => {
      const callbacks = createMockCallbacks();
      const runner = new LoopRunner(callbacks, { stepDelayMs: 0 });

      await runner.start(defaultConfig(tempDir, { maxSteps: 1 }));
      await new Promise(r => setTimeout(r, 500));

      expect(callbacks.onLoopComplete).toHaveBeenCalledTimes(1);
      const onLoopCompleteFn = callbacks.onLoopComplete as ReturnType<typeof vi.fn>;
      // eslint-disable-next-line prefer-destructuring
      const status = onLoopCompleteFn.mock.calls[0][1];
      expect(status.state).toBe('completed');
    });
  });
});
