/**
 * SessionTimeoutManager - Automatic session timeout management (Issue #1313).
 *
 * Monitors sessions for inactivity and enforces maximum session limits.
 * Designed as a core utility with callback-based integration —
 * it does NOT directly reference Pilot, PrimaryAgentPool, or any specific implementation.
 *
 * Key design decisions (learned from rejected PRs #1409, #1427, #1438):
 *
 * | Issue | Previous PR | Fix |
 * |-------|------------|-----|
 * | #1409 | Implemented in primary-node | Located in packages/core/src/conversation/ |
 * | #1427 | Boolean isChecking flag | Promise-based guard with await |
 * | #1427 | checkNow() bypassed guard | checkNow() delegates to runCheck() |
 * | #1427 | isProcessing not checked | Callback always checked before close |
 * | #1438 | Duplicate type definitions | Single definition in config/types.ts |
 * | #1438 | No integration code | Callback-based design for easy wiring |
 */

import type pino from 'pino';
import type { SessionTimeoutConfig } from '../config/types.js';

/** Resolved config with defaults applied. */
export type ResolvedTimeoutConfig = Required<SessionTimeoutConfig> & { enabled: true };

/**
 * Callbacks for session timeout events.
 * The consumer (e.g., PrimaryAgentPool) provides these to handle actual session cleanup.
 */
export interface SessionTimeoutCallbacks {
  /**
   * Get all active session chat IDs.
   * @returns Array of chat IDs with active sessions
   */
  getActiveSessions: () => string[];

  /**
   * Get the last activity timestamp for a session.
   * @param chatId - Session chat ID
   * @returns Timestamp in ms since epoch, or undefined if unknown
   */
  getLastActivity: (chatId: string) => number | undefined;

  /**
   * Check if a session is currently processing a task.
   * Sessions that are actively processing MUST NOT be closed by timeout.
   * @param chatId - Session chat ID
   * @returns true if the session is actively processing
   */
  isProcessing: (chatId: string) => boolean;

  /**
   * Close a session due to timeout.
   * Called by the manager when a session should be cleaned up.
   * @param chatId - Session chat ID to close
   * @param reason - Why the session is being closed
   */
  closeSession: (chatId: string, reason: string) => void;
}

/**
 * Result of a timeout check cycle.
 */
export interface TimeoutCheckResult {
  /** Sessions closed due to inactivity */
  idleClosed: string[];
  /** Sessions closed due to max sessions limit */
  evicted: string[];
  /** Sessions skipped because they were actively processing */
  processingSkipped: string[];
}

/** Logger context type for structured logging. */
interface LogContext {
  [key: string]: unknown;
}

/**
 * SessionTimeoutManager - Monitors and cleans up idle sessions.
 *
 * Two-phase check cycle:
 * 1. **Idle timeout**: Close sessions idle beyond `idleMinutes`
 * 2. **Max sessions**: If still over limit, evict oldest idle sessions
 *
 * Concurrency model:
 * - `runCheck()` uses a Promise-based guard (`this.runningPromise`) to prevent concurrent checks
 * - `checkNow()` delegates to `runCheck()`, never bypasses the guard
 * - `stop()` awaits the running check if one is in progress
 */
export class SessionTimeoutManager {
  private readonly logger: pino.Logger;
  private readonly config: ResolvedTimeoutConfig;
  private readonly callbacks: SessionTimeoutCallbacks;
  private timer?: ReturnType<typeof setInterval>;
  private runningPromise: Promise<TimeoutCheckResult> | null = null;
  private disposed = false;

  constructor(
    config: SessionTimeoutConfig & { enabled: true },
    callbacks: SessionTimeoutCallbacks,
    logger: pino.Logger,
  ) {
    this.config = {
      enabled: true,
      idleMinutes: config.idleMinutes ?? 30,
      maxSessions: config.maxSessions ?? 100,
      checkIntervalMinutes: config.checkIntervalMinutes ?? 5,
    };
    this.callbacks = callbacks;
    this.logger = logger.child({ module: 'SessionTimeoutManager' });
  }

