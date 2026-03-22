/**
 * SessionTimeoutManager - Manages session timeout for idle chats.
 *
 * Issue #1313: Session 超时自动管理
 *
 * When a chat session has been idle for a configurable period, the system automatically:
 * 1. Closes the session to release resources
 * 2. Enforces a maximum concurrent session limit
 *
 * Features:
 * - Processing Protection: Sessions actively processing tasks are never timed out
 * - Configurable: Idle timeout, max sessions, and check interval all configurable
 * - Graceful Cleanup: Proper logging and error handling
 * - Shared by primary-node and worker-node via callbacks interface
 */

import type pino from 'pino';
import type { SessionTimeoutConfig } from '../config/index.js';

/**
 * Callbacks for session timeout events.
 * Implemented by primary-node or worker-node to provide session management.
 */
export interface SessionTimeoutCallbacks {
  /**
   * Get the last activity timestamp for a chat.
   * @param chatId - The chat identifier
   * @returns Last activity timestamp in milliseconds, or undefined if no session
   */
  getLastActivity: (chatId: string) => number | undefined;

  /**
   * Check if a session is currently processing (should not be timed out).
   * @param chatId - The chat identifier
   * @returns true if the session is processing
   */
  isProcessing: (chatId: string) => boolean;

  /**
   * Get all active chat IDs.
   * @returns Array of active chat IDs
   */
  getActiveChatIds: () => string[];

  /**
   * Get the current number of active sessions.
   * @returns Number of active sessions
   */
  getSessionCount: () => number;

  /**
   * Close a session.
   * @param chatId - The chat identifier
   * @param reason - Reason for closing
   */
  closeSession: (chatId: string, reason: string) => void;
}

/**
 * Configuration for SessionTimeoutManager.
 */
export interface SessionTimeoutManagerConfig {
  /** Logger instance */
  logger: pino.Logger;
  /** Timeout configuration */
  config: SessionTimeoutConfig;
  /** Callbacks for session management */
  callbacks: SessionTimeoutCallbacks;
}

/**
 * Session timeout manager - monitors and closes idle sessions.
 *
 * @example
 * ```typescript
 * const manager = new SessionTimeoutManager({
 *   logger,
 *   config: { enabled: true, idleMinutes: 30, maxSessions: 100, checkIntervalMinutes: 5 },
 *   callbacks: {
 *     getLastActivity: (chatId) => sessionManager.getLastActivity(chatId),
 *     isProcessing: (chatId) => sessionManager.isProcessing(chatId),
 *     getActiveChatIds: () => sessionManager.getActiveChatIds(),
 *     getSessionCount: () => sessionManager.size(),
 *     closeSession: (chatId, reason) => sessionManager.delete(chatId),
 *   },
 * });
 *
 * manager.start();
 * // Later...
 * manager.stop();
 * ```
 */
/**
 * Internal config with defaults applied.
 */
interface InternalSessionTimeoutConfig {
  enabled: boolean;
  idleMinutes: number;
  maxSessions: number;
  checkIntervalMinutes: number;
}

export class SessionTimeoutManager {
  private readonly logger: pino.Logger;
  private readonly config: InternalSessionTimeoutConfig;
  private readonly callbacks: SessionTimeoutCallbacks;
  private checkTimer?: NodeJS.Timeout;
  private isChecking = false;

  constructor(config: SessionTimeoutManagerConfig) {
    this.logger = config.logger;
    // Apply defaults to config
    this.config = {
      enabled: config.config.enabled ?? false,
      idleMinutes: config.config.idleMinutes ?? 30,
      maxSessions: config.config.maxSessions ?? 100,
      checkIntervalMinutes: config.config.checkIntervalMinutes ?? 5,
    };
    this.callbacks = config.callbacks;
  }

  /**
   * Start the timeout check timer.
   */
  start(): void {
    if (!this.config.enabled) {
      this.logger.info('Session timeout management is disabled');
      return;
    }

    if (this.checkTimer) {
      this.logger.warn('Session timeout manager already started');
      return;
    }

    this.checkTimer = setInterval(() => {
      this.runCheck();
    }, this.config.checkIntervalMinutes * 60 * 1000);

    this.logger.info(
      {
        idleMinutes: this.config.idleMinutes,
        maxSessions: this.config.maxSessions,
        checkIntervalMinutes: this.config.checkIntervalMinutes,
      },
      'Session timeout manager started'
    );
  }

  /**
   * Stop the timeout check timer.
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
      this.logger.info('Session timeout manager stopped');
    }
  }

  /**
   * Run a single timeout check cycle.
   */
  private runCheck(): void {
    if (this.isChecking) {
      this.logger.debug('Check already in progress, skipping');
      return;
    }

    this.isChecking = true;

    try {
      const sessionCount = this.callbacks.getSessionCount();
      const activeChatIds = this.callbacks.getActiveChatIds();

      if (activeChatIds.length === 0) {
        this.logger.debug('No active sessions to check');
        return;
      }

      // Check max sessions limit
      if (sessionCount > this.config.maxSessions) {
        const oldest = this.findOldestSession(activeChatIds);
        if (oldest) {
          const reason = `Exceeded max sessions limit (${this.config.maxSessions}), closing oldest session`;
          this.callbacks.closeSession(oldest.chatId, reason);
        }
      }

      // Check idle sessions
      for (const chatId of activeChatIds) {
        if (this.shouldTimeoutSession(chatId, Date.now())) {
          const lastActivity = this.callbacks.getLastActivity(chatId);
          if (lastActivity === undefined) {
            this.logger.debug({ chatId }, 'No last activity recorded, skipping');
            continue;
          }

          const isProcessing = this.callbacks.isProcessing(chatId);
          if (isProcessing) {
            this.logger.debug({ chatId }, 'Session is processing, skipping timeout check');
            continue;
          }

          this.callbacks.closeSession(chatId, 'idle_timeout');
          this.logger.info(
            { chatId, lastActivity, idleMinutes: this.config.idleMinutes },
            'Session closed due to idle timeout'
          );
        }
      }

      this.logger.debug('Timeout check completed');
    } catch (error) {
      this.logger.error({ error }, 'Error during timeout check: %s', (error as Error).message);
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Check if a session should be timed out.
   */
  private shouldTimeoutSession(chatId: string, now: number): boolean {
    const lastActivity = this.callbacks.getLastActivity(chatId);
    if (lastActivity === undefined) {
      return false;
    }
    const idleMs = now - lastActivity;
    return idleMs >= this.config.idleMinutes * 60 * 1000;
  }

  /**
   * Find the oldest session (least recent activity).
   */
  private findOldestSession(chatIds: string[]): { chatId: string; lastActivity: number } | undefined {
    let oldest: { chatId: string; lastActivity: number } | undefined;

    for (const chatId of chatIds) {
      const lastActivity = this.callbacks.getLastActivity(chatId);
      if (lastActivity === undefined) {
        continue;
      }

      if (oldest === undefined || lastActivity < oldest.lastActivity) {
        oldest = { chatId, lastActivity };
      }
    }

    return oldest;
  }

  /**
   * Get idle minutes threshold.
   */
  get idleMinutes(): number {
    return this.config.idleMinutes;
  }

  /**
   * Get max sessions limit.
   */
  get maxSessions(): number {
    return this.config.maxSessions;
  }

  /**
   * Get check interval in minutes.
   */
  get checkIntervalMinutes(): number {
    return this.config.checkIntervalMinutes;
  }

  /**
   * Check if timeout management is enabled.
   */
  get isEnabled(): boolean {
    return this.config.enabled;
  }
}
