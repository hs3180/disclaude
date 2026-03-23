/**
 * CompactionManager - Framework-level context compaction management (Issue #1336).
 *
 * Monitors agent sessions for context usage and triggers proactive compaction
 * before the SDK's built-in compaction kicks in. This provides:
 *
 * 1. **Unified compaction threshold** across all SDK providers
 * 2. **Configurable compaction strategy** (auto, reset, disabled)
 * 3. **Token usage tracking** per session
 * 4. **Pre/post compaction hooks** for custom behavior
 *
 * Key design decisions:
 * - Follows the same callback-based pattern as SessionTimeoutManager (Issue #1313)
 * - Located in packages/core/src/conversation/ for framework-level access
 * - Does NOT directly reference Pilot or any specific agent implementation
 * - Uses a periodic check cycle with concurrency guard
 *
 * Architecture:
 * ```
 * CompactionManager
 *     ├── Token usage tracking (per chatId)
 *     ├── Periodic threshold check
 *     └── Callback-based compaction trigger
 *             └── Consumer (e.g., WorkerNode) handles actual session reset
 * ```
 */

import type pino from 'pino';

/** Compaction strategy options */
export type CompactionStrategy = 'auto' | 'reset' | 'disabled';

/**
 * Compaction configuration.
 *
 * Controls how and when framework-level compaction is triggered.
 */
export interface CompactionConfig {
  /** Enable compaction management (default: false) */
  enabled?: boolean;
  /**
   * Token usage threshold (0.0 - 1.0) to trigger compaction.
   * Represents the fraction of maxContextTokens at which compaction triggers.
   * Default: 0.80 (trigger when 80% of context is used)
   */
  threshold?: number;
  /**
   * Compaction strategy:
   * - 'auto': Monitor and track, let SDK handle actual compaction (default)
   * - 'reset': Proactively reset session with context preservation
   * - 'disabled': Disable framework-level compaction entirely
   */
  strategy?: CompactionStrategy;
  /**
   * Maximum context tokens for the model.
   * Used to calculate the absolute token threshold.
   * Default: 180000 (conservative for Claude 200k context)
   */
  maxContextTokens?: number;
  /**
   * Minimum cumulative input tokens before compaction can trigger.
   * Prevents premature compaction in early conversation turns.
   * Default: 50000
   */
  minTokens?: number;
  /**
   * Check interval in minutes between compaction checks.
   * Default: 2
   */
  checkIntervalMinutes?: number;
}

/** Resolved config with defaults applied. */
export type ResolvedCompactionConfig = Required<CompactionConfig> & { enabled: true };

/**
 * Token usage statistics for a session.
 */
export interface TokenUsageStats {
  /** Cumulative input tokens across all turns in the session */
  totalInputTokens: number;
  /** Cumulative output tokens across all turns in the session */
  totalOutputTokens: number;
  /** Timestamp of the last token usage update (ms since epoch) */
  lastUpdated: number;
  /** Number of conversation turns processed */
  turnCount: number;
}

/**
 * Callbacks for compaction events.
 * The consumer (e.g., WorkerNode) provides these to handle actual compaction.
 */
export interface CompactionCallbacks {
  /**
   * Get all active session chat IDs.
   * @returns Array of chat IDs with active sessions
   */
  getActiveSessions: () => string[];

  /**
   * Get the token usage statistics for a session.
   * @param chatId - Session chat ID
   * @returns Token usage stats, or undefined if unknown
   */
  getTokenUsage: (chatId: string) => TokenUsageStats | undefined;

  /**
   * Check if a session is currently processing a task.
   * Sessions that are actively processing MUST NOT be compacted.
   * @param chatId - Session chat ID
   * @returns true if the session is actively processing
   */
  isProcessing: (chatId: string) => boolean;

