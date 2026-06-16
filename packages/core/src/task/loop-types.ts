/**
 * Loop Types — Type definitions for the Loop Runner.
 *
 * Related #4063 (Phase 0a).
 *
 * @module task/loop-types
 */

/** Current state of a loop execution. */
export type LoopRunState =
  | 'pending'    // Registered but not yet started
  | 'running'    // Actively executing steps
  | 'completed'  // All steps finished successfully
  | 'failed'     // Terminated due to consecutive failures
  | 'stopped';   // Externally stopped via loop_stop

/** Result of a single Agent turn (step) within a loop. */
export type StepResult = 'success' | 'failure';

/** Record of a single completed step. */
export interface LoopStepRecord {
  /** 1-based step number. */
  step: number;
  /** Result of this step. */
  result: StepResult;
  /** ISO timestamp when the step completed. */
  completedAt: string;
  /** Optional error message on failure. */
  error?: string;
}

/** Persisted loop state, stored in the workDir as `.loop-state.json`. */
export interface LoopState {
  /** Unique loop identifier. */
  loopId: string;
  /** Current execution state. */
  state: LoopRunState;
  /** Working directory for the loop. */
  workDir: string;
  /** Fixed prompt used for each Agent turn. */
  prompt: string;
  /** Maximum number of Agent turns. Default: 10. */
  maxSteps: number;
  /** Maximum consecutive failures before stopping. Default: 3. */
  maxConsecutiveFailures: number;
  /** 1-based index of the current (or next) step. 0 means not started. */
  currentStep: number;
  /** Number of consecutive failures. Reset on success. */
  consecutiveFailures: number;
  /** ISO timestamp when the loop was created. */
  createdAt: string;
  /** ISO timestamp when the loop was started (first step). */
  startedAt?: string;
  /** ISO timestamp when the loop terminated. */
  completedAt?: string;
  /** Records of completed steps. */
  steps: LoopStepRecord[];
}

/** File name for persisted loop state. */
export const LOOP_STATE_FILE = '.loop-state.json';

/** Default values for loop configuration fields. */
export const LOOP_DEFAULTS = {
  maxSteps: 10,
  maxConsecutiveFailures: 3,
} as const;

/** Terminal states — loop execution has ended. */
export const TERMINAL_STATES: ReadonlySet<LoopRunState> = new Set([
  'completed',
  'failed',
  'stopped',
]);
