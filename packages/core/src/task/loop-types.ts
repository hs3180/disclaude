/**
 * Loop Types — Type definitions, interfaces, and constants for the Loop Runner.
 *
 * The Loop Runner is a generic execution engine that drives an Agent in a loop
 * using a fixed prompt. It does not know about domain-specific concepts
 * (like RESEARCH.md or LOOP.md); all domain context is passed via the prompt.
 *
 * Related #4063 (Phase 0a).
 *
 * @module task/loop-types
 */

// ---------------------------------------------------------------------------
// Loop State
// ---------------------------------------------------------------------------

/** Current state of a loop execution. */
export type LoopRunState =
  | 'pending'    // Registered but not yet started
  | 'running'    // Actively executing steps
  | 'paused'     // Temporarily paused
  | 'completed'  // All steps finished successfully
  | 'failed'     // Terminated due to consecutive failures
  | 'timeout'    // Terminated due to max duration
  | 'stopped';   // Externally stopped via loop_stop

// ---------------------------------------------------------------------------
// Loop Configuration
// ---------------------------------------------------------------------------

/** Configuration for a loop execution. */
export interface LoopConfig {
  /** Maximum number of Agent turns (steps) to execute. Default: 10. */
  maxSteps: number;
  /** Maximum execution duration in milliseconds. Default: 2h. */
  maxDurationMs: number;
  /** Maximum consecutive failures before stopping. Default: 3. */
  maxConsecutiveFailures: number;
}

// ---------------------------------------------------------------------------
// Loop Step Tracking
// ---------------------------------------------------------------------------

/** Result of a single Agent turn (step) within a loop. */
export type StepResult = 'success' | 'failure' | 'skipped';

/** Record of a single completed step. */
export interface LoopStepRecord {
  /** 1-based step number. */
  step: number;
  /** Result of this step. */
  result: StepResult;
  /** ISO timestamp when the step started. */
  startedAt: string;
  /** ISO timestamp when the step completed. */
  completedAt: string;
  /** Optional error message on failure. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Loop State (persisted to .loop-state.json)
// ---------------------------------------------------------------------------

/** Persisted loop state, stored in the workDir. */
export interface LoopState {
  /** Unique loop identifier. */
  loopId: string;
  /** Current execution state. */
  state: LoopRunState;
  /** Chat ID where the Agent runs. */
  chatId: string;
  /** Working directory for the loop. */
  workDir: string;
  /** Fixed prompt used for each Agent turn. */
  prompt: string;
  /** Loop configuration. */
  config: LoopConfig;
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

// ---------------------------------------------------------------------------
// API Types (MCP / CLI / REST interfaces)
// ---------------------------------------------------------------------------

/** Parameters for loop_start. */
export interface LoopStartParams {
  /** Chat ID where the Agent runs. */
  chatId: string;
  /** Working directory for the loop. */
  workDir: string;
  /** Fixed prompt used for each Agent turn. */
  prompt: string;
  /** Maximum steps. Default: 10. */
  maxSteps?: number;
  /** Maximum duration (e.g. "2h", "30m"). Default: "2h". */
  maxDuration?: string;
  /** Maximum consecutive failures. Default: 3. */
  maxConsecutiveFailures?: number;
}

/** Result of loop_start. */
export interface LoopStartResult {
  loopId: string;
}

/** Parameters for loop_stop. */
export interface LoopStopParams {
  loopId: string;
}

/** Parameters for loop_status. */
export interface LoopStatusParams {
  loopId: string;
}

/** Result of loop_status. */
export interface LoopStatusResult {
  loopId: string;
  state: LoopRunState;
  currentStep: number;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  consecutiveFailures: number;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// IPC Message Types
// ---------------------------------------------------------------------------

/** IPC request types for loop operations. */
export type LoopIpcRequest =
  | { type: 'loopStart'; params: LoopStartParams }
  | { type: 'loopStop'; params: LoopStopParams }
  | { type: 'loopStatus'; params: LoopStatusParams };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default loop configuration values. */
export const LOOP_DEFAULTS: LoopConfig = {
  maxSteps: 10,
  maxDurationMs: 2 * 60 * 60 * 1000, // 2h
  maxConsecutiveFailures: 3,
};

/** File name for persisted loop state. */
export const LOOP_STATE_FILE = '.loop-state.json';

/** Terminal states — loop execution has ended. */
export const TERMINAL_STATES: ReadonlySet<LoopRunState> = new Set([
  'completed',
  'failed',
  'timeout',
  'stopped',
]);