  /**
   * Start the periodic timeout check.
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
      { idleMinutes: this.config.idleMinutes, maxSessions: this.config.maxSessions, checkIntervalMinutes: this.config.checkIntervalMinutes },
      'Session timeout manager started',
    );
  }

  /**
   * Run a single timeout check, with concurrency guard.
   * If a check is already in progress, this returns immediately.
   *
   * @returns Promise that resolves when the check completes (or immediately if one is running)
   */
  async runCheck(): Promise<TimeoutCheckResult | null> {
    // Guard: if a check is already running, return existing promise
    if (this.runningPromise) {
      this.logger.warn('Check already in progress, skipping');
      return null;
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
  async checkNow(): Promise<TimeoutCheckResult | null> {
    return this.runCheck();
  }

  /**
   * Stop the timeout manager.
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

    this.logger.info('Session timeout manager stopped');
  }

  /**
   * Execute the timeout check cycle.
   *
   * Phase 1: Close idle sessions (lastActivity + idleMinutes < now)
   * Phase 2: If still over maxSessions, evict oldest idle (non-processing) sessions
   */
  private executeCheck(): Promise<TimeoutCheckResult> {
    const result: TimeoutCheckResult = {
      idleClosed: [],
      evicted: [],
      processingSkipped: [],
    };

    const now = Date.now();
    const idleThresholdMs = this.config.idleMinutes * 60 * 1000;
    const allSessions = this.callbacks.getActiveSessions();

    if (allSessions.length === 0) {
      return Promise.resolve(result);
    }

    // Phase 1: Close sessions that have been idle beyond the threshold
    const closedInPhase1 = new Set<string>();

    for (const chatId of allSessions) {
      // Never close sessions that are actively processing
      if (this.callbacks.isProcessing(chatId)) {
        result.processingSkipped.push(chatId);
        continue;
      }

      const lastActivity = this.callbacks.getLastActivity(chatId);
      if (lastActivity === undefined) {
        // Unknown last activity — skip to be safe
        this.logger.debug({ chatId }, 'Skipping session with unknown last activity');
        continue;
      }

      const idleMs = now - lastActivity;
      if (idleMs > idleThresholdMs) {
        this.closeWithLog(chatId, `idle for ${Math.round(idleMs / 60000)} minutes (threshold: ${this.config.idleMinutes}m)`);
        result.idleClosed.push(chatId);
        closedInPhase1.add(chatId);
      }
    }

    // Phase 2: If still over maxSessions, evict oldest idle (non-processing) sessions
    // Recount active sessions after Phase 1 closures
    const remainingSessions = allSessions.filter(
      (id) => !closedInPhase1.has(id) && !result.processingSkipped.includes(id),
    );

    if (remainingSessions.length > this.config.maxSessions) {
      // Sort by last activity (oldest first) for eviction
      const candidates = remainingSessions
        .map((chatId) => ({
          chatId,
          lastActivity: this.callbacks.getLastActivity(chatId),
        }))
        .filter((c) => c.lastActivity !== undefined)
        .sort((a, b) => (a.lastActivity ?? 0) - (b.lastActivity ?? 0));

      const toEvict = candidates.length - this.config.maxSessions;
      for (let i = 0; i < toEvict && i < candidates.length; i++) {
        const { chatId } = candidates[i];

        // Double-check not processing (state may have changed between phases)
        if (this.callbacks.isProcessing(chatId)) {
          this.logger.debug({ chatId }, 'Skipping eviction: session is now processing');
          continue;
        }

        this.closeWithLog(chatId, `evicted to enforce maxSessions=${this.config.maxSessions}`);
        result.evicted.push(chatId);
      }
    }

    if (result.idleClosed.length > 0 || result.evicted.length > 0) {
      this.logger.info(
        { idleClosed: result.idleClosed.length, evicted: result.evicted.length, processingSkipped: result.processingSkipped.length },
        'Timeout check completed with closures',
      );
    }

    return Promise.resolve(result);
  }

  /**
   * Close a session with structured logging.
   */
  private closeWithLog(chatId: string, reason: string): void {
    const ctx: LogContext = { chatId, reason };
    this.logger.info(ctx, 'Closing session due to timeout');
    try {
      this.callbacks.closeSession(chatId, reason);
    } catch (err) {
      this.logger.error({ err, ...ctx }, 'Failed to close session');
    }
  }
}
