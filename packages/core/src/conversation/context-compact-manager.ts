/**
 * ContextCompactManager - Framework-level auto compacting for active agents.
 *
 * Monitors cumulative input token usage per agent session and triggers
 * compaction when a configurable threshold is reached. The manager
 * never compacts during active processing to avoid corrupting state.
 *
 * Architecture:
 * ```
 * Consumer (Pilot/AgentPool) reports tokens
 *         ↓
 * ContextCompactManager.recordTokens(chatId, count)
 *         ↓
 * Periodic check (setInterval)
 *         ↓
 * ┌───────┴───────────────┐
 * │ tokens >= threshold   │ → not processing? → callbacks.onCompact(chatId)
 * │ tokens < threshold    │ → skip
 * │ currently processing  │ → skip (never compact during active processing)
 * └───────────────────────┘
 * ```
 *
 * Token tracking flow:
 * ```
 * Pilot.processIterator() → parsed.type === 'result'
 *   → metadata.inputTokens reported via recordTokens()
 *   → Manager accumulates per chatId
 *   → When threshold exceeded, triggers compaction callback
 *   → After compaction, tokens reset via resetTokens(chatId)
 * ```
 *
 * @module conversation/context-compact-manager
 */

import type { Logger } from '../utils/logger.js';
import type { ContextCompactConfig } from '../config/types.js';

/**
 * Callbacks interface for ContextCompactManager.
 *
 * Decouples the manager from specific compaction implementations.
 * The consumer (Pilot/AgentPool) provides these callbacks.
 */
export interface ContextCompactCallbacks {
  /**
   * Called when compaction should be triggered for a session.
   * The consumer is responsible for performing the actual compaction
   * (e.g., reset + summary injection).
   *
   * @param chatId - The chat identifier that needs compaction
   */
  onCompact: (chatId: string) => Promise<void>;

  /**
   * Check if the agent is currently processing a message.
   * Compaction is never triggered during active processing.
   *
   * @param chatId - The chat identifier to check
   * @returns true if the agent is currently processing
   */
  isProcessing: (chatId: string) => boolean;
}

/**
 * Resolved configuration with defaults applied.
 */
interface ResolvedConfig {
  enabled: boolean;
  thresholdTokens: number;
  checkIntervalMs: number;
}

/** Default configuration values */
const DEFAULTS = {
  enabled: false,
  thresholdTokens: 150000,
  checkIntervalSeconds: 60,
} as const;

/**
 * Per-chatId token tracking state.
 */
interface TokenState {
  /** Cumulative input tokens since last compaction */
  cumulativeTokens: number;
  /** Whether compaction is currently in progress for this chatId */
  compacting: boolean;
}

/**
 * ContextCompactManager - Framework-level auto compacting for active agents.
 *
 * Features:
 * - Per-chatId token tracking
 * - Configurable threshold (default: 150000 tokens)
 * - Periodic check with configurable interval
 * - Never compacts during active processing
 * - Safe async shutdown (waits for in-progress compaction)
 * - Opt-in via config (enabled: false by default)
 *
 * @example
 * ```typescript
 * const manager = new ContextCompactManager({
 *   logger,
 *   thresholdTokens: 120000,
 *   checkIntervalSeconds: 30,
 * }, {
 *   onCompact: async (chatId) => {
 *     await pilot.resetWithContext(chatId, await summarize(chatId));
 *   },
 *   isProcessing: (chatId) => pilot.isProcessing(chatId),
 * });
 *
 * manager.start();
 *
 * // After each SDK result message:
 * manager.recordTokens(chatId, metadata.inputTokens);
 *
 * // After compaction completes, reset token count:
 * manager.resetTokens(chatId);
 *
 * // On shutdown:
 * await manager.stop();
 * ```
 */
export class ContextCompactManager {
  private readonly logger: Logger;
  private readonly config: ResolvedConfig;
  private readonly callbacks: ContextCompactCallbacks;

  /** Per-chatId token state */
  private readonly tokenStates = new Map<string, TokenState>();

  /** Interval timer handle */
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /** Promise for the currently running check cycle (if any) */
  private checkPromise: Promise<void> | null = null;

  constructor(config: ContextCompactConfig, callbacks: ContextCompactCallbacks, logger: Logger) {
    this.logger = logger;
    this.callbacks = callbacks;

    this.config = {
      enabled: config.enabled ?? DEFAULTS.enabled,
      thresholdTokens: config.thresholdTokens ?? DEFAULTS.thresholdTokens,
      checkIntervalMs: (config.checkIntervalSeconds ?? DEFAULTS.checkIntervalSeconds) * 1000,
    };
  }

  /**
   * Start the periodic token check.
   * Does nothing if the manager is disabled.
   */
  start(): void {
    if (!this.config.enabled) {
      this.logger.debug('Context compact manager is disabled, not starting');
      return;
    }

    if (this.intervalHandle !== null) {
      this.logger.warn('Context compact manager is already running');
      return;
    }

    this.logger.info(
      { thresholdTokens: this.config.thresholdTokens, checkIntervalMs: this.config.checkIntervalMs },
      'Starting context compact manager'
    );

    this.intervalHandle = setInterval(() => {
      this.runCheck().catch((err: Error) => {
        this.logger.error({ err }, 'Error in context compact check cycle');
      });
    }, this.config.checkIntervalMs);

    // Allow the process to exit even if the interval is still running
    if (this.intervalHandle.unref) {
      this.intervalHandle.unref();
    }
  }

