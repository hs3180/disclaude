/**
 * Loop State Persistence — read/write `.loop-state.json` in workDir.
 *
 * Provides lightweight helpers for persisting loop runtime state to disk.
 * Follows the same pattern as project-state.ts (Issue #3335).
 *
 * @see Issue #4063 (Loop Runner)
 * @module loop/loop-state
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type LoopPersistedState,
  type LoopStatus,
  type LoopStartParams,
  LoopState,
  LOOP_STATE_FILE,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_DURATION_MS,
  DEFAULT_STEP_DELAY_MS,
} from './loop-types.js';

// ============================================================================
// Path Helper
// ============================================================================

/**
 * Resolve the state file path for a given workDir.
 */
export function getLoopStatePath(workDir: string): string {
  return join(workDir, LOOP_STATE_FILE);
}

// ============================================================================
// Read
// ============================================================================

/**
 * Result of reading loop state — distinguishes not-found from corruption.
 */
export type LoopStateReadResult =
  | { found: true; state: LoopPersistedState }
  | { found: false };

/**
 * Read loop state from workDir. Returns `{ found: false }` if the file
 * does not exist (normal for a new loop). Throws on corrupted/invalid JSON.
 */
export function readLoopState(workDir: string): LoopStateReadResult {
  const filePath = getLoopStatePath(workDir);
  if (!existsSync(filePath)) {
    return { found: false };
  }

  const raw = readFileSync(filePath, 'utf-8').trim();
  if (!raw) {
    return { found: false };
  }

  const parsed = JSON.parse(raw) as LoopPersistedState;

  // Basic shape validation
  if (!parsed.loopId || !parsed.state || typeof parsed.currentStep !== 'number') {
    throw new Error(`Invalid loop state file: ${filePath}`);
  }

  return { found: true, state: parsed };
}

// ============================================================================
// Write
// ============================================================================

/**
 * Persist loop state to workDir. Creates/overwrites `.loop-state.json`.
 */
export function writeLoopState(workDir: string, state: LoopPersistedState): void {
  state.updatedAt = Date.now();
  const filePath = getLoopStatePath(workDir);
  writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a fresh LoopPersistedState for a new loop run.
 */
export function createLoopState(
  loopId: string,
  params: LoopStartParams,
): LoopPersistedState {
  const now = Date.now();
  return {
    loopId,
    state: LoopState.Running,
    currentStep: 0,
    completedSteps: 0,
    startedAt: now,
    updatedAt: now,
    params: {
      chatId: params.chatId,
      workDir: params.workDir,
      prompt: params.prompt,
      maxSteps: params.maxSteps ?? DEFAULT_MAX_STEPS,
      maxDuration: params.maxDuration ?? DEFAULT_MAX_DURATION_MS,
      stepDelayMs: params.stepDelayMs ?? DEFAULT_STEP_DELAY_MS,
    },
  };
}

// ============================================================================
// Status Derivation
// ============================================================================

/**
 * Derive a read-only LoopStatus from persisted state.
 */
export function toLoopStatus(state: LoopPersistedState): LoopStatus {
  return {
    loopId: state.loopId,
    state: state.state,
    currentStep: state.currentStep,
    completedSteps: state.completedSteps,
    elapsedMs: Date.now() - state.startedAt,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
  };
}
