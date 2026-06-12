/**
 * Loop Runner — simplified runtime execution engine.
 *
 * Issue #4075: Loop = while loop + push_to_agent + counter.
 * No complex state persistence, no multi-layer type hierarchy.
 *
 * @module primary-node/loop/loop-runner
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('LoopRunner');

/** Loop state values. */
export type LoopState = 'running' | 'completed' | 'stopped' | 'error';

/** Parameters for starting a loop. */
export interface LoopStartParams {
  /** Target chat ID to push instructions to. */
  chatId: string;
  /** Working directory for the agent. */
  workDir?: string;
  /** The instruction prompt pushed to the agent each step. */
  prompt: string;
  /** Maximum number of loop iterations (default: 10). */
  maxSteps?: number;
  /** Maximum total duration in milliseconds (default: 3600000 = 1 hour). */
  maxDurationMs?: number;
  /** Interval between steps in milliseconds (default: 30000 = 30s). */
  stepIntervalMs?: number;
}

/** Internal loop execution state. */
interface LoopExecution {
  loopId: string;
  chatId: string;
  prompt: string;
  maxSteps: number;
  maxDurationMs: number;
  stepIntervalMs: number;
  state: LoopState;
  currentStep: number;
  totalSteps: number;
  startedAt: number;
  abortController: AbortController;
}

/** Loop status returned by status(). */
export interface LoopStatus {
  loopId: string;
  state: LoopState;
  currentStep: number;
  totalSteps: number;
  startedAt: string;
  error?: string;
}

/** Callback type for pushing instructions to an agent. */
export type PushToAgentCallback = (chatId: string, message: string) => Promise<void>;

/**
 * Simplified Loop Runner.
 *
 * Uses an in-memory Map to track running loops. Each loop is a simple
 * for-loop that calls pushToAgent at each step with a configurable interval.
 */
export class LoopRunner {
  private loops = new Map<string, LoopExecution>();
  private pushCallback: PushToAgentCallback;
  private idCounter = 0;

  constructor(pushCallback: PushToAgentCallback) {
    this.pushCallback = pushCallback;
  }

  /**
   * Start a new loop execution.
   *
   * @returns The loop ID for subsequent stop/status calls.
   */
  start(params: LoopStartParams): { loopId: string } {
    const loopId = `loop-${++this.idCounter}-${Date.now()}`;
    const maxSteps = params.maxSteps ?? 10;
    const maxDurationMs = params.maxDurationMs ?? 3600_000;
    const stepIntervalMs = params.stepIntervalMs ?? 30_000;

    const execution: LoopExecution = {
      loopId,
      chatId: params.chatId,
      prompt: params.prompt,
      maxSteps,
      maxDurationMs,
      stepIntervalMs,
      state: 'running',
      currentStep: 0,
      totalSteps: maxSteps,
      startedAt: Date.now(),
      abortController: new AbortController(),
    };

    this.loops.set(loopId, execution);

    // Fire-and-forget the loop execution
    void this.runLoop(execution).catch((error) => {
      logger.error({ err: error, loopId }, 'Loop execution failed');
      if (execution.state === 'running') {
        execution.state = 'error';
      }
    });

    logger.info({ loopId, chatId: params.chatId, maxSteps }, 'Loop started');
    return { loopId };
  }

  /**
   * Stop a running loop.
   */
  stop(loopId: string): void {
    const execution = this.loops.get(loopId);
    if (!execution) {
      logger.warn({ loopId }, 'Attempted to stop unknown loop');
      return;
    }
    if (execution.state === 'running') {
      execution.state = 'stopped';
      execution.abortController.abort();
      logger.info({ loopId, currentStep: execution.currentStep }, 'Loop stopped');
    }
  }

  /**
   * Get the status of a loop.
   *
   * @returns Loop status or null if not found.
   */
  status(loopId: string): LoopStatus | null {
    const execution = this.loops.get(loopId);
    if (!execution) {
      return null;
    }
    return {
      loopId: execution.loopId,
      state: execution.state,
      currentStep: execution.currentStep,
      totalSteps: execution.totalSteps,
      startedAt: new Date(execution.startedAt).toISOString(),
    };
  }

  /**
   * Clean up completed/stopped loops older than the given age.
   *
   * @param maxAgeMs - Maximum age in milliseconds (default: 1 hour).
   */
  cleanup(maxAgeMs?: number): number {
    const cutoff = Date.now() - (maxAgeMs ?? 3600_000);
    let removed = 0;
    for (const [loopId, execution] of this.loops) {
      if (execution.state !== 'running' && execution.startedAt < cutoff) {
        this.loops.delete(loopId);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Internal: run the loop until completion, stop, or timeout.
   */
  private async runLoop(execution: LoopExecution): Promise<void> {
    const { abortController } = execution;
    const { signal } = abortController;

    for (let i = 0; i < execution.maxSteps; i++) {
      // Check abort signal
      if (signal.aborted) {
        break;
      }

      // Check duration limit
      const elapsed = Date.now() - execution.startedAt;
      if (elapsed >= execution.maxDurationMs) {
        execution.state = 'completed';
        logger.info({ loopId: execution.loopId, reason: 'duration_exceeded', elapsed }, 'Loop completed');
        break;
      }

      // Push instruction to agent
      execution.currentStep = i + 1;
      try {
        await this.pushCallback(execution.chatId, execution.prompt);
      } catch (error) {
        logger.error({ err: error, loopId: execution.loopId, step: i + 1 }, 'Push to agent failed in loop');
        execution.state = 'error';
        return;
      }

      // Wait for step interval (unless this is the last step or aborted)
      if (i < execution.maxSteps - 1 && !signal.aborted) {
        await this.waitForInterval(execution.stepIntervalMs, signal);
      }
    }

    // Mark as completed if still running
    if (execution.state === 'running') {
      execution.state = 'completed';
      logger.info({ loopId: execution.loopId, steps: execution.currentStep }, 'Loop completed all steps');
    }
  }

  /**
   * Wait for the specified interval, or until the signal is aborted.
   */
  private waitForInterval(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