  /**
   * Stop the periodic token check and wait for any in-progress check to complete.
   */
  async stop(): Promise<void> {
    if (this.intervalHandle === null) {
      return;
    }

    clearInterval(this.intervalHandle);
    this.intervalHandle = null;

    this.logger.info('Context compact manager stopped');

    // Wait for any in-progress check to complete
    if (this.checkPromise) {
      await this.checkPromise;
      this.checkPromise = null;
    }
  }

  /**
   * Record cumulative input tokens for a chatId.
   *
   * Called by the consumer (e.g., Pilot) after processing each SDK result message
   * where metadata contains inputTokens.
   *
   * @param chatId - The chat identifier
   * @param tokens - Number of input tokens from the SDK result message
   */
  recordTokens(chatId: string, tokens: number): void {
    if (!this.config.enabled) {
      return;
    }

    if (tokens <= 0) {
      return;
    }

    let state = this.tokenStates.get(chatId);
    if (!state) {
      state = { cumulativeTokens: 0, compacting: false };
      this.tokenStates.set(chatId, state);
    }

    state.cumulativeTokens += tokens;

    this.logger.debug(
      { chatId, addedTokens: tokens, cumulativeTokens: state.cumulativeTokens, threshold: this.config.thresholdTokens },
      'Token usage recorded'
    );
  }

  /**
   * Reset the cumulative token count for a chatId.
   *
   * Should be called after a successful compaction to reset the counter.
   *
   * @param chatId - The chat identifier
   */
  resetTokens(chatId: string): void {
    const state = this.tokenStates.get(chatId);
    if (state) {
      const previous = state.cumulativeTokens;
      state.cumulativeTokens = 0;
      state.compacting = false;
      this.logger.info(
        { chatId, previousTokens: previous },
        'Token count reset after compaction'
      );
    }
  }

  /**
   * Remove token tracking for a chatId.
   *
   * Should be called when a session is destroyed.
   *
   * @param chatId - The chat identifier
   */
  removeChat(chatId: string): void {
    this.tokenStates.delete(chatId);
    this.logger.debug({ chatId }, 'Token tracking removed');
  }

  /**
   * Get the current cumulative token count for a chatId.
   *
   * @param chatId - The chat identifier
   * @returns Cumulative tokens, or 0 if not tracked
   */
  getTokens(chatId: string): number {
    return this.tokenStates.get(chatId)?.cumulativeTokens ?? 0;
  }

  /**
   * Check if the manager is currently running.
   */
  isRunning(): boolean {
    return this.intervalHandle !== null;
  }

  /**
   * Check if compaction is in progress for a chatId.
   *
   * @param chatId - The chat identifier
   * @returns true if compaction is in progress
   */
  isCompacting(chatId: string): boolean {
    return this.tokenStates.get(chatId)?.compacting ?? false;
  }

  /**
   * Run a single check cycle across all tracked chatIds.
   * Triggers compaction for any chatId that exceeds the threshold
   * and is not currently processing or compacting.
   */
  private async runCheck(): Promise<void> {
    // Skip if a previous check is still running
    if (this.checkPromise) {
      this.logger.debug('Previous check cycle still in progress, skipping');
      return;
    }

    this.checkPromise = this.doCheck();
    try {
      await this.checkPromise;
    } finally {
      this.checkPromise = null;
    }
  }

  /**
   * Perform the actual check across all tracked sessions.
   */
  private async doCheck(): Promise<void> {
    const chatIds = Array.from(this.tokenStates.keys());
    if (chatIds.length === 0) {
      return;
    }

    for (const chatId of chatIds) {
      const state = this.tokenStates.get(chatId);
      if (!state) {
        continue;
      }

      // Skip if already below threshold
      if (state.cumulativeTokens < this.config.thresholdTokens) {
        continue;
      }

      // Skip if already compacting
      if (state.compacting) {
        this.logger.debug(
          { chatId, cumulativeTokens: state.cumulativeTokens },
          'Compaction already in progress, skipping'
        );
        continue;
      }

      // Skip if agent is currently processing a message
      if (this.callbacks.isProcessing(chatId)) {
        this.logger.debug(
          { chatId, cumulativeTokens: state.cumulativeTokens },
          'Agent is processing, skipping compaction'
        );
        continue;
      }

      // Trigger compaction
      this.logger.info(
        {
          chatId,
          cumulativeTokens: state.cumulativeTokens,
          threshold: this.config.thresholdTokens,
        },
        'Triggering context compaction'
      );

      state.compacting = true;

      try {
        await this.callbacks.onCompact(chatId);
      } catch (err) {
        this.logger.error(
          { chatId, err },
          'Compaction callback failed'
        );
        // Reset compacting flag so we can retry next cycle
        state.compacting = false;
      }
    }
  }
}
