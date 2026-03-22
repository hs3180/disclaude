/**
 * SessionTimeoutManager - Automatic session timeout management.
 *
 * Manages session lifecycle by detecting idle sessions and cleaning them up.
 * Designed to be shared across primary-node and worker-node via a callbacks interface.
 *
 * Key design decisions (learned from rejected PRs #1409, #1427):
 * - Located in core package for shared use across nodes
 * - Uses Promise-based in-progress tracking instead of boolean flag
 *   (avoids the "check skipped" problem from #1427)
 * - Async stop() waits for in-progress checks to complete
 * - Always checks isProcessing before timing out (lesson from #1427)
 * - Uses warn-level logging when checks are skipped (lesson from #1427)
 *
 * @see Issue #1313
 */

import type pino from 'pino';

/**
 * Configuration for session timeout behavior.
 * Nested under sessionRestore.sessionTimeout in config.
 */
export interface SessionTimeoutConfig {
  /** Enable/disable session timeout management (default: false) */
  enabled?: boolean;
  /** Idle minutes before session is eligible for timeout (default: 30) */
  idleMinutes?: number;
  /** Maximum concurrent sessions allowed (default: 100) */
  maxSessions?: number;
  /** Check interval in minutes (default: 5) */
  checkIntervalMinutes?: number;
}

/**
 * Resolved session timeout configuration with defaults applied.
 */
export interface ResolvedSessionTimeoutConfig {
  enabled: boolean;
  idleMinutes: number;
  maxSessions: number;
  checkIntervalMinutes: number;
}

/**
 * Callbacks interface for session timeout operations.
 *
 * This decouples the timeout manager from specific implementations,
 * allowing both primary-node and worker-node to use the same core logic.
 */
export interface SessionTimeoutCallbacks {
  /**
   * Get the timestamp of the last activity for a session.
   * Returns undefined if the session doesn't exist.
   */
  getLastActivity: (chatId: string) => number | undefined;

  /**
   * Check if a session is currently processing messages.
   * Sessions that are processing should NEVER be timed out.
   */
  isProcessing: (chatId: string) => boolean;

  /**
   * Get all active chat IDs.
   */
  getActiveChatIds: () => string[];

  /**
   * Get the total number of active sessions.
   */
  getSessionCount: () => number;

  /**
   * Close a session due to timeout.
   * Called by the manager when a session is eligible for cleanup.
   *
   * @param chatId - The chat ID to close
   * @param reason - Why the session was closed
   * @returns true if the session was successfully closed
   */
  closeSession: (chatId: string, reason: string) => boolean;
}

/**
 * SessionTimeoutManager - Detects and cleans up idle sessions.
 *
 * Usage:
 * ```typescript
 * const manager = new SessionTimeoutManager({
 *   logger,
 *   config: { enabled: true, idleMinutes: 30 },
 *   callbacks: {
 *     getLastActivity: (chatId) => sessionManager.getStats(chatId)?.lastActivity,
 *     isProcessing: (chatId) => sessionManager.get(chatId)?.started ?? false,
 *     getActiveChatIds: () => sessionManager.getActiveChatIds(),
 *     getSessionCount: () => sessionManager.size(),
 *     closeSession: (chatId) => sessionManager.delete(chatId),
 *   },
 * });
 *
 * manager.start();
 * // ...
 * await manager.stop();
 * ```
 */
export class SessionTimeoutManager {
  private readonly logger: pino.Logger;
  private readonly config: ResolvedSessionTimeoutConfig;
  private readonly callbacks: SessionTimeoutCallbacks;

  /** Timer handle for periodic checks */
  private checkTimer?: ReturnType<typeof setInterval>;

  /**
   * Promise tracking the current in-progress check.
   * Instead of a boolean flag, this ensures:
   * - We know when a check is running (Promise is defined)
   * - We can await completion in stop()
   * - No checks are silently skipped
   */
  private checkPromise?: Promise<void>;

  /** Whether the manager has been stopped */
  private stopped = false;

  constructor(options: {
    logger: pino.Logger;
    config: SessionTimeoutConfig;
    callbacks: SessionTimeoutCallbacks;
  }) {
    this.logger = options.logger;
    this.config = this.resolveConfig(options.config);
    this.callbacks = options.callbacks;

    if (this.config.enabled) {
      this.logger.info(
        {
          idleMinutes: this.config.idleMinutes,
          maxSessions: this.config.maxSessions,
          checkIntervalMinutes: this.config.checkIntervalMinutes,
        },
        'SessionTimeoutManager initialized'
      );
    }
  }

  /**
   * Resolve configuration with defaults.
   */
  private resolveConfig(config: SessionTimeoutConfig): ResolvedSessionTimeoutConfig {
    return {
      enabled: config.enabled ?? false,
      idleMinutes: config.idleMinutes ?? 30,
      maxSessions: config.maxSessions ?? 100,
      checkIntervalMinutes: config.checkIntervalMinutes ?? 5,
    };
  }

