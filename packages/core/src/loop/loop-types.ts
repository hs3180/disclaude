/**
 * Loop Type Definitions — minimal types for the Loop Runner (Issue #4063).
 *
 * Loop = repeated execution of a single prompt via pushToAgent.
 * No complex state machines — just a counter, a timer, and termination conditions.
 *
 * @module loop/loop-types
 */

// ============================================================================
// Loop State
// ============================================================================

/**
 * Lifecycle states of a Loop run.
 */
export enum LoopState {
  /** Loop is actively iterating. */
  Running = 'running',
  /** Loop completed all steps or reached a terminal condition. */
  Completed = 'completed',
  /** Loop was stopped via loop_stop() or external signal. */
  Stopped = 'stopped',
  /** Loop exceeded maxDuration before completing. */
  TimedOut = 'timedOut',
  /** An unrecoverable error occurred during execution. */
  Error = 'error',
}

// ============================================================================
// Loop Config
// ============================================================================

/**
 * Parameters supplied to loop_start().
 */
export interface LoopStartParams {
  /** Target chat to push messages into. */
  chatId: string;
  /** Working directory for agent file operations. */
  workDir: string;
  /** Fixed prompt repeated each iteration. */
  prompt: string;
  /** Maximum iterations (default: 10). */
  maxSteps?: number;
  /** Maximum wall-clock duration in ms (default: 1 hour). */
  maxDuration?: number;
  /** Delay between iterations in ms (default: 0). */
  stepDelayMs?: number;
}

// ============================================================================
// Loop Runtime State
// ============================================================================

/**
 * Persisted per-loop state (what gets saved to disk).
 */
export interface LoopPersistedState {
  /** Unique loop identifier. */
  loopId: string;
  /** Current lifecycle state. */
  state: LoopState;
  /** Which step is currently executing (0-indexed). */
  currentStep: number;
  /** Total steps completed. */
  completedSteps: number;
  /** Unix timestamp (ms) when the loop started. */
  startedAt: number;
  /** Unix timestamp (ms) of last state update. */
  updatedAt: number;
  /** Original start params snapshot. */
  params: LoopStartParams;
  /** Error message if state === Error. */
  error?: string;
}

// ============================================================================
// Loop Status (read-only view)
// ============================================================================

/**
 * Public status returned by loop_status().
 */
export interface LoopStatus {
  loopId: string;
  state: LoopState;
  currentStep: number;
  completedSteps: number;
  elapsedMs: number;
  startedAt: number;
  updatedAt: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Default max iterations. */
export const DEFAULT_MAX_STEPS = 10;

/** Default max wall-clock duration: 1 hour in ms. */
export const DEFAULT_MAX_DURATION_MS = 60 * 60 * 1000;

/** Default delay between iterations. */
export const DEFAULT_STEP_DELAY_MS = 0;

/** State file basename written into workDir. */
export const LOOP_STATE_FILE = '.loop-state.json';
