/**
 * Loop State persistence — read/write `.loop-state.json`.
 *
 * Issue #4063 (Phase 0): Manages persistent state for active loops.
 * Each loop's state is stored in its `workDir/.loop-state.json` file.
 *
 * @module @disclaude/core/loop
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';
import type { LoopStateFile, LoopStepRecord } from './loop-types.js';

const logger = createLogger('LoopState');

/** File name for persistent loop state */
export const LOOP_STATE_FILE = '.loop-state.json';

/**
 * Read loop state from disk.
 * Returns null if the file does not exist or is invalid.
 */
export async function readLoopState(workDir: string): Promise<LoopStateFile | null> {
  const filePath = join(workDir, LOOP_STATE_FILE);
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as LoopStateFile;
  } catch {
    return null;
  }
}

/**
 * Write loop state to disk.
 * Creates the workDir if it doesn't exist.
 */
export async function writeLoopState(workDir: string, state: LoopStateFile): Promise<void> {
  const filePath = join(workDir, LOOP_STATE_FILE);
  await mkdir(workDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Create an initial loop state file.
 */
export function createInitialLoopState(
  loopId: string,
  config: import('./loop-types.js').LoopStartConfig,
  maxConsecutiveFailures: number,
): LoopStateFile {
  return {
    loopId,
    state: 'running',
    config,
    startedAt: new Date().toISOString(),
    completedSteps: 0,
    consecutiveFailures: 0,
    maxConsecutiveFailures,
    steps: [],
  };
}

/**
 * Start a new step record.
 */
export function beginStep(state: LoopStateFile): LoopStateFile & { currentStep: LoopStepRecord } {
  const stepNumber = state.steps.length + 1;
  const record: LoopStepRecord = {
    step: stepNumber,
    startedAt: new Date().toISOString(),
    success: false,
  };
  return { ...state, currentStep: record };
}

/**
 * Mark a step as completed (success or failure) and update counters.
 */
export function finishStep(
  state: LoopStateFile,
  step: LoopStepRecord,
  success: boolean,
  options?: { failureReason?: import('./loop-types.js').StepFailureReason; error?: string },
): LoopStateFile {
  const finishedStep: LoopStepRecord = {
    ...step,
    endedAt: new Date().toISOString(),
    success,
    failureReason: success ? undefined : (options?.failureReason ?? 'unknown'),
    error: success ? undefined : options?.error,
  };

  const completedSteps = success ? state.completedSteps + 1 : state.completedSteps;
  const consecutiveFailures = success ? 0 : state.consecutiveFailures + 1;

  return {
    ...state,
    completedSteps,
    consecutiveFailures,
    steps: [...state.steps, finishedStep],
  };
}

/**
 * Check if the loop should terminate based on conditions.
 * Returns the new state or null if the loop should continue.
 */
export function checkTermination(
  state: LoopStateFile,
  maxSteps: number,
  maxDurationMs: number,
): import('./loop-types.js').LoopState | null {
  // Too many consecutive failures
  if (state.consecutiveFailures >= state.maxConsecutiveFailures) {
    logger.info(`Loop ${state.loopId}: terminating — consecutive failures (${state.consecutiveFailures}) >= max (${state.maxConsecutiveFailures})`);
    return 'failed';
  }

  // Step limit reached
  if (state.steps.length >= maxSteps) {
    logger.info(`Loop ${state.loopId}: terminating — step limit reached (${state.steps.length}/${maxSteps})`);
    return 'completed';
  }

  // Duration exceeded
  const elapsed = Date.now() - new Date(state.startedAt).getTime();
  if (elapsed >= maxDurationMs) {
    logger.info(`Loop ${state.loopId}: terminating — duration exceeded (${Math.round(elapsed / 1000)}s >= ${Math.round(maxDurationMs / 1000)}s)`);
    return 'timeout';
  }

  return null;
}
