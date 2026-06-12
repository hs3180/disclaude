/**
 * Loop State — Read/write `.loop-state.json` for loop execution persistence.
 *
 * Handles creating, reading, and updating the loop state file in the workDir.
 * Distinguishes between file-not-found (new loop) and actual corruption errors.
 *
 * Related #4063 (Phase 0a).
 *
 * @module task/loop-state
 */

import * as fs from 'fs/promises';
import * as syncFs from 'fs';
import * as path from 'node:path';
import {
  LOOP_STATE_FILE,
  LOOP_DEFAULTS,
  type LoopConfig,
  type LoopState,
  type LoopStepRecord,
  type LoopRunState,
  type StepResult,
} from './loop-types.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when the state file exists but contains invalid JSON. */
export class LoopStateCorruptedError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`Loop state file corrupted: ${filePath}`);
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Duration parsing
// ---------------------------------------------------------------------------

/**
 * Parse a human-readable duration string to milliseconds.
 * Supports: "2h", "30m", "90s", plain number (seconds).
 */
export function parseDuration(raw: string): number {
  const s = raw.trim();
  if (!s) {return LOOP_DEFAULTS.maxDurationMs;}
  const num = parseFloat(s);
  if (s.endsWith('h') || s.endsWith('H')) {return num * 3600 * 1000;}
  if (s.endsWith('m') || s.endsWith('M')) {return num * 60 * 1000;}
  if (s.endsWith('s') || s.endsWith('S')) {return num * 1000;}
  return num * 1000; // default to seconds
}

// ---------------------------------------------------------------------------
// State file path
// ---------------------------------------------------------------------------

/**
 * Get the path to the loop state file for a given workDir.
 */
export function getStateFilePath(workDir: string): string {
  return path.join(workDir, LOOP_STATE_FILE);
}

// ---------------------------------------------------------------------------
// Build initial state
// ---------------------------------------------------------------------------

/**
 * Create an initial LoopState for a new loop execution.
 */
export function createInitialState(params: {
  loopId: string;
  chatId: string;
  workDir: string;
  prompt: string;
  config?: Partial<LoopConfig>;
}): LoopState {
  return {
    loopId: params.loopId,
    state: 'pending',
    chatId: params.chatId,
    workDir: params.workDir,
    prompt: params.prompt,
    config: {
      maxSteps: params.config?.maxSteps ?? LOOP_DEFAULTS.maxSteps,
      maxDurationMs: params.config?.maxDurationMs ?? LOOP_DEFAULTS.maxDurationMs,
      maxConsecutiveFailures: params.config?.maxConsecutiveFailures ?? LOOP_DEFAULTS.maxConsecutiveFailures,
    },
    currentStep: 0,
    consecutiveFailures: 0,
    createdAt: new Date().toISOString(),
    steps: [],
  };
}

// ---------------------------------------------------------------------------
// Read state
// ---------------------------------------------------------------------------

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
    const {code} = (err as NodeJS.ErrnoException);
    if (code === 'ENOENT') {return null;}
    throw err;
  }
  try {
    return JSON.parse(content) as LoopState;
  } catch (err) {
    throw new LoopStateCorruptedError(filePath, err);
  }
}

/**
 * Synchronous version of readLoopState.
 */
export function readLoopStateSync(workDir: string): LoopState | null {
  const filePath = getStateFilePath(workDir);
  let content: string;
  try {
    content = syncFs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    const {code} = (err as NodeJS.ErrnoException);
    if (code === 'ENOENT') {return null;}
    throw err;
  }
  try {
    return JSON.parse(content) as LoopState;
  } catch (err) {
    throw new LoopStateCorruptedError(filePath, err);
  }
}

// ---------------------------------------------------------------------------
// Write state
// ---------------------------------------------------------------------------

/**
 * Persist loop state to disk. Creates the workDir if it doesn't exist.
 */
export async function writeLoopState(state: LoopState): Promise<void> {
  const filePath = getStateFilePath(state.workDir);
  await fs.mkdir(state.workDir, { recursive: true });
  const content = `${JSON.stringify(state, null, 2)  }\n`;
  await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * Synchronous version of writeLoopState.
 */
export function writeLoopStateSync(state: LoopState): void {
  const filePath = getStateFilePath(state.workDir);
  syncFs.mkdirSync(state.workDir, { recursive: true });
  const content = `${JSON.stringify(state, null, 2)  }\n`;
  syncFs.writeFileSync(filePath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// State mutations
// ---------------------------------------------------------------------------

/**
 * Mark the loop as started (transition pending → running).
 */
export function startLoop(state: LoopState): LoopState {
  return {
    ...state,
    state: 'running',
    startedAt: new Date().toISOString(),
  };
}

/**
 * Record a completed step and update the loop state.
 */
export function recordStep(
  state: LoopState,
  result: StepResult,
  error?: string,
): LoopState {
  const stepRecord: LoopStepRecord = {
    step: state.currentStep + 1,
    result,
    startedAt: new Date().toISOString(), // Simplified; Runner will track actual start
    completedAt: new Date().toISOString(),
    ...(error ? { error } : {}),
  };

  const consecutiveFailures = result === 'failure'
    ? state.consecutiveFailures + 1
    : 0; // Reset on success or skip

  return {
    ...state,
    currentStep: state.currentStep + 1,
    consecutiveFailures,
    steps: [...state.steps, stepRecord],
  };
}

/**
 * Transition the loop to a terminal state.
 */
export function terminateLoop(
  state: LoopState,
  newState: Extract<LoopRunState, 'completed' | 'failed' | 'timeout' | 'stopped'>,
): LoopState {
  return {
    ...state,
    state: newState,
    completedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Termination checks
// ---------------------------------------------------------------------------

/**
 * Check if the loop should terminate based on its state.
 * Returns the reason or null if execution should continue.
 */
export function checkTermination(state: LoopState): LoopRunState | null {
  // All steps completed
  if (state.currentStep >= state.config.maxSteps) {
    return 'completed';
  }

  // Too many consecutive failures
  if (state.consecutiveFailures >= state.config.maxConsecutiveFailures) {
    return 'failed';
  }

  // Duration exceeded
  if (state.startedAt) {
    const elapsed = Date.now() - new Date(state.startedAt).getTime();
    if (elapsed >= state.config.maxDurationMs) {
      return 'timeout';
    }
  }

  return null;
}

/**
 * Get summary counts from loop state.
 */
export function getStepCounts(state: LoopState): {
  completed: number;
  failed: number;
  skipped: number;
  total: number;
} {
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  for (const step of state.steps) {
    if (step.result === 'success') {completed++;}
    else if (step.result === 'failure') {failed++;}
    else if (step.result === 'skipped') {skipped++;}
  }
  return { completed, failed, skipped, total: state.config.maxSteps };
}
