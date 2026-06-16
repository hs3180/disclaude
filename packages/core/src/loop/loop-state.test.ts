/**
 * Tests for loop-types and loop-state (Issue #4063).
 *
 * @module loop/loop-state.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  LoopState,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_DURATION_MS,
  DEFAULT_STEP_DELAY_MS,
  LOOP_STATE_FILE,
  type LoopPersistedState,
  type LoopStatus,
} from './loop-types.js';

import {
  getLoopStatePath,
  readLoopState,
  writeLoopState,
  createLoopState,
  toLoopStatus,
} from './loop-state.js';

// ============================================================================
// Helpers
// ============================================================================

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `loop-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ============================================================================
// loop-types constants
// ============================================================================

describe('loop-types constants', () => {
  it('should have correct defaults', () => {
    expect(DEFAULT_MAX_STEPS).toBe(10);
    expect(DEFAULT_MAX_DURATION_MS).toBe(60 * 60 * 1000);
    expect(DEFAULT_STEP_DELAY_MS).toBe(0);
    expect(LOOP_STATE_FILE).toBe('.loop-state.json');
  });

  it('should have all LoopState enum values', () => {
    expect(Object.values(LoopState)).toEqual(
      expect.arrayContaining(['running', 'completed', 'stopped', 'timedOut', 'error']),
    );
  });
});

// ============================================================================
// loop-state: path helper
// ============================================================================

describe('getLoopStatePath', () => {
  it('should return correct path', () => {
    const path = getLoopStatePath('/tmp/my-project');
    expect(path).toBe(join('/tmp/my-project', LOOP_STATE_FILE));
  });
});

// ============================================================================
// loop-state: readLoopState
// ============================================================================

describe('readLoopState', () => {
  it('should return found:false when file does not exist', () => {
    const result = readLoopState(testDir);
    expect(result.found).toBe(false);
  });

  it('should return found:false when file is empty', () => {
    const { writeFileSync } = require('node:fs');
    writeFileSync(getLoopStatePath(testDir), '', 'utf-8');
    const result = readLoopState(testDir);
    expect(result.found).toBe(false);
  });

  it('should throw on corrupted JSON', () => {
    const { writeFileSync } = require('node:fs');
    writeFileSync(getLoopStatePath(testDir), '{invalid json', 'utf-8');
    expect(() => readLoopState(testDir)).toThrow();
  });

  it('should throw on invalid shape (missing fields)', () => {
    const { writeFileSync } = require('node:fs');
    writeFileSync(getLoopStatePath(testDir), '{}', 'utf-8');
    expect(() => readLoopState(testDir)).toThrow('Invalid loop state file');
  });

  it('should parse valid state', () => {
    const state: LoopPersistedState = createLoopState('loop-1', {
      chatId: 'oc_test',
      workDir: testDir,
      prompt: 'do something',
    });
    writeLoopState(testDir, state);

    const result = readLoopState(testDir);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.state.loopId).toBe('loop-1');
      expect(result.state.state).toBe(LoopState.Running);
      expect(result.state.currentStep).toBe(0);
    }
  });
});

// ============================================================================
// loop-state: writeLoopState
// ============================================================================

describe('writeLoopState', () => {
  it('should create state file', () => {
    const state = createLoopState('loop-2', {
      chatId: 'oc_test',
      workDir: testDir,
      prompt: 'test',
    });
    writeLoopState(testDir, state);

    expect(existsSync(getLoopStatePath(testDir))).toBe(true);
  });

  it('should update updatedAt on write', () => {
    const state = createLoopState('loop-3', {
      chatId: 'oc_test',
      workDir: testDir,
      prompt: 'test',
    });
    const beforeWrite = state.updatedAt;
    // Small delay to ensure timestamp difference
    state.updatedAt = beforeWrite - 100;
    writeLoopState(testDir, state);

    const result = readLoopState(testDir);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.state.updatedAt).toBeGreaterThanOrEqual(beforeWrite);
    }
  });

  it('should persist all fields correctly', () => {
    const state = createLoopState('loop-4', {
      chatId: 'oc_test',
      workDir: testDir,
      prompt: 'test prompt',
      maxSteps: 5,
      maxDuration: 60000,
      stepDelayMs: 1000,
    });
    state.completedSteps = 3;
    state.currentStep = 3;
    writeLoopState(testDir, state);

    const result = readLoopState(testDir);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.state.params.maxSteps).toBe(5);
      expect(result.state.params.maxDuration).toBe(60000);
      expect(result.state.params.stepDelayMs).toBe(1000);
      expect(result.state.params.prompt).toBe('test prompt');
      expect(result.state.completedSteps).toBe(3);
    }
  });
});

// ============================================================================
// loop-state: createLoopState
// ============================================================================

describe('createLoopState', () => {
  it('should apply defaults for optional params', () => {
    const state = createLoopState('loop-5', {
      chatId: 'oc_test',
      workDir: testDir,
      prompt: 'test',
    });
    expect(state.params.maxSteps).toBe(DEFAULT_MAX_STEPS);
    expect(state.params.maxDuration).toBe(DEFAULT_MAX_DURATION_MS);
    expect(state.params.stepDelayMs).toBe(DEFAULT_STEP_DELAY_MS);
  });

  it('should use provided values for optional params', () => {
    const state = createLoopState('loop-6', {
      chatId: 'oc_test',
      workDir: testDir,
      prompt: 'test',
      maxSteps: 3,
      maxDuration: 5000,
      stepDelayMs: 500,
    });
    expect(state.params.maxSteps).toBe(3);
    expect(state.params.maxDuration).toBe(5000);
    expect(state.params.stepDelayMs).toBe(500);
  });

  it('should set initial timestamps', () => {
    const before = Date.now();
    const state = createLoopState('loop-7', {
      chatId: 'oc_test',
      workDir: testDir,
      prompt: 'test',
    });
    const after = Date.now();
    expect(state.startedAt).toBeGreaterThanOrEqual(before);
    expect(state.startedAt).toBeLessThanOrEqual(after);
    expect(state.updatedAt).toBe(state.startedAt);
  });

  it('should initialize steps to zero', () => {
    const state = createLoopState('loop-8', {
      chatId: 'oc_test',
      workDir: testDir,
      prompt: 'test',
    });
    expect(state.currentStep).toBe(0);
    expect(state.completedSteps).toBe(0);
    expect(state.state).toBe(LoopState.Running);
  });
});

// ============================================================================
// loop-state: toLoopStatus
// ============================================================================

describe('toLoopStatus', () => {
  it('should derive status from persisted state', () => {
    const now = Date.now();
    const persisted: LoopPersistedState = {
      loopId: 'loop-9',
      state: LoopState.Completed,
      currentStep: 10,
      completedSteps: 10,
      startedAt: now - 5000,
      updatedAt: now,
      params: {
        chatId: 'oc_test',
        workDir: testDir,
        prompt: 'test',
      },
    };

    const status: LoopStatus = toLoopStatus(persisted);
    expect(status.loopId).toBe('loop-9');
    expect(status.state).toBe(LoopState.Completed);
    expect(status.currentStep).toBe(10);
    expect(status.completedSteps).toBe(10);
    expect(status.elapsedMs).toBeGreaterThanOrEqual(5000);
    expect(status.startedAt).toBe(now - 5000);
    expect(status.updatedAt).toBe(now);
  });
});
