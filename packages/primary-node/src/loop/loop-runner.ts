/**
 * Loop Runner — simplified runtime execution engine.
 *
 * Issue #4075: Loop = while loop + push_to_agent + counter.
 * No complex state persistence, no multi-layer type hierarchy.
 *
 * @module primary-node/loop/loop-runner
 */

import { createLogger, readLoopMd } from '@disclaude/core';

const logger = createLogger('LoopRunner');

/** Loop state values. */
export type LoopState = 'running' | 'completed' | 'stopped' | 'error';

/** Parameters for starting a loop. */
export interface LoopStartParams {
  /** Target chat ID to push instructions to. */
  chatId: string;
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
  /**
   * When set, the loop was started from a LOOP.md definition file (Issue #4193)
   * and the prompt is re-read from this path each iteration (read-only at
   * runtime → no write conflict with an editor). Undefined for inline-prompt
   * loops, which keep using the static {@link LoopExecution.prompt}.
   */
  loopMdPath?: string;
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

/** Options for the LoopRunner constructor (Issue #4075). */
export interface LoopRunnerOptions {
  /** Interval between automatic cleanup sweeps in ms (default: 3600000 = 1 hour). */
  cleanupIntervalMs?: number;
  /** Max age of finished loops before a sweep removes them, in ms (default: 3600000 = 1 hour). */
  cleanupMaxAgeMs?: number;
}

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
  private cleanupMaxAgeMs: number;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(pushCallback: PushToAgentCallback, options: LoopRunnerOptions = {}) {
    this.pushCallback = pushCallback;
    this.cleanupMaxAgeMs = options.cleanupMaxAgeMs ?? 3600_000;

    // Issue #4075: periodically prune finished loops so the in-memory Map does not
    // grow without bound over the process lifetime. unref() so the timer never
    // keeps the process (or the test runner) alive on its own.
    const intervalMs = options.cleanupIntervalMs ?? 3600_000;
    this.cleanupTimer = setInterval(() => this.cleanup(this.cleanupMaxAgeMs), intervalMs);
    this.cleanupTimer.unref?.();
  }

  /**
   * Stop the automatic cleanup timer. Safe to call multiple times.
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * Start a new loop execution.
   *
   * @returns The loop ID for subsequent stop/status calls.
   */
  start(params: LoopStartParams): { loopId: string } {
    const loopId = this.nextLoopId();
    const maxSteps = Math.max(1, Math.floor(params.maxSteps ?? 10));

    const execution: LoopExecution = {
      loopId,
      chatId: params.chatId,
      prompt: params.prompt,
      maxSteps,
      maxDurationMs: Math.max(1000, params.maxDurationMs ?? 3600_000),
      stepIntervalMs: Math.max(100, params.stepIntervalMs ?? 30_000),
      state: 'running',
      currentStep: 0,
      totalSteps: maxSteps,
      startedAt: Date.now(),
      abortController: new AbortController(),
    };

    this.launchLoop(execution);
    logger.info({ loopId, chatId: params.chatId, maxSteps }, 'Loop started');
    return { loopId };
  }