  /**
   * Check if the timeout manager is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Start the periodic timeout check.
   * No-op if already started or disabled.
   */
  start(): void {
    if (!this.config.enabled) {
      this.logger.debug('SessionTimeoutManager is disabled, not starting');
      return;
    }

    if (this.checkTimer) {
      this.logger.debug('SessionTimeoutManager already started');
      return;
    }

    const intervalMs = this.config.checkIntervalMinutes * 60 * 1000;

    // Run an immediate check, then set up interval
    this.runCheck();

    this.checkTimer = setInterval(() => {
      this.runCheck();
    }, intervalMs);

    // Allow the process to exit even if the timer is active
    if (this.checkTimer.unref) {
      this.checkTimer.unref();
    }

    this.logger.info(
      { intervalMinutes: this.config.checkIntervalMinutes },
      'SessionTimeoutManager started'
    );
  }

  /**
   * Run a single timeout check.
   *
   * If a check is already in progress, logs a warning (warn level per #1427 feedback)
   * but does NOT skip the next scheduled check - the setInterval will simply
   * trigger another runCheck() when the interval elapses.
   *
   * This avoids the "check skipped" problem from #1427 where checks during
   * long-running operations were silently dropped.
   */
  private runCheck(): void {
    if (this.stopped) {
      return;
    }

    if (this.checkPromise) {
      this.logger.warn(
        'Timeout check skipped - previous check still in progress. Consider increasing checkIntervalMinutes'
      );
      return;
    }

    this.checkPromise = this.executeCheck().finally(() => {
      this.checkPromise = undefined;
    });
  }

  /**
   * Execute the actual timeout check.
   *
   * Checks two conditions:
   * 1. Idle timeout: Sessions idle longer than configured threshold
   * 2. Max sessions: If over limit, evict oldest idle (non-processing) sessions
   */
  private async executeCheck(): Promise<void> {
    try {
      const chatIds = this.callbacks.getActiveChatIds();
      const now = Date.now();
      const idleThresholdMs = this.config.idleMinutes * 60 * 1000;

      let timedOut = 0;
      let evicted = 0;

      // Phase 1: Close idle sessions
      for (const chatId of chatIds) {
        // CRITICAL: Never close a session that is currently processing (lesson from #1427)
        if (this.callbacks.isProcessing(chatId)) {
          this.logger.debug({ chatId }, 'Session is processing, skipping timeout check');
          continue;
        }

        const lastActivity = this.callbacks.getLastActivity(chatId);
        if (lastActivity === undefined) {
          continue;
        }

        const idleTime = now - lastActivity;
        if (idleTime > idleThresholdMs) {
          const idleMinutes = Math.round(idleTime / 60000);
          const closed = this.callbacks.closeSession(chatId, `idle-timeout (${idleMinutes}min)`);
          if (closed) {
            timedOut++;
            this.logger.info(
              { chatId, idleMinutes, threshold: this.config.idleMinutes },
              'Session timed out due to inactivity'
            );
          }
        }
      }

      // Phase 2: Enforce max sessions limit (evict oldest idle, non-processing)
      const currentCount = this.callbacks.getSessionCount();
      if (currentCount > this.config.maxSessions) {
        const excess = currentCount - this.config.maxSessions;
        const evictedChatIds = this.findOldestIdleSessions(excess);

        for (const chatId of evictedChatIds) {
          if (this.callbacks.isProcessing(chatId)) {
            continue;
          }
          const closed = this.callbacks.closeSession(chatId, 'max-sessions-eviction');
          if (closed) {
            evicted++;
            this.logger.info(
              { chatId, sessionCount: currentCount, maxSessions: this.config.maxSessions },
              'Session evicted to enforce max sessions limit'
            );
          }
        }
      }

      if (timedOut > 0 || evicted > 0) {
        this.logger.info(
          { timedOut, evicted, remaining: this.callbacks.getSessionCount() },
          'Timeout check completed with cleanup actions'
        );
      }
    } catch (error) {
      this.logger.error({ error }, 'Error during session timeout check');
    }
  }

  /**
   * Find the oldest idle (non-processing) sessions for eviction.
   *
   * @param count - Number of sessions to find
   * @returns Chat IDs of the oldest idle sessions, sorted by age (oldest first)
   */
  private findOldestIdleSessions(count: number): string[] {
    const chatIds = this.callbacks.getActiveChatIds();
    const sessions: Array<{ chatId: string; lastActivity: number }> = [];

    for (const chatId of chatIds) {
      if (this.callbacks.isProcessing(chatId)) {
        continue;
      }
      const lastActivity = this.callbacks.getLastActivity(chatId);
      if (lastActivity !== undefined) {
        sessions.push({ chatId, lastActivity });
      }
    }

    // Sort by lastActivity ascending (oldest first)
    sessions.sort((a, b) => a.lastActivity - b.lastActivity);

    return sessions.slice(0, count).map(s => s.chatId);
  }

  /**
   * Stop the timeout manager.
   *
   * Unlike the rejected #1427 implementation, this method is async and
   * waits for any in-progress check to complete before returning.
   * This prevents the race condition where stop() is called while
   * a check is still accessing callbacks.
   *
   * @returns Promise that resolves when the manager is fully stopped
   */
  async stop(): Promise<void> {
    this.stopped = true;

    // Clear the interval timer first
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }

    // Wait for any in-progress check to complete
    if (this.checkPromise) {
      this.logger.debug('Waiting for in-progress timeout check to complete');
      await this.checkPromise;
    }

    this.logger.info('SessionTimeoutManager stopped');
  }

  /**
   * Run a single manual check (useful for testing).
   */
  async checkNow(): Promise<void> {
    if (this.stopped) {
      return;
    }
    await this.executeCheck();
  }
}
