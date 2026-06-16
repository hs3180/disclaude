/**
 * Tests for Loop Types + State persistence (Phase 0a).
 *
 * Related #4063.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  LOOP_DEFAULTS,
  LOOP_STATE_FILE,
  TERMINAL_STATES,
  type LoopRunState,
} from './loop-types.js';
import {
  getStateFilePath,
  createInitialState,
  readLoopState,
  writeLoopState,
  startLoop,
  recordStep,
  terminateLoop,
  checkTermination,
  LoopStateCorruptedError,
} from './loop-state.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-state-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('loop-types', () => {
  describe('LOOP_DEFAULTS', () => {
    it('should have sensible defaults', () => {
      expect(LOOP_DEFAULTS.maxSteps).toBe(10);
      expect(LOOP_DEFAULTS.maxConsecutiveFailures).toBe(3);
    });
  });

  describe('TERMINAL_STATES', () => {
    it('should contain expected terminal states', () => {
      expect(TERMINAL_STATES.has('completed')).toBe(true);
      expect(TERMINAL_STATES.has('failed')).toBe(true);
      expect(TERMINAL_STATES.has('stopped')).toBe(true);
    });

    it('should not contain non-terminal states', () => {
      expect(TERMINAL_STATES.has('running')).toBe(false);
      expect(TERMINAL_STATES.has('pending')).toBe(false);
    });
  });
});

describe('loop-state', () => {
  describe('getStateFilePath', () => {
    it('should return correct path', () => {
      expect(getStateFilePath('/data/loops/task1')).toBe(
        path.join('/data/loops/task1', LOOP_STATE_FILE),
      );
    });
  });

  describe('createInitialState', () => {
    it('should create state with defaults', () => {
      const state = createInitialState({
        loopId: 'test-loop',
        workDir: '/data/loops/test',
        prompt: 'Do something',
      });

      expect(state.loopId).toBe('test-loop');
      expect(state.workDir).toBe('/data/loops/test');
      expect(state.prompt).toBe('Do something');
      expect(state.state).toBe('pending');
      expect(state.currentStep).toBe(0);
      expect(state.consecutiveFailures).toBe(0);
      expect(state.maxSteps).toBe(10);
      expect(state.maxConsecutiveFailures).toBe(3);
      expect(state.steps).toEqual([]);
      expect(state.startedAt).toBeUndefined();
      expect(state.completedAt).toBeUndefined();
      expect(state.createdAt).toBeTruthy();
    });

    it('should accept custom config', () => {
      const state = createInitialState({
        loopId: 'custom',
        workDir: '/tmp/x',
        prompt: 'p',
        maxSteps: 5,
        maxConsecutiveFailures: 1,
      });

      expect(state.maxSteps).toBe(5);
      expect(state.maxConsecutiveFailures).toBe(1);
    });
  });

  describe('readLoopState / writeLoopState', () => {
    it('should return null when no state file exists', async () => {
      const state = await readLoopState(tempDir);
      expect(state).toBeNull();
    });

    it('should round-trip state to disk', async () => {
      const original = createInitialState({
        loopId: 'rt-test',
        workDir: tempDir,
        prompt: 'test prompt',
      });
      await writeLoopState(original);

      const loaded = await readLoopState(tempDir);
      expect(loaded).not.toBeNull();
      expect(loaded?.loopId).toBe('rt-test');
      expect(loaded?.prompt).toBe('test prompt');
      expect(loaded?.state).toBe('pending');
    });

    it('should throw LoopStateCorruptedError for invalid JSON', async () => {
      const filePath = getStateFilePath(tempDir);
      await fs.writeFile(filePath, 'not valid json {{{', 'utf-8');

      await expect(readLoopState(tempDir)).rejects.toThrow(LoopStateCorruptedError);
    });

    it('should create workDir if it does not exist', async () => {
      const nestedDir = path.join(tempDir, 'a', 'b', 'c');
      const state = createInitialState({
        loopId: 'nested',
        workDir: nestedDir,
        prompt: 'nested',
      });
      await writeLoopState(state);

      const loaded = await readLoopState(nestedDir);
      expect(loaded?.loopId).toBe('nested');
    });
  });

  describe('startLoop', () => {
    it('should transition pending to running', () => {
      const state = createInitialState({
        loopId: 'start',
        workDir: tempDir,
        prompt: 'p',
      });
      expect(state.state).toBe('pending');

      const started = startLoop(state);
      expect(started.state).toBe('running');
      expect(started.startedAt).toBeTruthy();
      expect(started.currentStep).toBe(0);
    });
  });

  describe('recordStep', () => {
    it('should record a successful step', () => {
      let state = createInitialState({
        loopId: 'rec',
        workDir: tempDir,
        prompt: 'p',
      });
      state = startLoop(state);

      const next = recordStep(state, 'success');
      expect(next.currentStep).toBe(1);
      expect(next.consecutiveFailures).toBe(0);
      expect(next.steps).toHaveLength(1);
      expect(next.steps[0]?.step).toBe(1);
      expect(next.steps[0]?.result).toBe('success');
    });

    it('should track consecutive failures', () => {
      let state = createInitialState({
        loopId: 'fail',
        workDir: tempDir,
        prompt: 'p',
      });
      state = startLoop(state);

      state = recordStep(state, 'failure', 'API timeout');
      expect(state.consecutiveFailures).toBe(1);
      expect(state.steps[0]?.error).toBe('API timeout');

      state = recordStep(state, 'failure', 'Rate limit');
      expect(state.consecutiveFailures).toBe(2);

      // Success resets counter
      state = recordStep(state, 'success');
      expect(state.consecutiveFailures).toBe(0);
    });
  });

  describe('terminateLoop', () => {
    it('should set terminal state and completedAt', () => {
      const state = createInitialState({
        loopId: 'term',
        workDir: tempDir,
        prompt: 'p',
      });
      const result = terminateLoop(state, 'completed');

      expect(result.state).toBe('completed');
      expect(result.completedAt).toBeTruthy();
    });

    it('should support all terminal states', () => {
      const base = createInitialState({
        loopId: 't',
        workDir: tempDir,
        prompt: 'p',
      });

      const terminals: Array<LoopRunState> = ['completed', 'failed', 'stopped'];
      for (const terminal of terminals) {
        const result = terminateLoop(base, terminal as 'completed');
        expect(result.state).toBe(terminal);
      }
    });
  });

  describe('checkTermination', () => {
    it('should return null for a healthy running loop', () => {
      const state = createInitialState({
        loopId: 'healthy',
        workDir: tempDir,
        prompt: 'p',
      });
      const started = startLoop(state);
      expect(checkTermination(started)).toBeNull();
    });

    it('should detect max steps reached', () => {
      let state = createInitialState({
        loopId: 'maxstep',
        workDir: tempDir,
        prompt: 'p',
        maxSteps: 2,
      });
      state = startLoop(state);
      state = recordStep(state, 'success');
      state = recordStep(state, 'success');

      expect(checkTermination(state)).toBe('completed');
    });

    it('should detect consecutive failures exceeded', () => {
      let state = createInitialState({
        loopId: 'confail',
        workDir: tempDir,
        prompt: 'p',
        maxConsecutiveFailures: 2,
      });
      state = startLoop(state);
      state = recordStep(state, 'failure');
      state = recordStep(state, 'failure');

      expect(checkTermination(state)).toBe('failed');
    });
  });

  describe('full lifecycle', () => {
    it('should persist state through a complete loop execution', async () => {
      let state = createInitialState({
        loopId: 'lifecycle',
        workDir: tempDir,
        prompt: 'Do the thing',
        maxSteps: 3,
        maxConsecutiveFailures: 2,
      });
      await writeLoopState(state);

      // Start
      state = startLoop(state);
      await writeLoopState(state);
      let loaded = await readLoopState(tempDir);
      expect(loaded?.state).toBe('running');

      // Step 1 success
      state = recordStep(state, 'success');
      await writeLoopState(state);
      loaded = await readLoopState(tempDir);
      expect(loaded?.currentStep).toBe(1);
      expect(loaded?.steps[0]?.result).toBe('success');

      // Step 2 failure
      state = recordStep(state, 'failure', 'API error');
      await writeLoopState(state);
      loaded = await readLoopState(tempDir);
      expect(loaded?.consecutiveFailures).toBe(1);
      expect(loaded?.steps[1]?.error).toBe('API error');

      // Step 3 success -> complete
      state = recordStep(state, 'success');
      const term = checkTermination(state);
      expect(term).toBe('completed');
      state = terminateLoop(state, 'completed');
      await writeLoopState(state);

      loaded = await readLoopState(tempDir);
      expect(loaded?.state).toBe('completed');
      expect(loaded?.completedAt).toBeTruthy();
      expect(loaded?.steps).toHaveLength(3);
    });
  });
});
