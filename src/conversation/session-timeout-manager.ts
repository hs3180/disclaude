/**
 * SessionTimeoutManager - Automatic session timeout management (Issue #1313).
 *
 * This class handles automatic cleanup of idle sessions to:
 * - Release SDK connections and memory for inactive chats
 * - Enforce maximum concurrent session limits
 * - Provide configurable timeout behavior
 *
 * Design Principles:
 * - Never timeout sessions that are actively processing tasks
 * - Configurable idle timeout and check interval
 * - Graceful cleanup with logging
 */

import type pino from 'pino';
import type { ConversationSessionManager } from './session-manager.js';
import type { SessionTimeoutConfig } from '../config/types.js';

/**
 * Default timeout configuration values.
 */
const DEFAULTS = {
  enabled: false,
  idleMinutes: 30,
  maxSessions: 100,
  checkIntervalMinutes: 5,
};

/**
 * Resolved timeout configuration with defaults applied.
 */
export interface ResolvedTimeoutConfig {
  enabled: boolean;
  idleMinutes: number;
  maxSessions: number;
  checkIntervalMinutes: number;
}

/**
 * Callback for disposing sessions.
 */
export type DisposeSessionCallback = (chatId: string) => boolean;

/**
 * Configuration for SessionTimeoutManager.
 */
export interface SessionTimeoutManagerConfig {
  /** Logger instance */
  logger: pino.Logger;
  /** Session manager instance */
  sessionManager: ConversationSessionManager;
  /** Timeout configuration */
  config: SessionTimeoutConfig;
  /** Callback to dispose a session */
  onDisposeSession: DisposeSessionCallback;
}

/**
 * SessionTimeoutManager - Manages automatic session cleanup.
 *
 * Periodically checks for idle sessions and disposes them.
 * Sessions that are actively processing tasks are never timed out.
 */
export class SessionTimeoutManager {
  private readonly logger: pino.Logger;
  private readonly sessionManager: ConversationSessionManager;
  private readonly config: ResolvedTimeoutConfig;
  private readonly onDisposeSession: DisposeSessionCallback;
  private checkTimer?: ReturnType<typeof setInterval>;
  private isRunning = false;

  constructor(options: SessionTimeoutManagerConfig) {
    this.logger = options.logger;
    this.sessionManager = options.sessionManager;
    this.onDisposeSession = options.onDisposeSession;
    this.config = {
      enabled: options.config.enabled ?? DEFAULTS.enabled,
      idleMinutes: options.config.idleMinutes ?? DEFAULTS.idleMinutes,
      maxSessions: options.config.maxSessions ?? DEFAULTS.maxSessions,
      checkIntervalMinutes: options.config.checkIntervalMinutes ?? DEFAULTS.checkIntervalMinutes,
    };
  }

  /**
   * Get the resolved configuration.
   */
  getConfig(): ResolvedTimeoutConfig {
    return { ...this.config };
  }

  /**
   * Start the timeout check timer.
   */
  start(): void {
    if (!this.config.enabled) {
      this.logger.debug('Session timeout is disabled');
      return;
    }

    if (this.isRunning) {
      this.logger.warn('SessionTimeoutManager is already running');
      return;
    }

    const intervalMs = this.config.checkIntervalMinutes * 60 * 1000;
    this.checkTimer = setInterval(() => this.checkAndCleanup(), intervalMs);
    this.isRunning = true;

    this.logger.info(
      {
        idleMinutes: this.config.idleMinutes,
        maxSessions: this.config.maxSessions,
        checkIntervalMinutes: this.config.checkIntervalMinutes,
      },
      'SessionTimeoutManager started'
    );
  }

  /**
   * Stop the timeout check timer.
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
    this.isRunning = false;
    this.logger.info('SessionTimeoutManager stopped');
  }

  /**
   * Check if the manager is currently running.
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Perform a single check and cleanup cycle.
   * This is the main logic that runs periodically.
   */
  checkAndCleanup(): void {
    const sessionCount = this.sessionManager.size();

    // Check if we're over the max sessions limit
    if (sessionCount > this.config.maxSessions) {
      this.logger.warn(
        { sessionCount, maxSessions: this.config.maxSessions },
        'Session count exceeds max limit, forcing cleanup'
      );
    }

    // Find idle sessions
    const idleTimeoutMs = this.config.idleMinutes * 60 * 1000;
    const idleChatIds = this.sessionManager.getIdleSessions(idleTimeoutMs);

    if (idleChatIds.length === 0) {
      this.logger.debug({ sessionCount }, 'No idle sessions to cleanup');
      return;
    }

    this.logger.info(
      { idleCount: idleChatIds.length, sessionCount },
      'Found idle sessions to cleanup'
    );

    // Dispose idle sessions
    let disposedCount = 0;
    for (const chatId of idleChatIds) {
      try {
        const disposed = this.onDisposeSession(chatId);
        if (disposed) {
          disposedCount++;
          this.logger.debug({ chatId }, 'Idle session disposed');
        }
      } catch (err) {
        this.logger.error({ err, chatId }, 'Error disposing idle session');
      }
    }

    this.logger.info(
      { disposedCount, totalIdle: idleChatIds.length },
      'Session cleanup completed'
    );
  }
}
