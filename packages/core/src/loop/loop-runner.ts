/**
 * Loop Runner — generic autonomous execution engine.
 *
 * Issue #4063 (Phase 0): Drives an Agent in a loop using a fixed prompt.
 *
 * The Runner:
 * 1. Calls `push_to_agent` with the same prompt each iteration
 * 2. Waits for the Agent turn to complete
 * 3. Checks termination conditions (timeout, failures, step limit)
 * 4. Records progress to `.loop-state.json`
 *
 * It is domain-agnostic — it does not know about RESEARCH.md, LOOP.md, or
 * any other domain concept. Domain details are passed via the prompt content.
 *
 * @module @disclaude/core/loop
 */

import { randomUUID } from 'crypto';
import { createLogger } from '../utils/logger.js';
import {
  type LoopStartConfig,
  type LoopState,
  type LoopStatusResult,
  type LoopRunnerCallbacks,
  type LoopRunnerOptions,
  type LoopStateFile,
} from './loop-types.js';
import {
  readLoopState,
  writeLoopState,
  createInitialLoopState,
  beginStep,
  finishStep,
  checkTermination,
} from './loop-state.js';

const logger = createLogger('LoopRunner');

const DEFAULT_MAX_STEPS = 10;
const DEFAULT_MAX_DURATION_MS = 2 * 60 * 60 * 1000; // 2h
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_STEP_DELAY_MS = 1000;

/**
 * Active loop tracking entry.
 */
interface ActiveLoop {
  state: LoopStateFile;
  abortController: AbortController;
  runningPromise?: Promise<LoopState>;
}

/**
 * Loop Runner — manages and executes autonomous loops.
 *
 * Usage:
 * ```ts
 * const runner = new LoopRunner(callbacks);
 * const loopId = await runner.start({ chatId, workDir, prompt, maxSteps: 5 });
 * // ... later ...
 * const status = runner.getStatus(loopId);
 * await runner.stop(loopId);
 * ```
 */
export class LoopRunner {
  private readonly options: Required<LoopRunnerOptions>;
  private readonly callbacks: LoopRunnerCallbacks;
  /** Active loops keyed by loopId */
  private readonly loops = new Map<string, ActiveLoop>();

  constructor(callbacks: LoopRunnerCallbacks, options?: LoopRunnerOptions) {
    this.callbacks = callbacks;
    this.options = {
      defaultMaxSteps: options?.defaultMaxSteps ?? DEFAULT_MAX_STEPS,
      defaultMaxDurationMs: options?.defaultMaxDurationMs ?? DEFAULT_MAX_DURATION_MS,
      defaultMaxConsecutiveFailures: options?.defaultMaxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES,
      stepDelayMs: options?.stepDelayMs ?? DEFAULT_STEP_DELAY_MS,
    };
  }

  /**
   * Start a new loop.
   * @returns The loop ID
   */
  async start(config: LoopStartConfig): Promise<string> {
    const loopId = randomUUID();
    const maxSteps = config.maxSteps ?? this.options.defaultMaxSteps;
    const maxDurationMs = config.maxDurationMs ?? this.options.defaultMaxDurationMs;

    logger.info(`Starting loop ${loopId} (chatId=${config.chatId}, maxSteps=${maxSteps})`);

    // Initialize persistent state
    const state = createInitialLoopState(
      loopId,
      config,
      this.options.defaultMaxConsecutiveFailures,
    );
    await writeLoopState(config.workDir, state);

    // Register as active
    const abortController = new AbortController();
    const active: ActiveLoop = { state, abortController };
    this.loops.set(loopId, active);

    // Start the loop execution (non-blocking)
    active.runningPromise = this.runLoop(loopId, active, maxSteps, maxDurationMs);

    return loopId;
  }

  /**
   * Stop a running loop.
   */
  async stop(loopId: string): Promise<boolean> {
    const active = this.loops.get(loopId);
    if (!active) {
      return false;
    }

    logger.info(`Stopping loop ${loopId}`);
    active.abortController.abort();

    // Wait for the loop to finish
    if (active.runningPromise) {
      await active.runningPromise.catch(() => { /* already stopped */ });
    }

    return true;
  }

  /**
   * Get the status of a loop.
   * Works for both active and completed loops.
   */
  getStatus(loopId: string): LoopStatusResult | null {
    const active = this.loops.get(loopId);
    if (!active) {
      return null;
    }

    const { state } = active;
    const failedSteps = state.steps.filter(s => !s.success).length;
    const elapsedMs = Date.now() - new Date(state.startedAt).getTime();
    const currentStep = state.state === 'running' ? state.steps.length + 1 : null;

    return {
      loopId,
      state: state.state,
      completedSteps: state.completedSteps,
      failedSteps,
      currentStep,
      elapsedMs,
    };
  }