  /**
   * Start a loop driven by a LOOP.md definition file (Issue #4193).
   *
   * Reads the structural params (`chatId` / `maxSteps` / `maxDuration` /
   * `stepInterval`) and the initial prompt from the LOOP.md at `loopMdPath`,
   * then runs the loop. The prompt is **re-read from the file each iteration**
   * (see {@link LoopRunner.runLoop}), so the definition file is the source of
   * truth and stays read-only at runtime — no write conflict with a user or
   * editor who adjusts the prompt mid-run. This is the LOOP.md-driven mode the
   * issue prescribes; the existing inline-prompt {@link LoopRunner.start} path
   * is unchanged, and migrating the MCP/IPC/REST `loop_start` contract onto
   * LOOP.md is a later part.
   *
   * @returns The loop ID for subsequent stop/status calls.
   * @throws when the LOOP.md cannot be read/parsed, or lacks a `chatId`.
   */
  startFromLoopMd(loopMdPath: string): { loopId: string } {
    const def = readLoopMd(loopMdPath);
    if (!def.params.chatId) {
      throw new Error(`LOOP.md at ${loopMdPath} is missing required field "chatId"`);
    }
    const loopId = this.nextLoopId();
    // The parser already applied defaults for absent fields, so clamp the raw
    // values directly (mirrors `start()` — e.g. maxSteps 0 → 1, not 0 → 10).
    const maxSteps = Math.max(1, Math.floor(def.params.maxSteps));

    const execution: LoopExecution = {
      loopId,
      chatId: def.params.chatId,
      prompt: def.prompt,
      loopMdPath,
      maxSteps,
      maxDurationMs: Math.max(1000, def.params.maxDurationMs),
      stepIntervalMs: Math.max(100, def.params.stepIntervalMs),
      state: 'running',
      currentStep: 0,
      totalSteps: maxSteps,
      startedAt: Date.now(),
      abortController: new AbortController(),
    };

    this.launchLoop(execution);
    logger.info({ loopId, chatId: def.params.chatId, loopMdPath, maxSteps }, 'Loop started from LOOP.md');
    return { loopId };
  }

  /** Mint the next monotonically-numbered loop ID. */
  private nextLoopId(): string {
    return `loop-${++this.idCounter}-${Date.now()}`;
  }

  /** Register an execution and fire-and-forget its runLoop. */
  private launchLoop(execution: LoopExecution): void {
    this.loops.set(execution.loopId, execution);
    void this.runLoop(execution).catch((error) => {
      logger.error({ err: error, loopId: execution.loopId }, 'Loop execution failed');
      if (execution.state === 'running') {
        execution.state = 'error';
      }
    });
  }

  /**
   * Stop a running loop.
   *
   * @returns true if the loop existed (stopped if it was still running), false if not found.
   */
  stop(loopId: string): boolean {
    const execution = this.loops.get(loopId);
    if (!execution) {
      logger.warn({ loopId }, 'Attempted to stop unknown loop');
      return false;
    }
    if (execution.state === 'running') {
      execution.state = 'stopped';
      execution.abortController.abort();
      logger.info({ loopId, currentStep: execution.currentStep }, 'Loop stopped');
    }
    return true;
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
      // Issue #4193: when started from a LOOP.md, re-read the prompt each
      // iteration so edits to the definition file take effect on the next step
      // (the file is read-only at runtime → no write conflict). A transient
      // re-read failure falls back to the last known prompt rather than killing
      // the loop — losing one prompt refresh is preferable to aborting a
      // long-running loop over a momentary fs hiccup.
      let { prompt } = execution;
      if (execution.loopMdPath) {
        try {
          const refreshed = readLoopMd(execution.loopMdPath).prompt;
          if (refreshed) {
            prompt = refreshed;
            execution.prompt = refreshed; // remember as the new fallback
          }
        } catch (error) {
          logger.warn(
            { err: error, loopId: execution.loopId, step: i + 1, loopMdPath: execution.loopMdPath },
            'Failed to re-read LOOP.md; using last known prompt',
          );
        }
      }
      try {
        await this.pushCallback(execution.chatId, prompt);
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
   *
   * Issue #4063: the `abort` listener is removed on BOTH paths — the normal
   * timeout path (`removeEventListener`) and the abort path (`{ once: true }`).
   * Without this, a loop that runs many steps and completes normally would
   * accumulate one dangling listener per step on the same AbortSignal, since
   * the listener was never detached on the timeout path and `{ once: true }`
   * only auto-removes when abort actually fires.
   */
  private waitForInterval(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      // `onAbort` is a hoisted function declaration so it can be referenced by
      // the timer below while itself referencing `timer` (assigned next).
      function onAbort(): void {
        clearTimeout(timer);
        resolve();
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
