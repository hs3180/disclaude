/**
 * Loop Runner — Core execution engine that drives Agent turns via push_to_agent.
 *
 * The Runner manages the lifecycle of loop executions: start, step, check,
 * continue/stop. It is decoupled from any specific transport (MCP, REST, CLI)
 * via dependency injection of the pushToAgent function.
 *
 * Related #4063 (Phase 0b).
 *
 * @module task/loop-runner
 */

import {
  LOOP_DEFAULTS,
  TERMINAL_STATES,
  type LoopConfig,
  type LoopStartParams,
  type LoopStartResult,
  type LoopState,
  type LoopStatusParams,
  type LoopStatusResult,
  type LoopStopParams,
  type StepResult,
} from './loop-types.js';
import {
  checkTermination,
  createInitialState,
  getStepCounts,
  parseDuration,
  recordStep,
  startLoop,
  terminateLoop,
  writeLoopState,
} from './loop-state.js';

// ---------------------------------------------------------------------------
// Dependency injection types
// ---------------------------------------------------------------------------

/** Result of a pushToAgent call. */
export interface PushToAgentResult {
  /** Whether the message was successfully delivered. */
  success: boolean;
  /** Error message if success is false. */
  error?: string;
}

/**
 * Function signature for pushing a message to an Agent.
 *
 * Injected via constructor so the Runner is testable without
 * coupling to IPC, REST, or MCP transport.
 */
export type PushToAgentFn = (chatId: string, message: string) => Promise<PushToAgentResult>;

// ---------------------------------------------------------------------------
// Runtime execution handle
// ---------------------------------------------------------------------------

/** Internal handle for a running loop execution. */
interface LoopExecution {
  /** The persisted loop state. */
  state: LoopState;
  /** AbortController to cancel the running loop. */
  abortController: AbortController;
  /** The running promise (for awaiting completion). */
  promise: Promise<void>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Interval between steps when push succeeds. */
const DEFAULT_STEP_INTERVAL_MS = 5_000;

/** Interval between retry attempts when push fails. */
const DEFAULT_RETRY_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------
// LoopRunner
// ---------------------------------------------------------------------------

/**
 * Core loop execution engine.
 *
 * Manages multiple concurrent loop executions. Each loop drives an Agent
 * via the injected `pushToAgent` function using a fixed prompt.
 *
 * **maxSteps semantics**: Counts ALL attempts including failures.
 * A loop with maxSteps=3 will execute at most 3 steps total,
 * regardless of how many succeed or fail.
 *
 * **Memory management**: Completed loops are automatically removed
 * from the internal Map after a configurable cleanup delay.
 */
export class LoopRunner {
  private readonly loops = new Map<string, LoopExecution>();
  private readonly pushToAgent: PushToAgentFn;
  private readonly stepIntervalMs: number;
  private readonly retryIntervalMs: number;
  private readonly cleanupDelayMs: number;

