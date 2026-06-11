/**
 * Loop Runner type definitions.
 *
 * Issue #4063 (Phase 0): Core types for the Loop Runner execution engine.
 *
 * The Loop Runner is a generic execution engine that drives an Agent
 * in a loop using a fixed prompt. It is domain-agnostic — domain-specific
 * details (like RESEARCH.md parsing) are passed via the prompt content.
 *
 * @module @disclaude/core/loop
 */

/**
 * Configuration for starting a new loop.
 */
export interface LoopStartConfig {
  /** Chat ID where the Agent operates */
  chatId: string;
  /** Working directory for loop state persistence */
  workDir: string;
  /** Fixed prompt sent to the Agent on every iteration */
  prompt: string;
  /** Maximum number of iterations (default: 10) */
  maxSteps?: number;
  /** Maximum execution duration in milliseconds (default: 7200000 = 2h) */
  maxDurationMs?: number;
}

/**
 * Possible states of a loop.
 */
export type LoopState = 'running' | 'stopped' | 'completed' | 'failed' | 'timeout';

/**
 * Reason why a loop iteration failed.
 */
export type StepFailureReason = 'agent_error' | 'timeout' | 'unknown';

/**
 * Record of a single loop iteration.
 */
export interface LoopStepRecord {
  /** 1-based step number */
  step: number;
  /** Timestamp when this step started (ISO 8601) */
  startedAt: string;
  /** Timestamp when this step ended (ISO 8601) */
  endedAt?: string;
  /** Whether this step completed successfully */
  success: boolean;
  /** Failure reason if success is false */
  failureReason?: StepFailureReason;
  /** Error message if success is false */
  error?: string;
}

/**
 * Persistent loop state, serialized to `.loop-state.json` in workDir.
 */
export interface LoopStateFile {
  /** Unique loop identifier */
  loopId: string;
  /** Current state of the loop */
  state: LoopState;
  /** Configuration used to start this loop */
  config: LoopStartConfig;
  /** Timestamp when the loop was created (ISO 8601) */
  startedAt: string;
  /** Timestamp when the loop ended (ISO 8601) */
  endedAt?: string;
  /** Total number of completed steps */
  completedSteps: number;
  /** Number of consecutive failures */
  consecutiveFailures: number;
  /** Maximum consecutive failures allowed (default: 3) */
  maxConsecutiveFailures: number;
  /** History of all step attempts */
  steps: LoopStepRecord[];
}

/**
 * Return type for `loop_status`.
 */
export interface LoopStatusResult {
  /** Loop ID */
  loopId: string;
  /** Current state */
  state: LoopState;
  /** Number of successfully completed steps */
  completedSteps: number;
  /** Number of failed steps */
  failedSteps: number;
  /** Currently executing step number, or null if not running */
  currentStep: number | null;
  /** Elapsed time since start in milliseconds */
  elapsedMs: number;
}

/**
 * Callback interface for the Loop Runner to interact with external systems.
 * This abstraction allows testing without real MCP/IPC dependencies.
 */
export interface LoopRunnerCallbacks {
  /**
   * Push a message to an Agent in a specific chat.
   * Corresponds to the `push_to_agent` MCP tool.
   */
  pushToAgent: (chatId: string, message: string) => Promise<{ success: boolean; error?: string }>;

  /**
   * Called when the loop completes (successfully, by timeout, or by error).
   * Can be used to send a notification to the chat.
   */
  onLoopComplete?: (loopId: string, result: LoopStatusResult) => Promise<void>;
}

/**
 * Configuration options for the LoopRunner constructor.
 */
export interface LoopRunnerOptions {
  /** Default max steps per loop (default: 10) */
  defaultMaxSteps?: number;
  /** Default max duration in ms (default: 7200000 = 2h) */
  defaultMaxDurationMs?: number;
  /** Default max consecutive failures (default: 3) */
  defaultMaxConsecutiveFailures?: number;
  /** Delay between steps in ms (default: 1000) */
  stepDelayMs?: number;
}
