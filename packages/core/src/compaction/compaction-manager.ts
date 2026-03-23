/**
 * CompactionManager - Framework-level context compaction for active agents.
 *
 * Provides consistent context management across different SDK providers,
 * independent of SDK-specific compaction behavior.
 *
 * ## Architecture
 *
 * ```
 * Pilot.processIterator()
 *     ↓ receives SDK message with token metadata
 * CompactionManager.trackUsage(chatId, inputTokens, outputTokens)
 *     ↓ checks usage against threshold
 * CompactionManager.shouldCompact(chatId)
 *     ↓ if threshold exceeded
 * Pilot triggers compaction (session restart with summary)
 * CompactionManager.recordCompaction(chatId)
 * ```
 *
 * ## SDK Compaction Detection
 *
 * When the SDK emits a system message with `status: 'compacting'`, the Pilot
 * notifies the CompactionManager via `recordSdkCompaction()`. This allows the
 * framework to track SDK-initiated compaction even when using 'sdk' strategy.
 *
 * @module compaction/compaction-manager
 * @see Issue #1336
 */

import type { Logger } from '../utils/logger.js';
import {
  type ResolvedCompactionConfig,
  type CompactionEvent,
  type CompactionEventCallback,
  type CompactionEventType,
  type ContextUsage,
  DEFAULT_COMPACTION_CONFIG,
} from './types.js';

// Re-export types for convenience
export type {
  CompactionConfig,
  ResolvedCompactionConfig,
  ContextUsage,
  CompactionEvent,
  CompactionEventType,
  CompactionEventCallback,
  CompactionStrategy,
} from './types.js';
export { DEFAULT_COMPACTION_CONFIG } from './types.js';

/**
 * Internal session state tracked by CompactionManager.
 */
interface SessionState {
  /** Latest input token count (total context size) */
  inputTokens: number;
  /** Latest output token count */
  outputTokens: number;
  /** Peak input tokens seen (used to detect post-compaction drops) */
  peakInputTokens: number;
  /** Number of conversation turns */
  turnCount: number;
  /** Number of compaction events */
  compactionCount: number;
  /** Timestamp of last compaction */
  lastCompactionAt: number | null;
  /** Timestamp of last token update */
  lastUpdatedAt: number;
  /** Whether compaction was triggered in current turn (debounce) */
  compactionPending: boolean;
}

/**
 * CompactionManager - Monitors context usage and manages compaction lifecycle.
 *
 * Per-chatId tracking:
 * - Tracks token usage from SDK message metadata
 * - Calculates context usage ratio against maxContextTokens
 * - Determines when compaction should be triggered
 * - Records both framework-initiated and SDK-initiated compaction events
 *
 * @example
 * ```typescript
 * const manager = new CompactionManager({
 *   config: { strategy: 'auto', threshold: 0.85, maxContextTokens: 200000 },
 *   logger,
 * });
 *
 * // Track usage from SDK message metadata
 * manager.trackUsage(chatId, inputTokens, outputTokens);
 *
 * // Check if compaction is needed
 * if (manager.shouldCompact(chatId)) {
 *   // Trigger compaction (close session, summarize, restart)
 *   await performCompaction(chatId);
 *   manager.recordCompaction(chatId);
 * }
 *
 * // Detect SDK-initiated compaction
 * manager.recordSdkCompaction(chatId);
 *
 * // Listen for events
 * manager.on('threshold_exceeded', (event) => {
 *   logger.warn({ chatId: event.chatId, usageRatio: event.usage.usageRatio },
 *     'Context threshold exceeded');
 * });
 * ```
 */
export class CompactionManager {
  private readonly logger: Logger;
  private readonly config: ResolvedCompactionConfig;

  /** Per-chatId session states */
  private readonly sessions = new Map<string, SessionState>();

  /** Event listeners */
  private readonly listeners = new Map<CompactionEventType, Set<CompactionEventCallback>>();

  constructor(configOrLogger: ResolvedCompactionConfig | Logger, logger?: Logger) {
    // Support both (config, logger) and (logger) constructor signatures
    if ('info' in configOrLogger && 'warn' in configOrLogger && 'debug' in configOrLogger) {
      // Passed logger directly
      this.logger = configOrLogger as Logger;
      this.config = DEFAULT_COMPACTION_CONFIG;
    } else {
      this.config = configOrLogger as ResolvedCompactionConfig;
      this.logger = logger!;
    }
  }