  /**
   * @param pushToAgent - Function to send a message to an Agent.
   * @param options - Optional configuration.
   */
  constructor(
    pushToAgent: PushToAgentFn,
    options?: {
      /** Interval between successful steps. Default: 5000ms. */
      stepIntervalMs?: number;
      /** Interval between retry on push failure. Default: 10000ms. */
      retryIntervalMs?: number;
      /** Delay before removing completed loops from memory. Default: 30000ms. */
      cleanupDelayMs?: number;
    },
  ) {
    this.pushToAgent = pushToAgent;
    this.stepIntervalMs = options?.stepIntervalMs ?? DEFAULT_STEP_INTERVAL_MS;
    this.retryIntervalMs = options?.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    this.cleanupDelayMs = options?.cleanupDelayMs ?? 30_000;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start a new loop execution.
   *
   * Creates the initial state, persists it to disk, and begins the
   * execution loop in the background.
   */
  async start(params: LoopStartParams): Promise<LoopStartResult> {
    const loopId = generateLoopId();

    const config: LoopConfig = {
      maxSteps: params.maxSteps ?? LOOP_DEFAULTS.maxSteps,
      maxDurationMs: parseDuration(params.maxDuration ?? ''),
      maxConsecutiveFailures: params.maxConsecutiveFailures ?? LOOP_DEFAULTS.maxConsecutiveFailures,
    };

    let state = createInitialState({
      loopId,
      chatId: params.chatId,
      workDir: params.workDir,
      prompt: params.prompt,
      config,
    });

    // Persist initial state
    await writeLoopState(state);

    // Transition to running
    state = startLoop(state);
    await writeLoopState(state);

    // Set up execution
    const abortController = new AbortController();
    const promise = this.runLoop(state, abortController.signal);

    this.loops.set(loopId, { state, abortController, promise });

    return { loopId };
  }

  /**
   * Stop a running loop.
   *
   * Transitions the loop to 'stopped' state and persists it.
   * No-op if the loop is already in a terminal state or not found.
   */
  async stop(params: LoopStopParams): Promise<void> {
    const execution = this.loops.get(params.loopId);
    if (!execution) {
      return;
    }

    // Don't stop if already terminal
    if (TERMINAL_STATES.has(execution.state.state)) {
      return;
    }

    execution.abortController.abort();

    // Update state
    execution.state = terminateLoop(execution.state, 'stopped');
    await writeLoopState(execution.state);

    // Schedule cleanup
    this.scheduleCleanup(params.loopId);
  }

  /**
   * Get the status of a loop.
   *
   * Reads from the in-memory map if available, otherwise falls back
   * to reading from disk.
   */
  status(params: LoopStatusParams): LoopStatusResult | null {
    const execution = this.loops.get(params.loopId);
    if (execution) {
      return this.buildStatusResult(execution.state);
    }

    // Not in memory — either completed/cleaned or unknown
    return null;
  }

  /**
   * Get a loop's state from memory.
   */
  getState(loopId: string): LoopState | null {
    const execution = this.loops.get(loopId);
    if (execution) {
      return execution.state;
    }
    return null;
  }

  /**
   * Check if a loop is currently being managed.
   */
  has(loopId: string): boolean {
    return this.loops.has(loopId);
  }

  /**
   * Stop all running loops. Useful for graceful shutdown.
   */
  async stopAll(): Promise<void> {
    const loopIds = [...this.loops.keys()];
    await Promise.all(loopIds.map((id) => this.stop({ loopId: id })));
  }

  // -------------------------------------------------------------------------
  // Internal: main loop execution
  // -------------------------------------------------------------------------

  /**
   * Main execution loop. Runs steps until a termination condition is met
   * or the loop is aborted.
   */
  private async runLoop(initialState: LoopState, signal: AbortSignal): Promise<void> {
    let state = initialState;
    const { loopId } = state;

    try {
      while (!signal.aborted) {
        // Check termination before each step
        const termination = checkTermination(state);
        if (termination) {
          state = terminateLoop(state, termination as 'completed');
          await writeLoopState(state);
          this.updateExecution(loopId, state);
          this.scheduleCleanup(loopId);
          return;
        }

        // Execute one step
        const stepResult = await this.executeStep(state, signal);

        // If aborted during step, exit
        if (signal.aborted) {
          break;
        }

        // Record the step result
        state = recordStep(state, stepResult.result, stepResult.error);
        await writeLoopState(state);
        this.updateExecution(loopId, state);

        // Wait between steps
        if (!signal.aborted) {
          const interval = stepResult.result === 'failure'
            ? this.retryIntervalMs
            : this.stepIntervalMs;
          await this.delay(interval, signal);
        }
      }

      // If we exited due to abort, the stop() method already persisted the state
    } catch (_err) {
      // Unexpected error — terminate as failed
      if (!TERMINAL_STATES.has(state.state)) {
        state = terminateLoop(state, 'failed');
        await writeLoopState(state);
        this.updateExecution(loopId, state);
      }
    }
  }

  /**
   * Execute a single step: send the prompt to the Agent.
   */
  private async executeStep(
    state: LoopState,
    signal: AbortSignal,
  ): Promise<{ result: StepResult; error?: string }> {
    if (signal.aborted) {
      return { result: 'skipped' };
    }

    try {
      const response = await this.pushToAgent(state.chatId, state.prompt);

      if (response.success) {
        return { result: 'success' };
      }

      // pushToAgent returned { success: false } — treat as failure
      return {
        result: 'failure',
        error: response.error ?? 'pushToAgent returned success: false',
      };
    } catch (err) {
      return {
        result: 'failure',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // -------------------------------------------------------------------------
  // Internal: utilities
  // -------------------------------------------------------------------------

  /**
   * Delay with abort signal support.
   *
   * Cleans up the abort listener on normal completion to avoid
   * listener leaks.
   */
  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }

      let cleaned = false;

      const onAbort = (): void => {
        if (!cleaned) {
          cleaned = true;
          clearTimeout(timer);
          resolve();
        }
      };

      const timer = setTimeout(() => {
        if (!cleaned) {
          cleaned = true;
          signal.removeEventListener('abort', onAbort);
          resolve();
        }
      }, ms);

      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Update the in-memory execution state.
   */
  private updateExecution(loopId: string, state: LoopState): void {
    const execution = this.loops.get(loopId);
    if (execution) {
      execution.state = state;
    }
  }

  /**
   * Schedule removal of a completed loop from memory.
   *
   * This prevents memory leaks by cleaning up loops that have
   * reached a terminal state.
   */
  private scheduleCleanup(loopId: string): void {
    setTimeout(() => {
      this.loops.delete(loopId);
    }, this.cleanupDelayMs).unref();
  }

  /**
   * Build a LoopStatusResult from a LoopState.
   */
  private buildStatusResult(state: LoopState): LoopStatusResult {
    const counts = getStepCounts(state);
    const elapsedMs = state.startedAt
      ? Date.now() - new Date(state.startedAt).getTime()
      : 0;

    return {
      loopId: state.loopId,
      state: state.state,
      currentStep: state.currentStep,
      totalSteps: state.config.maxSteps,
      completedSteps: counts.completed,
      failedSteps: counts.failed,
      consecutiveFailures: state.consecutiveFailures,
      elapsedMs,
    };
  }
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a unique loop ID.
 * Format: loop_<timestamp>_<random>
 */
function generateLoopId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `loop_${ts}_${rand}`;
}
