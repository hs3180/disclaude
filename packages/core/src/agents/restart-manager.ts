/**
 * RestartManager - Manages Agent loop restart with backoff and circuit breaker.
 *
 * Prevents infinite restart loops by implementing:
 * - Maximum restart count limit
 * - Exponential backoff between restarts
 * - Circuit breaker to pause processing after repeated failures
 *
 * Architecture:
 * ```
 * ChatAgent.processIterator() error
 *         ↓
 * RestartManager.shouldRestart()
 *         ↓
 * ┌───────┴───────┐
 * │ Allow restart │ → wait(backoff) → restart
 * │ Block restart │ → circuit open, stop processing
 * └───────────────┘
 * ```
 *
 * @module agents/restart-manager
 */

import type { Logger } from '../utils/logger.js';

/**
 * Configuration for RestartManager.
 */
export interface RestartManagerConfig {
  /** Logger instance */
  logger: Logger;
  /** Maximum consecutive restarts before circuit opens (default: 3) */
  maxRestarts?: number;
  /** Initial backoff in milliseconds (default: 5000) */
  initialBackoffMs?: number;
  /** Maximum backoff in milliseconds (default: 60000) */
  maxBackoffMs?: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number;
  /** Time window in ms to reset restart count after success (default: 60000) */
  resetWindowMs?: number;
}

/**
 * Restart state for a chatId.
 */
interface RestartState {
  /** Number of consecutive restarts */
  restartCount: number;
  /** Timestamp of last restart */
  lastRestartAt: number;
  /** Timestamp of last successful operation */
  lastSuccessAt: number;
  /** Current backoff duration */
  currentBackoffMs: number;
  /** Whether circuit is open (blocking restarts) */
  circuitOpen: boolean;
  /** Error messages from recent failures */
  recentErrors: Array<{ message: string; timestamp: number }>;
}

/**
 * Result of shouldRestart check.
 */
export interface RestartDecision {
  /** Whether restart is allowed */
  allowed: boolean;
  /** Reason if not allowed */
  reason?: 'max_restarts_exceeded' | 'circuit_open' | 'backoff_pending';
  /** Time to wait before restart in ms (if allowed) */
  waitMs?: number;
  /** Current restart count */
  restartCount: number;
  /** Whether circuit is now open */
  circuitOpen: boolean;
}

/**
 * RestartManager - Manages Agent restart with protection mechanisms.
 *
 * Per-chatId tracking:
 * - Counts consecutive restarts
 * - Calculates exponential backoff
 * - Opens circuit breaker after max restarts
 * - Resets on successful operation
 *
 * @example
 * ```typescript
 * const manager = new RestartManager({ logger, maxRestarts: 3 });
 *
 * // On iterator error
 * const decision = manager.shouldRestart(chatId, errorMessage);
 * if (decision.allowed) {
 *   await sleep(decision.waitMs);
 *   restartAgentLoop();
 * } else {
 *   notifyUser(`Session paused: ${decision.reason}`);
 * }
 *
 * // On successful message
 * manager.recordSuccess(chatId);
 * ```
 */
export class RestartManager {
  private readonly logger: Logger;
  private readonly maxRestarts: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly backoffMultiplier: number;
  private readonly resetWindowMs: number;

  /** Per-chatId restart states */
  private readonly states = new Map<string, RestartState>();

  /** Maximum number of recent errors to keep */
  private readonly maxRecentErrors = 5;

  constructor(config: RestartManagerConfig) {
    this.logger = config.logger;
    this.maxRestarts = config.maxRestarts ?? 3;
    this.initialBackoffMs = config.initialBackoffMs ?? 5000;
    this.maxBackoffMs = config.maxBackoffMs ?? 60000;
    this.backoffMultiplier = config.backoffMultiplier ?? 2;
    this.resetWindowMs = config.resetWindowMs ?? 60000;
  }