  // ==========================================================================
  // Usage Tracking
  // ==========================================================================

  /**
   * Track context usage from SDK message metadata.
   *
   * Called by Pilot.processIterator() when a 'result' message is received
   * with token usage metadata (inputTokens, outputTokens).
   *
   * @param chatId - Session identifier
   * @param inputTokens - Input token count (total context size)
   * @param outputTokens - Output token count for this turn
   * @returns Updated context usage
   */
  trackUsage(chatId: string, inputTokens: number, outputTokens: number): ContextUsage {
    const now = Date.now();
    let state = this.sessions.get(chatId);

    if (!state) {
      state = {
        inputTokens: 0,
        outputTokens: 0,
        peakInputTokens: 0,
        turnCount: 0,
        compactionCount: 0,
        lastCompactionAt: null,
        lastUpdatedAt: now,
        compactionPending: false,
      };
      this.sessions.set(chatId, state);
    }

    // Update state
    state.inputTokens = inputTokens;
    state.outputTokens = outputTokens;
    state.peakInputTokens = Math.max(state.peakInputTokens, inputTokens);
    state.turnCount++;
    state.lastUpdatedAt = now;

    const usage = this.getUsage(chatId)!;

    // Emit usage_updated event
    this.emitEvent({
      type: 'usage_updated',
      chatId,
      usage,
    });

    // Check threshold for 'auto' strategy
    if (this.config.strategy === 'auto' && !state.compactionPending) {
      if (usage.usageRatio >= this.config.threshold) {
        this.emitEvent({
          type: 'threshold_exceeded',
          chatId,
          usage,
          data: {
            threshold: this.config.threshold,
            inputTokens,
            maxContextTokens: this.config.maxContextTokens,
          },
        });

        this.logger.warn(
          {
            chatId,
            usageRatio: usage.usageRatio.toFixed(3),
            threshold: this.config.threshold,
            inputTokens,
            turnCount: state.turnCount,
          },
          'Context usage threshold exceeded'
        );
      }
    }

    return usage;
  }

  // ==========================================================================
  // Compaction Decisions
  // ==========================================================================

  /**
   * Check if compaction should be triggered for a session.
   *
   * For 'auto' strategy: returns true when usage ratio >= threshold.
   * For 'sdk' strategy: always returns false (SDK handles compaction).
   * For 'disabled' strategy: always returns false.
   *
   * @param chatId - Session identifier
   * @returns Whether compaction should be triggered
   */
  shouldCompact(chatId: string): boolean {
    if (this.config.strategy !== 'auto') {
      return false;
    }

    const state = this.sessions.get(chatId);
    if (!state || state.compactionPending) {
      return false;
    }

    const usageRatio = state.inputTokens / this.config.maxContextTokens;
    return usageRatio >= this.config.threshold;
  }

  /**
   * Record a framework-initiated compaction event.
   *
   * Called after compaction has been performed (session reset with summary).
   *
   * @param chatId - Session identifier
   */
  recordCompaction(chatId: string): void {
    const state = this.sessions.get(chatId);
    if (!state) {
      return;
    }

    const now = Date.now();
    state.compactionCount++;
    state.lastCompactionAt = now;
    state.compactionPending = false;

    const usage = this.getUsage(chatId)!;

    this.emitEvent({
      type: 'compaction_completed',
      chatId,
      usage,
      data: {
        compactionCount: state.compactionCount,
        previousPeakTokens: state.peakInputTokens,
      },
    });

    this.logger.info(
      {
        chatId,
        compactionCount: state.compactionCount,
        previousInputTokens: state.inputTokens,
      },
      'Framework compaction recorded'
    );
  }

