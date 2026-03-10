/**
 * SessionTimeoutManager - Manages session timeout detection and cleanup.
 *
 * This manager handles automatic session timeout for idle chats:
 * - Periodically checks for idle sessions
 * - Triggers callbacks when sessions should be closed
 * - Respects maxSessions limit by closing oldest idle sessions
 *
 * @see Issue #1313
 */

import type pino from 'pino';
import type { ConversationSessionManager } from './session-manager.js';

/**
 * Configuration for SessionTimeoutManager.
 */
export interface SessionTimeoutManagerConfig {
  /** Logger instance */
  logger: pino.Logger;
  /** Session manager instance */
  sessionManager: ConversationSessionManager;
  /** Enable session timeout management */
  enabled: boolean;
  /** Idle minutes before session is closed */
  idleMinutes: number;
  /** Maximum concurrent sessions (0 = unlimited) */
  maxSessions: number;
  /** Check interval in minutes for timeout detection */
  checkIntervalMinutes: number;
  /** Callback when a session should be closed */
  onSessionTimeout: (chatId: string) => Promise<void>;
}

/**
 * SessionTimeoutManager - Automatic session timeout management.
 *
 * Features:
 * - Periodic idle session detection
 * - Configurable idle timeout
 * - Max sessions limit enforcement
 * - Processing-aware (won't timeout sessions with active tasks)
 */
export class SessionTimeoutManager {
  private readonly logger: pino.Logger;
  private readonly sessionManager: ConversationSessionManager;
  private readonly enabled: boolean;
  private readonly idleMs: number;
  private readonly maxSessions: number;
  private readonly checkIntervalMs: number;
  private readonly onSessionTimeout: (chatId: string) => Promise<void>;

  private checkTimer?: ReturnType<typeof setInterval>;
  private isChecking = false;

  constructor(config: SessionTimeoutManagerConfig) {
    this.logger = config.logger;
    this.sessionManager = config.sessionManager;
    this.enabled = config.enabled;
    this.idleMs = config.idleMinutes * 60 * 1000;
    this.maxSessions = config.maxSessions;
    this.checkIntervalMs = config.checkIntervalMinutes * 60 * 1000;
    this.onSessionTimeout = config.onSessionTimeout;

    if (this.enabled) {
      this.logger.info(
        {
          idleMinutes: config.idleMinutes,
          maxSessions: config.maxSessions,
          checkIntervalMinutes: config.checkIntervalMinutes,
        },
        'Session timeout manager configured'
      );
    }
  }

  /**
   * Start the periodic timeout check.
   */
  start(): void {
    if (!this.enabled) {
      this.logger.debug('Session timeout manager is disabled');
      return;
    }

    if (this.checkTimer) {
      this.logger.warn('Session timeout manager already running');
      return;
    }

    this.checkTimer = setInterval(() => {
      this.checkTimeouts().catch((error) => {
        this.logger.error({ error }, 'Error during timeout check');
      });
    }, this.checkIntervalMs);

    this.logger.info(
      { checkIntervalMs: this.checkIntervalMs },
      'Session timeout manager started'
    );
  }

  /**
   * Stop the periodic timeout check.
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
      this.logger.info('Session timeout manager stopped');
    }
  }

  /**
   * Check for idle sessions and trigger timeouts.
   * Also enforces maxSessions limit if configured.
   */
  async checkTimeouts(): Promise<void> {
    if (!this.enabled || this.isChecking) {
      return;
    }

    this.isChecking = true;
    try {
      // Get idle sessions
      const idleChatIds = this.sessionManager.getIdleSessions(this.idleMs);

      if (idleChatIds.length === 0) {
        this.logger.debug('No idle sessions to timeout');
        return;
      }

      this.logger.info(
        { count: idleChatIds.length, idleMinutes: this.idleMs / 60000 },
        'Found idle sessions'
      );

      // Check maxSessions limit
      const currentCount = this.sessionManager.size();
      const excessCount = this.maxSessions > 0 ? currentCount - this.maxSessions : 0;

      // If we're over limit, prioritize closing oldest idle sessions
      let sessionsToClose = idleChatIds;
      if (excessCount > 0 && idleChatIds.length > excessCount) {
        // Get session stats to sort by lastActivity
        const sessionStats = idleChatIds
          .map((chatId) => this.sessionManager.getStats(chatId))
          .filter((s): s is NonNullable<typeof s> => s !== undefined)
          .sort((a, b) => a.lastActivity - b.lastActivity);

        // Close only enough to get under limit
        sessionsToClose = sessionStats.slice(0, excessCount).map((s) => s.chatId);
      }

      // Close idle sessions
      for (const chatId of sessionsToClose) {
        try {
          this.logger.info({ chatId }, 'Closing idle session');
          await this.onSessionTimeout(chatId);
        } catch (error) {
          this.logger.error({ error, chatId }, 'Error closing idle session');
        }
      }
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Get current configuration.
   */
  getConfig(): {
    enabled: boolean;
    idleMinutes: number;
    maxSessions: number;
    checkIntervalMinutes: number;
  } {
    return {
      enabled: this.enabled,
      idleMinutes: this.idleMs / 60000,
      maxSessions: this.maxSessions,
      checkIntervalMinutes: this.checkIntervalMs / 60000,
    };
  }
}