  /**
   * Get the status of a loop by reading from its persistent state file.
   * Useful for recovering loop state after a process restart.
   */
  async getStatusFromDisk(workDir: string): Promise<LoopStatusResult | null> {
    const state = await readLoopState(workDir);
    if (!state) {
      return null;
    }

    const failedSteps = state.steps.filter(s => !s.success).length;
    const elapsedMs = Date.now() - new Date(state.startedAt).getTime();

    return {
      loopId: state.loopId,
      state: state.state,
      completedSteps: state.completedSteps,
      failedSteps,
      currentStep: null,
      elapsedMs,
    };
  }

  /**
   * List all active loop IDs.
   */
  listActiveLoops(): string[] {
    return Array.from(this.loops.keys());
  }

  /**
   * The main loop execution logic.
   *
   * Each iteration:
   * 1. Check if aborted
   * 2. Begin a new step
   * 3. Push the fixed prompt to the Agent
   * 4. Record step result
   * 5. Check termination conditions
   * 6. Optionally delay before next iteration
   */
  private async runLoop(
    loopId: string,
    active: ActiveLoop,
    maxSteps: number,
    maxDurationMs: number,
  ): Promise<LoopState> {
    let currentState = active.state;

    try {
      while (true) {
        // Check abort signal
        if (active.abortController.signal.aborted) {
          currentState = await this.finalize(currentState, 'stopped', active.state.config.workDir);
          break;
        }

        // Check termination conditions from persisted state
        const termination = checkTermination(currentState, maxSteps, maxDurationMs);
        if (termination) {
          currentState = await this.finalize(currentState, termination, active.state.config.workDir);
          break;
        }

        // Begin new step
        const stepResult = beginStep(currentState);

        try {
          // Push to agent with the fixed prompt
          await this.callbacks.pushToAgent(currentState.config.chatId, currentState.config.prompt);

          // Check abort again after agent call
          if (active.abortController.signal.aborted) {
            currentState = await this.finalize(currentState, 'stopped', active.state.config.workDir);
            break;
          }

          // Mark step as success
          currentState = finishStep(currentState, stepResult.currentStep, true);
          await writeLoopState(active.state.config.workDir, currentState);
          active.state = currentState;
        } catch (error) {
          // Mark step as failure
          const errorMessage = error instanceof Error ? error.message : String(error);
          currentState = finishStep(currentState, stepResult.currentStep, false, {
            failureReason: 'agent_error',
            error: errorMessage,
          });
          await writeLoopState(active.state.config.workDir, currentState);
          active.state = currentState;
        }

        // Check termination after step completion
        const postStepTermination = checkTermination(currentState, maxSteps, maxDurationMs);
        if (postStepTermination) {
          currentState = await this.finalize(currentState, postStepTermination, active.state.config.workDir);
          break;
        }

        // Delay between steps
        if (this.options.stepDelayMs > 0) {
          await this.delay(this.options.stepDelayMs, active.abortController.signal);
        }
      }
    } catch (error) {
      // Unexpected error — mark loop as failed
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Loop ${loopId} unexpected error: ${errorMessage}`);
      currentState = await this.finalize(currentState, 'failed', active.state.config.workDir);
    }

    // Notify completion
    const status = this.getStatus(loopId);
    if (status && this.callbacks.onLoopComplete) {
      try {
        await this.callbacks.onLoopComplete(loopId, status);
      } catch {
        // Don't let notification errors affect loop result
      }
    }

    return currentState.state;
  }

  /**
   * Finalize a loop: set end state, persist, and update active state.
   */
  private async finalize(
    state: LoopStateFile,
    endState: LoopState,
    workDir: string,
  ): Promise<LoopStateFile> {
    const finalized: LoopStateFile = {
      ...state,
      state: endState,
      endedAt: new Date().toISOString(),
    };
    await writeLoopState(workDir, finalized);

    // Update active state so getStatus() returns correct state
    const active = this.loops.get(state.loopId);
    if (active) {
      active.state = finalized;
    }

    logger.info(`Loop ${state.loopId} finalized: ${endState} (${finalized.completedSteps} completed, ${finalized.steps.length} total steps)`);

    return finalized;
  }

  /**
   * Delay that respects abort signal.
   */
  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      // Clean up listener when delay completes normally
      // ( AbortController abort is a one-shot event so we don't need to remove on resolve)
    });
  }
}
