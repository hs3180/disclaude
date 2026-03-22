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
 */

import type pino from 'pino';
import type { SessionTimeoutConfig } from '../config/types.js';

/**
 * Callbacks for session timeout events.
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
export class SessionTimeoutManager {
  private readonly logger: pino.Logger;
  private readonly config: SessionTimeoutConfig;
  private readonly callbacks: SessionTimeoutCallbacks;
  private checkTimer?: NodeJS.Timeout;
  private isChecking = false;

  constructor(config: SessionTimeoutManagerConfig) {
    this.logger = config.logger;
    this.config = config.config;
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

    const intervalMs = (this.config.checkIntervalMinutes ?? 5) * 60 * 1000;
    this.checkTimer = setInterval(() => {
      this.checkTimeouts().catch((err) => {
        this.logger.error({ err }, 'Error during timeout check');
      });
    }, intervalMs);

    this.logger.info(
      {
        idleMinutes: this.config.idleMinutes ?? 30,
        maxSessions: this.config.maxSessions ?? 100,
        checkIntervalMinutes: this.config.checkIntervalMinutes ?? 5,
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
   * Check for idle sessions and close them.
   */
  async checkTimeouts(): Promise<void> {
    // Prevent concurrent checks
    if (this.isChecking) {
      this.logger.debug('Timeout check already in progress, skipping');
      return;
    }
    this.isChecking = true;

    try {
      const now = Date.now();
      const idleThresholdMs = (this.config.idleMinutes ?? 30) * 60 * 1000;
      const activeChatIds = this.callbacks.getActiveChatIds();
      const currentSessionCount = this.callbacks.getSessionCount();

      this.logger.debug(
        { sessionCount: currentSessionCount, chatCount: activeChatIds.length },
        'Checking for idle sessions'
      );

      // Find idle sessions
      const idleChatIds: string[] = [];
      for (const chatId of activeChatIds) {
        // Skip if processing
        if (this.callbacks.isProcessing(chatId)) {
          continue;
        }

        const lastActivity = this.callbacks.getLastActivity(chatId);
        if (lastActivity === undefined) {
          continue;
        }

        const idleTimeMs = now - lastActivity;
        if (idleTimeMs >= idleThresholdMs) {
          idleChatIds.push(chatId);
        }
      }

      // Close idle sessions
      for (const chatId of idleChatIds) {
        this.logger.info(
          { chatId, idleMinutes: Math.round((now - (this.callbacks.getLastActivity(chatId) ?? now)) / 60000) },
          'Closing idle session'
        );
        this.callbacks.closeSession(chatId, 'idle_timeout');
      }

      // Enforce max sessions limit if exceeded
      const newSessionCount = this.callbacks.getSessionCount();
      if (newSessionCount > (this.config.maxSessions ?? 100)) {
        const excessCount = newSessionCount - (this.config.maxSessions ?? 100);
        this.logger.info(
          { currentCount: newSessionCount, maxSessions: this.config.maxSessions, excessCount },
          'Session count exceeds limit, closing oldest idle sessions'
        );

        // Find oldest idle sessions to close
        const sortedByIdleTime = activeChatIds
          .filter(chatId => !this.callbacks.isProcessing(chatId))
          .map(chatId => ({
            chatId,
            lastActivity: this.callbacks.getLastActivity(chatId) ?? now,
          }))
          .sort((a, b) => a.lastActivity - b.lastActivity);

        // Close the oldest sessions
        for (let i = 0; i < Math.min(excessCount, sortedByIdleTime.length); i++) {
          const { chatId } = sortedByIdleTime[i];
          this.logger.info(
            { chatId, reason: 'max_sessions_exceeded' },
            'Closing session due to max sessions limit'
          );
          this.callbacks.closeSession(chatId, 'max_sessions_exceeded');
        }
      }

      if (idleChatIds.length > 0 || this.callbacks.getSessionCount() > (this.config.maxSessions ?? 100)) {
        this.logger.info(
          {
            closedSessions: idleChatIds.length,
            currentSessionCount: this.callbacks.getSessionCount(),
          },
          'Timeout check completed'
        );
      }
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Check if the manager is currently running.
   */
  isRunning(): boolean {
    return this.checkTimer !== undefined;
  }
}