  /**
   * Check if restart is allowed and calculate wait time.
   *
   * @param chatId - The chat identifier
   * @param errorMessage - The error that triggered restart consideration
   * @returns RestartDecision with allowed status and wait time
   */
  shouldRestart(chatId: string, errorMessage: string): RestartDecision {
    const now = Date.now();
    let state = this.states.get(chatId);

    // Create new state if not exists
    if (!state) {
      state = {
        restartCount: 0,
        lastRestartAt: 0,
        lastSuccessAt: now,
        currentBackoffMs: this.initialBackoffMs,
        circuitOpen: false,
        recentErrors: [],
      };
      this.states.set(chatId, state);
    }

    // Record the error
    state.recentErrors.push({ message: errorMessage, timestamp: now });
    if (state.recentErrors.length > this.maxRecentErrors) {
      state.recentErrors.shift();
    }

    // Check if circuit is already open
    if (state.circuitOpen) {
      this.logger.warn({ chatId, restartCount: state.restartCount }, 'Circuit already open, restart blocked');
      return {
        allowed: false,
        reason: 'circuit_open',
        restartCount: state.restartCount,
        circuitOpen: true,
      };
    }

    // Check if max restarts exceeded
    if (state.restartCount >= this.maxRestarts) {
      state.circuitOpen = true;
      this.logger.error(
        { chatId, restartCount: state.restartCount, maxRestarts: this.maxRestarts },
        'Max restarts exceeded, circuit opened'
      );
      return {
        allowed: false,
        reason: 'max_restarts_exceeded',
        restartCount: state.restartCount,
        circuitOpen: true,
      };
    }

    // Calculate backoff
    const timeSinceLastRestart = now - state.lastRestartAt;
    const waitMs = Math.max(0, state.currentBackoffMs - timeSinceLastRestart);

    // Update state
    state.restartCount++;
    state.lastRestartAt = now;
    state.currentBackoffMs = Math.min(
      state.currentBackoffMs * this.backoffMultiplier,
      this.maxBackoffMs
    );

    this.logger.warn(
      {
        chatId,
        restartCount: state.restartCount,
        maxRestarts: this.maxRestarts,
        waitMs,
        nextBackoffMs: state.currentBackoffMs,
        errorMessage,
      },
      'Restart allowed with backoff'
    );

    return {
      allowed: true,
      waitMs,
      restartCount: state.restartCount,
      circuitOpen: false,
    };
  }

  /**
   * Record a successful operation.
   *
   * Resets the restart count and closes the circuit if enough time has passed.
   *
   * @param chatId - The chat identifier
   */
  recordSuccess(chatId: string): void {
    const state = this.states.get(chatId);
    if (!state) {
      return;
    }

    const now = Date.now();
    state.lastSuccessAt = now;

    // Reset restart count and backoff if we've had success
    if (state.restartCount > 0) {
      this.logger.info(
        { chatId, previousRestartCount: state.restartCount },
        'Success recorded, resetting restart state'
      );
      state.restartCount = 0;
      state.currentBackoffMs = this.initialBackoffMs;
      state.recentErrors = [];
    }

    // Close circuit if it was open and enough time has passed
    if (state.circuitOpen) {
      const timeSinceLastError = now - (state.recentErrors[state.recentErrors.length - 1]?.timestamp ?? 0);
      if (timeSinceLastError > this.resetWindowMs) {
        state.circuitOpen = false;
        this.logger.info({ chatId }, 'Circuit closed after cooldown period');
      }
    }
  }

  /**
   * Manually reset the restart state for a chatId.
   *
   * Used when user explicitly resets the conversation.
   *
   * @param chatId - The chat identifier
   */
  reset(chatId: string): void {
    const existed = this.states.delete(chatId);
    if (existed) {
      this.logger.info({ chatId }, 'Restart state reset');
    }
  }

  /** Get the current restart state for a chatId. */
  getState(chatId: string): RestartState | undefined {
    return this.states.get(chatId);
  }

  /** Get recent errors for a chatId. */
  getRecentErrors(chatId: string): Array<{ message: string; timestamp: number }> {
    return this.states.get(chatId)?.recentErrors ?? [];
  }

  /** Check if circuit is open for a chatId. */
  isCircuitOpen(chatId: string): boolean {
    return this.states.get(chatId)?.circuitOpen ?? false;
  }

  /** Clear all restart states. */
  clearAll(): void {
    this.states.clear();
    this.logger.debug('All restart states cleared');
  }
}