  /**
   * Record an SDK-initiated compaction event.
   *
   * Called when the SDK emits a system message with `status: 'compacting'`.
   * This allows the framework to track SDK-initiated compaction regardless
   * of the configured strategy.
   *
   * @param chatId - Session identifier
   */
  recordSdkCompaction(chatId: string): void {
    const state = this.sessions.get(chatId);
    if (!state) {
      return;
    }

    const now = Date.now();
    state.compactionCount++;
    state.lastCompactionAt = now;

    const usage = this.getUsage(chatId)!;

    this.emitEvent({
      type: 'sdk_compaction_detected',
      chatId,
      usage,
      data: {
        compactionCount: state.compactionCount,
        inputTokensAtCompaction: state.inputTokens,
      },
    });

    this.logger.info(
      {
        chatId,
        compactionCount: state.compactionCount,
        inputTokens: state.inputTokens,
        usageRatio: usage.usageRatio.toFixed(3),
      },
      'SDK compaction detected'
    );
  }

  /**
   * Mark compaction as pending (debounce).
   *
   * Prevents repeated compaction triggers while a compaction is in progress.
   *
   * @param chatId - Session identifier
   */
  markCompactionPending(chatId: string): void {
    const state = this.sessions.get(chatId);
    if (state) {
      state.compactionPending = true;
      this.emitEvent({
        type: 'compaction_triggered',
        chatId,
        usage: this.getUsage(chatId)!,
      });
    }
  }

  // ==========================================================================
  // State Queries
  // ==========================================================================

  /**
   * Get current context usage for a session.
   *
   * @param chatId - Session identifier
   * @returns Context usage or null if session not tracked
   */
  getUsage(chatId: string): ContextUsage | null {
    const state = this.sessions.get(chatId);
    if (!state) {
      return null;
    }

    return {
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      totalTokens: state.inputTokens + state.outputTokens,
      usageRatio: state.inputTokens / this.config.maxContextTokens,
      turnCount: state.turnCount,
      compactionCount: state.compactionCount,
      lastCompactionAt: state.lastCompactionAt,
      lastUpdatedAt: state.lastUpdatedAt,
    };
  }

  /**
   * Check if a session is being tracked.
   *
   * @param chatId - Session identifier
   * @returns Whether the session is tracked
   */
  hasSession(chatId: string): boolean {
    return this.sessions.has(chatId);
  }

  /**
   * Get the resolved compaction configuration.
   *
   * @returns Compaction configuration
   */
  getConfig(): ResolvedCompactionConfig {
    return this.config;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Reset tracking for a session.
   *
   * Used when a session is explicitly reset (e.g., /reset command).
   * Clears all tracking state but does NOT clear compaction count
   * (for historical tracking purposes).
   *
   * @param chatId - Session identifier
   */
  resetSession(chatId: string): void {
    const existed = this.sessions.delete(chatId);
    if (existed) {
      this.logger.debug({ chatId }, 'Compaction session reset');
    }
  }

  /**
   * Clear all session states.
   */
  clearAll(): void {
    this.sessions.clear();
    this.logger.debug('All compaction sessions cleared');
  }

  // ==========================================================================
  // Event System
  // ==========================================================================

  /**
   * Register an event listener.
   *
   * @param eventType - Type of event to listen for, or '*' for all events
   * @param callback - Callback function
   */
  on(eventType: CompactionEventType | '*', callback: CompactionEventCallback): void {
    if (!this.listeners.has(eventType as CompactionEventType)) {
      this.listeners.set(eventType as CompactionEventType, new Set());
    }
    this.listeners.get(eventType as CompactionEventType)!.add(callback);
  }

  /**
   * Remove an event listener.
   *
   * @param eventType - Type of event
   * @param callback - Callback function to remove
   */
  off(eventType: CompactionEventType | '*', callback: CompactionEventCallback): void {
    this.listeners.get(eventType as CompactionEventType)?.delete(callback);
  }

  /**
   * Emit an event to all matching listeners.
   */
  private emitEvent(event: CompactionEvent): void {
    // Notify specific event listeners
    const specificListeners = this.listeners.get(event.type);
    if (specificListeners) {
      for (const callback of specificListeners) {
        try {
          callback(event);
        } catch (err) {
          this.logger.error({ err, eventType: event.type }, 'Compaction event listener error');
        }
      }
    }

    // Notify wildcard listeners
    const wildcardListeners = this.listeners.get('*' as CompactionEventType);
    if (wildcardListeners) {
      for (const callback of wildcardListeners) {
        try {
          callback(event);
        } catch (err) {
          this.logger.error({ err, eventType: event.type }, 'Compaction wildcard listener error');
        }
      }
    }
  }
}
