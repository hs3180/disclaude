/**
 * ConversationOrchestrator - High-level conversation management.
 *
 * This is the main entry point for the conversation layer, combining:
 * - SessionManager for lifecycle management
 * - Message queuing and threading
 * - Event callbacks for consumer integration
 *
 * The orchestrator provides a clean API for:
 * - Processing incoming messages
 * - Managing sessions (reset, shutdown)
 * - Thread tracking
 *
 * Architecture:
 * ```
 * ChatAgent (or other Agent)
 *       ↓
 * ConversationOrchestrator
 *       ↓
 * ConversationSessionManager → Session state
 *       ↓
 * Callbacks → Platform-specific operations
 * ```
 */

import type pino from 'pino';
import type { QueuedMessage, SessionCallbacks, ProcessMessageResult, SessionStats } from './types.js';
import { ConversationSessionManager, type ConversationSessionManagerConfig } from './conversation-session-manager.js';

/**
 * Configuration for ConversationOrchestrator.
 */
export interface ConversationOrchestratorConfig {
  /** Logger instance */
  logger: pino.Logger;
  /** Callbacks for session events */
  callbacks?: SessionCallbacks;
}

/**
 * ConversationOrchestrator - Coordinates conversation components.
 *
 * This class provides the high-level API for conversation management,
 * abstracting away the details of session and message handling.
 */
export class ConversationOrchestrator {
  protected readonly logger: pino.Logger;
  protected readonly sessionManager: ConversationSessionManager;
  /** Callbacks for session events - can be used by subclasses */
  protected readonly callbacks?: SessionCallbacks;

  constructor(config: ConversationOrchestratorConfig) {
    this.logger = config.logger;
    this.callbacks = config.callbacks;

    // Create session manager
    const sessionManagerConfig: ConversationSessionManagerConfig = {
      logger: this.logger,
    };
    this.sessionManager = new ConversationSessionManager(sessionManagerConfig);
  }

  /**
   * Process an incoming message.
   *
   * This method:
   * 1. Tracks the thread root for the message
   * 2. Queues the message for processing
   * 3. Returns immediately (non-blocking)
   *
   * @param chatId - Platform-specific chat identifier
   * @param message - The message to process
   * @returns Result indicating success/failure
   */
  processMessage(chatId: string, message: QueuedMessage): ProcessMessageResult {
    this.logger.debug(
      { chatId, messageId: message.messageId, textLength: message.text.length },
      'Processing message'
    );

    // Track thread root
    this.sessionManager.setThreadRoot(chatId, message.messageId);

    // Queue the message
    const success = this.sessionManager.queueMessage(chatId, message);

    const stats = this.sessionManager.getStats(chatId);

    return {
      success,
      queueLength: stats?.queueLength ?? 0,
      error: success ? undefined : new Error('Session is closed'),
    };
  }

  /**
   * Check if a session exists for the chatId.
   */
  hasSession(chatId: string): boolean {
    return this.sessionManager.has(chatId);
  }

  /**
   * Get the thread root for a chatId.
   */
  getThreadRoot(chatId: string): string | undefined {
    return this.sessionManager.getThreadRoot(chatId);
  }

  /**
   * Set the thread root for a chatId.
   */
  setThreadRoot(chatId: string, messageId: string): void {
    this.sessionManager.setThreadRoot(chatId, messageId);
  }

  /**
   * Delete the thread root for a chatId.
   * Used during session reset.
   */
  deleteThreadRoot(chatId: string): boolean {
    return this.sessionManager.deleteThreadRoot(chatId);
  }

  /**
   * Get session statistics.
   */
  getSessionStats(chatId: string): SessionStats | undefined {
    return this.sessionManager.getStats(chatId);
  }

  /**
   * Get the number of active sessions.
   */
  getActiveSessionCount(): number {
    return this.sessionManager.size();
  }

  /**
   * Get the number of active sessions (alias for getActiveSessionCount).
   * Provided for backward compatibility with ConversationContext API.
   */
  size(): number {
    return this.getActiveSessionCount();
  }

  /**
   * Get all active chat IDs.
   */
  getActiveChatIds(): string[] {
    return this.sessionManager.getActiveChatIds();
  }

  /**
   * Reset state for a specific chatId.
   *
   * This clears the session, including thread roots and queued messages.
   *
   * @param chatId - Platform-specific chat identifier
   * @returns true if session was reset, false if it didn't exist
   */
  reset(chatId: string): boolean {
    const deleted = this.sessionManager.delete(chatId);
    if (deleted) {
      this.logger.info({ chatId }, 'Session reset for chatId');
    } else {
      this.logger.debug({ chatId }, 'No session to reset for chatId');
    }
    return deleted;
  }

  /**
   * Reset all sessions.
   */
  resetAll(): void {
    this.sessionManager.closeAll();
    this.logger.info('All sessions reset');
  }

  /**
   * Clear all sessions (alias for resetAll).
   * Provided for backward compatibility with ConversationContext API.
   */
  clearAll(): void {
    this.resetAll();
  }

  /**
   * Cleanup resources on shutdown.
   */
  shutdown(): void {
    this.logger.info('Shutting down ConversationOrchestrator');

    // Close all sessions
    this.sessionManager.closeAll();

    this.logger.info('ConversationOrchestrator shutdown complete');
  }

  /**
   * Get the underlying session manager for advanced use cases.
   * Use with caution - direct manipulation may bypass orchestrator logic.
   */
  getSessionManager(): ConversationSessionManager {
    return this.sessionManager;
  }
}