  /**
   * Compact a session due to context usage exceeding threshold.
   * Called by the manager when a session should be compacted.
   *
   * For 'reset' strategy: The consumer should reset the session
   * with context preservation (keepContext=true).
   *
   * For 'auto' strategy: The consumer may choose to take action
   * or let the SDK handle compaction naturally.
   *
   * @param chatId - Session chat ID to compact
   * @param reason - Why compaction is triggered
   * @param usage - Current token usage stats
   */
  compactSession: (chatId: string, reason: string, usage: TokenUsageStats) => void;
}

/**
 * Result of a compaction check cycle.
 */
export interface CompactionCheckResult {
  /** Sessions compacted due to threshold exceeded */
  compacted: string[];
  /** Sessions skipped because they were actively processing */
  processingSkipped: string[];
  /** Sessions skipped because token usage was below minimum */
  belowMinimum: string[];
}

/** Logger context type for structured logging. */
interface LogContext {
  [key: string]: unknown;
}

/**
 * CompactionManager - Monitors and triggers context compaction for active agent sessions.
 *
 * The manager tracks cumulative token usage per session and triggers compaction
 * when usage exceeds a configurable threshold. This provides framework-level
 * control over context management, independent of SDK-specific compaction behavior.
 *
 * Two-phase check cycle:
 * 1. **Token check**: Compare cumulative input tokens against threshold
 * 2. **Compaction trigger**: Call compactSession callback for qualifying sessions
 *
 * Concurrency model:
 * - `runCheck()` uses a Promise-based guard (`this.runningPromise`) to prevent concurrent checks
 * - `checkNow()` delegates to `runCheck()`, never bypasses the guard
 * - `stop()` awaits the running check if one is in progress
 */
export class CompactionManager {
  private readonly logger: pino.Logger;
  private readonly config: ResolvedCompactionConfig;
  private readonly callbacks: CompactionCallbacks;
  private timer?: ReturnType<typeof setInterval>;
  private runningPromise: Promise<CompactionCheckResult> | null = null;
  private disposed = false;

  constructor(
    config: CompactionConfig & { enabled: true },
    callbacks: CompactionCallbacks,
    logger: pino.Logger,
  ) {
    this.config = {
      enabled: true,
      threshold: config.threshold ?? 0.80,
      strategy: config.strategy ?? 'auto',
      maxContextTokens: config.maxContextTokens ?? 180000,
      minTokens: config.minTokens ?? 50000,
      checkIntervalMinutes: config.checkIntervalMinutes ?? 2,
    };
    this.callbacks = callbacks;
    this.logger = logger.child({ module: 'CompactionManager' });
  }

  /**
   * Get the resolved configuration (for testing/diagnostics).
   */
  getConfig(): Readonly<ResolvedCompactionConfig> {
    return this.config;
  }

  /**
   * Start the periodic compaction check.
   */
  start(): void {
    if (this.disposed) {
      this.logger.warn('Cannot start: manager is disposed');
      return;
    }
    if (this.timer) {
      this.logger.warn('Already started');
      return;
    }

    // If strategy is 'disabled', log and return
    if (this.config.strategy === 'disabled') {
      this.logger.info('Compaction strategy is "disabled", manager started but will not trigger compaction');
      return;
    }

    const intervalMs = this.config.checkIntervalMinutes * 60 * 1000;
    this.timer = setInterval(() => {
      this.runCheck().catch((err) => {
        this.logger.error({ err }, 'Periodic check failed');
      });
    }, intervalMs);

    // Allow Node.js to exit even if timer is active
    if (this.timer.unref) {
      this.timer.unref();
    }

    this.logger.info(
      {
        threshold: this.config.threshold,
        strategy: this.config.strategy,
        maxContextTokens: this.config.maxContextTokens,
        minTokens: this.config.minTokens,
        checkIntervalMinutes: this.config.checkIntervalMinutes,
      },
      'Compaction manager started',
    );
  }

  /**
   * Run a single compaction check, with concurrency guard.
   * If a check is already in progress, this returns immediately.
   *
   * @returns Promise that resolves when the check completes (or immediately if one is running)
   */
  runCheck(): Promise<CompactionCheckResult | null> {
    // Guard: if a check is already running, return existing promise
    if (this.runningPromise) {
      this.logger.warn('Check already in progress, skipping');
      return Promise.resolve(null);
    }

    this.runningPromise = this.executeCheck().finally(() => {
      this.runningPromise = null;
    });

    return this.runningPromise;
  }

