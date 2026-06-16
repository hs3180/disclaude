/**
 * Loop State — Read/write `.loop-state.json` for loop execution persistence.
 *
 * Related #4063 (Phase 0a).
 *
 * @module task/loop-state
 */

import * as fs from 'fs/promises';
import * as path from 'node:path';
import {
  LOOP_STATE_FILE,
  LOOP_DEFAULTS,
  type LoopState,
  type LoopStepRecord,
  type LoopRunState,
  type StepResult,
} from './loop-types.js';

/** Thrown when the state file exists but contains invalid JSON. */
export class LoopStateCorruptedError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`Loop state file corrupted: ${filePath}`);
    this.cause = cause;
  }
}

/** Get the path to the loop state file for a given workDir. */
export function getStateFilePath(workDir: string): string {
  return path.join(workDir, LOOP_STATE_FILE);
}

/** Create an initial LoopState for a new loop execution. */
export function createInitialState(params: {
  loopId: string;
  workDir: string;
  prompt: string;
  maxSteps?: number;
  maxConsecutiveFailures?: number;
}): LoopState {
  return {
    loopId: params.loopId,
    state: 'pending',
    workDir: params.workDir,
    prompt: params.prompt,
    maxSteps: params.maxSteps ?? LOOP_DEFAULTS.maxSteps,
    maxConsecutiveFailures: params.maxConsecutiveFailures ?? LOOP_DEFAULTS.maxConsecutiveFailures,
    currentStep: 0,
    consecutiveFailures: 0,
    createdAt: new Date().toISOString(),
    steps: [],
  };
}

/**
 * Read loop state from disk. Returns null if the file does not exist.
 * Throws LoopStateCorruptedError if the file exists but is invalid JSON.
 */
export async function readLoopState(workDir: string): Promise<LoopState | null> {
  const filePath = getStateFilePath(workDir);
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    const { code } = (err as NodeJS.ErrnoException);
    if (code === 'ENOENT') { return null; }
    throw err;
  }
  try {
    return JSON.parse(content) as LoopState;
  } catch (err) {
    throw new LoopStateCorruptedError(filePath, err);
  }
}

/** Persist loop state to disk. Creates the workDir if it doesn't exist. */
export async function writeLoopState(state: LoopState): Promise<void> {
  const filePath = getStateFilePath(state.workDir);
  await fs.mkdir(state.workDir, { recursive: true });
  const content = `${JSON.stringify(state, null, 2)}\n`;
  await fs.writeFile(filePath, content, 'utf-8');
}

/** Mark the loop as started (transition pending -> running). */
export function startLoop(state: LoopState): LoopState {
  return {
    ...state,
    state: 'running',
    startedAt: new Date().toISOString(),
  };
}

/** Record a completed step and update the loop state. */
export function recordStep(
  state: LoopState,
  result: StepResult,
  error?: string,
): LoopState {
  const stepRecord: LoopStepRecord = {
    step: state.currentStep + 1,
    result,
    completedAt: new Date().toISOString(),
    ...(error ? { error } : {}),
  };

  const consecutiveFailures = result === 'failure'
    ? state.consecutiveFailures + 1
    : 0;

  return {
    ...state,
    currentStep: state.currentStep + 1,
    consecutiveFailures,
    steps: [...state.steps, stepRecord],
  };
}

/** Transition the loop to a terminal state. */
export function terminateLoop(
  state: LoopState,
  newState: Extract<LoopRunState, 'completed' | 'failed' | 'stopped'>,
): LoopState {
  return {
    ...state,
    state: newState,
    completedAt: new Date().toISOString(),
  };
}

/**
 * Check if the loop should terminate based on its state.
 * Returns the reason or null if execution should continue.
 */
export function checkTermination(state: LoopState): LoopRunState | null {
  if (state.currentStep >= state.maxSteps) {
    return 'completed';
  }

  if (state.consecutiveFailures >= state.maxConsecutiveFailures) {
    return 'failed';
  }

  return null;
}
