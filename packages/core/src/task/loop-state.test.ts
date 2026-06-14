/**
 * Tests for Loop Types + State persistence (Phase 0a).
 *
 * Related #4063: Loop Runner — Types + State Persistence.
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
  parseDuration,
  getStateFilePath,
  createInitialState,
  readLoopState,
  readLoopStateSync,
  writeLoopState,
  writeLoopStateSync,
  startLoop,
  recordStep,
  terminateLoop,
  checkTermination,
  getStepCounts,
  LoopStateCorruptedError,
} from './loop-state.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-state-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loop-types
// ---------------------------------------------------------------------------

describe('loop-types', () => {
  describe('LOOP_DEFAULTS', () => {
    it('should have sensible defaults', () => {
      expect(LOOP_DEFAULTS.maxSteps).toBe(10);
      expect(LOOP_DEFAULTS.maxDurationMs).toBe(2 * 60 * 60 * 1000);
      expect(LOOP_DEFAULTS.maxConsecutiveFailures).toBe(3);
    });
  });

  describe('TERMINAL_STATES', () => {
    it('should contain expected terminal states', () => {
      expect(TERMINAL_STATES.has('completed')).toBe(true);
      expect(TERMINAL_STATES.has('failed')).toBe(true);
      expect(TERMINAL_STATES.has('timeout')).toBe(true);
      expect(TERMINAL_STATES.has('stopped')).toBe(true);
    });

    it('should not contain non-terminal states', () => {
      expect(TERMINAL_STATES.has('running')).toBe(false);
      expect(TERMINAL_STATES.has('pending')).toBe(false);
      expect(TERMINAL_STATES.has('paused')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// loop-state
// ---------------------------------------------------------------------------

describe('loop-state', () => {
  describe('parseDuration', () => {
    it('should parse hours', () => {
      expect(parseDuration('2h')).toBe(2 * 3600 * 1000);
    });

    it('should parse minutes', () => {
      expect(parseDuration('30m')).toBe(30 * 60 * 1000);
    });

    it('should parse seconds', () => {
      expect(parseDuration('90s')).toBe(90 * 1000);
    });

    it('should treat plain numbers as seconds', () => {
      expect(parseDuration('300')).toBe(300 * 1000);
    });

    it('should return default for empty string', () => {
      expect(parseDuration('')).toBe(LOOP_DEFAULTS.maxDurationMs);
    });

    it('should handle uppercase suffixes', () => {
      expect(parseDuration('1H')).toBe(3600 * 1000);
      expect(parseDuration('30M')).toBe(30 * 60 * 1000);
      expect(parseDuration('60S')).toBe(60 * 1000);
    });
  });

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
        chatId: 'oc_123',
        workDir: '/data/loops/test',
        prompt: 'Do something',
      });

      expect(state.loopId).toBe('test-loop');
      expect(state.chatId).toBe('oc_123');
      expect(state.workDir).toBe('/data/loops/test');
      expect(state.prompt).toBe('Do something');
      expect(state.state).toBe('pending');
      expect(state.currentStep).toBe(0);
      expect(state.consecutiveFailures).toBe(0);
      expect(state.config.maxSteps).toBe(10);
      expect(state.config.maxDurationMs).toBe(2 * 3600 * 1000);
      expect(state.config.maxConsecutiveFailures).toBe(3);
      expect(state.steps).toEqual([]);
      expect(state.startedAt).toBeUndefined();
      expect(state.completedAt).toBeUndefined();
      expect(state.createdAt).toBeTruthy();
    });

    it('should accept custom config', () => {
      const state = createInitialState({
        loopId: 'custom',
        chatId: 'oc_456',
        workDir: '/tmp/x',
        prompt: 'p',
        config: { maxSteps: 5, maxDurationMs: 60000, maxConsecutiveFailures: 1 },
      });

      expect(state.config.maxSteps).toBe(5);
      expect(state.config.maxDurationMs).toBe(60000);
      expect(state.config.maxConsecutiveFailures).toBe(1);
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
        chatId: 'oc_rt',
        workDir: tempDir,
        prompt: 'test prompt',
      });
      await writeLoopState(original);

      const loaded = await readLoopState(tempDir);
      expect(loaded).not.toBeNull();
      expect(loaded?.loopId).toBe('rt-test');
      expect(loaded?.chatId).toBe('oc_rt');
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
        chatId: 'oc_n',
        workDir: nestedDir,
        prompt: 'nested',
      });
      await writeLoopState(state);

      const loaded = await readLoopState(nestedDir);
      expect(loaded?.loopId).toBe('nested');
    });
  });

  describe('readLoopStateSync / writeLoopStateSync', () => {
    it('should work synchronously', () => {
      const state = createInitialState({
        loopId: 'sync-test',
        chatId: 'oc_sync',
        workDir: tempDir,
        prompt: 'sync',
      });
      writeLoopStateSync(state);

      const loaded = readLoopStateSync(tempDir);
      expect(loaded).not.toBeNull();
      expect(loaded?.loopId).toBe('sync-test');
    });

    it('should return null when no state file exists (sync)', () => {
      expect(readLoopStateSync(tempDir)).toBeNull();
    });
  });

  describe('startLoop', () => {
    it('should transition pending to running', () => {
      const state = createInitialState({
        loopId: 'start',
        chatId: 'oc_s',
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
        chatId: 'oc_r',
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
        chatId: 'oc_f',
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

    it('should reset consecutive failures on skip', () => {
      let state = createInitialState({
        loopId: 'skip',
        chatId: 'oc_sk',
        workDir: tempDir,
        prompt: 'p',
      });
      state = startLoop(state);
      state = recordStep(state, 'failure');
      expect(state.consecutiveFailures).toBe(1);

      state = recordStep(state, 'skipped');
      expect(state.consecutiveFailures).toBe(0);
    });
  });

  describe('terminateLoop', () => {
    it('should set terminal state and completedAt', () => {
      let state = createInitialState({
        loopId: 'term',
        chatId: 'oc_t',
        workDir: tempDir,
        prompt: 'p',
      });
      state = terminateLoop(state, 'completed');

      expect(state.state).toBe('completed');
      expect(state.completedAt).toBeTruthy();
    });

    it('should support all terminal states', () => {
      const base = createInitialState({
        loopId: 't',
        chatId: 'oc',
        workDir: tempDir,
        prompt: 'p',
      });

      const terminals: Array<LoopRunState> = ['completed', 'failed', 'timeout', 'stopped'];
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
        chatId: 'oc_h',
        workDir: tempDir,
        prompt: 'p',
      });
      const started = startLoop(state);
      expect(checkTermination(started)).toBeNull();
    });

    it('should detect max steps reached', () => {
      let state = createInitialState({
        loopId: 'maxstep',
        chatId: 'oc_ms',
        workDir: tempDir,
        prompt: 'p',
        config: { maxSteps: 2 },
      });
      state = startLoop(state);
      state = recordStep(state, 'success');
      state = recordStep(state, 'success');

      expect(checkTermination(state)).toBe('completed');
    });

    it('should detect consecutive failures exceeded', () => {
      let state = createInitialState({
        loopId: 'confail',
        chatId: 'oc_cf',
        workDir: tempDir,
        prompt: 'p',
        config: { maxConsecutiveFailures: 2 },
      });
      state = startLoop(state);
      state = recordStep(state, 'failure');
      state = recordStep(state, 'failure');

      expect(checkTermination(state)).toBe('failed');
    });

    it('should detect timeout', () => {
      // Simulate a loop that started 3 hours ago with 2h max
      const state = createInitialState({
        loopId: 'timeout',
        chatId: 'oc_to',
        workDir: tempDir,
        prompt: 'p',
        config: { maxDurationMs: 1000 }, // 1 second
      });
      const started = {
        ...state,
        state: 'running' as const,
        startedAt: new Date(Date.now() - 5000).toISOString(), // 5s ago
      };

      expect(checkTermination(started)).toBe('timeout');
    });

    it('should not detect timeout if not started', () => {
      const state = createInitialState({
        loopId: 'notstarted',
        chatId: 'oc_ns',
        workDir: tempDir,
        prompt: 'p',
        config: { maxDurationMs: 1 },
      });
      // pending state, no startedAt
      expect(checkTermination(state)).toBeNull();
    });
  });

  describe('getStepCounts', () => {
    it('should count step results correctly', () => {
      let state = createInitialState({
        loopId: 'counts',
        chatId: 'oc_c',
        workDir: tempDir,
        prompt: 'p',
        config: { maxSteps: 10 },
      });
      state = startLoop(state);
      state = recordStep(state, 'success');
      state = recordStep(state, 'success');
      state = recordStep(state, 'failure');
      state = recordStep(state, 'skipped');

      const counts = getStepCounts(state);
      expect(counts.completed).toBe(2);
      expect(counts.failed).toBe(1);
      expect(counts.skipped).toBe(1);
      expect(counts.total).toBe(10);
    });

    it('should return zeros for empty state', () => {
      const state = createInitialState({
        loopId: 'empty',
        chatId: 'oc_e',
        workDir: tempDir,
        prompt: 'p',
      });
      const counts = getStepCounts(state);
      expect(counts.completed).toBe(0);
      expect(counts.failed).toBe(0);
      expect(counts.skipped).toBe(0);
    });
  });

  describe('full lifecycle', () => {
    it('should persist state through a complete loop execution', async () => {
      let state = createInitialState({
        loopId: 'lifecycle',
        chatId: 'oc_lc',
        workDir: tempDir,
        prompt: 'Do the thing',
        config: { maxSteps: 3, maxConsecutiveFailures: 2 },
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

      // Step 3 success → complete
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