  /**
   * Trigger an immediate check (e.g., for testing or manual invocation).
   * Delegates to runCheck() with proper concurrency guard.
   *
   * @returns Promise that resolves when the check completes
   */
  checkNow(): Promise<CompactionCheckResult | null> {
    return this.runCheck();
  }

  /**
   * Stop the compaction manager.
   * Awaits any in-progress check before stopping.
   */
  async stop(): Promise<void> {
    this.disposed = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    // Await any in-progress check to avoid callbacks firing after stop
    if (this.runningPromise) {
      this.logger.info('Awaiting in-progress check before stop');
      await this.runningPromise;
    }

    this.logger.info('Compaction manager stopped');
  }

  /**
   * Execute the compaction check cycle.
   *
   * For each active session:
   * 1. Check if it's actively processing (skip if so)
   * 2. Get token usage stats
   * 3. Check if cumulative input tokens exceed minimum threshold
   * 4. Check if token usage exceeds compaction threshold
   * 5. Trigger compaction callback if needed
   */
  private executeCheck(): Promise<CompactionCheckResult> {
    const result: CompactionCheckResult = {
      compacted: [],
      processingSkipped: [],
      belowMinimum: [],
    };

    // If strategy is 'disabled', skip check
    if (this.config.strategy === 'disabled') {
      return Promise.resolve(result);
    }

    const allSessions = this.callbacks.getActiveSessions();

    if (allSessions.length === 0) {
      return Promise.resolve(result);
    }

    // Calculate absolute token threshold
    const absoluteThreshold = Math.floor(this.config.threshold * this.config.maxContextTokens);

    for (const chatId of allSessions) {
      // Never compact sessions that are actively processing
      if (this.callbacks.isProcessing(chatId)) {
        result.processingSkipped.push(chatId);
        continue;
      }

      const usage = this.callbacks.getTokenUsage(chatId);
      if (!usage) {
        // No usage data — skip
        this.logger.debug({ chatId }, 'Skipping session with no token usage data');
        continue;
      }

      // Check minimum token threshold
      if (usage.totalInputTokens < this.config.minTokens) {
        result.belowMinimum.push(chatId);
        this.logger.debug(
          {
            chatId,
            inputTokens: usage.totalInputTokens,
            minTokens: this.config.minTokens,
          },
          'Session below minimum token threshold, skipping compaction',
        );
        continue;
      }

      // Check compaction threshold
      if (usage.totalInputTokens >= absoluteThreshold) {
        const reason = `token usage ${usage.totalInputTokens} >= threshold ${absoluteThreshold} ` +
          `(${(this.config.threshold * 100).toFixed(0)}% of ${this.config.maxContextTokens})`;
        this.compactWithLog(chatId, reason, usage);
        result.compacted.push(chatId);
      }
    }

    if (result.compacted.length > 0) {
      this.logger.info(
        {
          compacted: result.compacted.length,
          processingSkipped: result.processingSkipped.length,
          belowMinimum: result.belowMinimum.length,
        },
        'Compaction check completed with compactions',
      );
    }

    return Promise.resolve(result);
  }

  /**
   * Compact a session with structured logging.
   */
  private compactWithLog(chatId: string, reason: string, usage: TokenUsageStats): void {
    const ctx: LogContext = {
      chatId,
      reason,
      strategy: this.config.strategy,
      totalInputTokens: usage.totalInputTokens,
      totalOutputTokens: usage.totalOutputTokens,
      turnCount: usage.turnCount,
    };
    this.logger.info(ctx, 'Triggering compaction for session');
    try {
      this.callbacks.compactSession(chatId, reason, usage);
    } catch (err) {
      this.logger.error({ err, ...ctx }, 'Failed to compact session');
    }
  }
}
