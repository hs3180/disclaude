/**
 * ConversationOrchestrator - High-level conversation management API.
 *
 * This class provides a unified interface for conversation management,
 * combining message queuing, session management, and thread tracking.
 * It's designed to be agent-agnostic and can be used with any agent implementation.
 *
 * Key features:
 * - Process messages with automatic session creation
 * - Reset sessions (for /reset commands)
 * - Get active session count
 * - Graceful shutdown
 *
 * Architecture:
 * ```
 * Pilot (or other Agent)
 *       ↓
 * ConversationOrchestrator
 *       ↓
 * ConversationSessionManager → Session state
 *       ↓
 * MessageQueue → Messages
 *       ↓
 * Callbacks → Platform-specific operations
 * ```
 *
 * Usage:
 * ```typescript
 * const orchestrator = new ConversationOrchestrator({ logger });
 *
 * // Process a message (auto-creates session if needed)
 * orchestrator.processMessage(chatId, message, callbacks);
 *
 * // Get the queue to consume messages
 * const queue = orchestrator.getQueue(chatId);
 *
 * // Reset a session
 * orchestrator.reset(chatId);
 *
 * // Shutdown
 * orchestrator.shutdown();
 * ```
 */

import type pino from 'pino';
import { ConversationSessionManager } from './session-manager.js';
import { MessageQueue } from './message-queue.js';
import type { QueuedMessage, SessionCallbacks, ConversationStats } from './types.js';

/**
 * Configuration for ConversationOrchestrator.
 */
export interface ConversationOrchestratorConfig {
  /** Logger instance */
  logger: pino.Logger;
}

/**
 * Callback for creating agent loop when new session is created.
 *
 * This callback is called when a new session is created and needs
 * an agent loop to process messages. The orchestrator provides the
 * message queue and expects the caller to set up the agent processing.
 */
export type OnCreateSession = (
  chatId: string,
  queue: MessageQueue,
  callbacks: SessionCallbacks
) => void | Promise<void>;

/**
 * ConversationOrchestrator - High-level conversation management.
 *
 * This class orchestrates conversation sessions, providing a clean API
 * for message processing, session management, and lifecycle control.
 *
 * Design Principles:
 * 1. **Single Responsibility**: Each method has one clear purpose
 * 2. **Dependency Injection**: Receives callbacks, doesn't create them
 * 3. **Agent Agnostic**: Can be used with any agent implementation
 * 4. **Interface Segregation**: Small, focused methods
 */
export class ConversationOrchestrator {
  private readonly logger: pino.Logger;
  private readonly sessionManager: ConversationSessionManager;
  private onCreateSession?: OnCreateSession;

  constructor(config: ConversationOrchestratorConfig) {
    this.logger = config.logger;
    this.sessionManager = new ConversationSessionManager({ logger: this.logger });
  }

  /**
   * Set the callback for creating agent loops.
   * This is called when a new session is created.
   */
  setOnCreateSession(callback: OnCreateSession): void {
    this.onCreateSession = callback;
  }

  /**
   * Process a message for a chatId.
   *
   * If no session exists, creates one and calls onCreateSession callback.
   * The message is queued for processing by the agent loop.
   *
   * @param chatId - Platform-specific chat identifier
   * @param message - The message to process
   * @param callbacks - Session callbacks for this message
   * @returns true if a new session was created
   */
  async processMessage(
    chatId: string,
    message: QueuedMessage,
    callbacks: SessionCallbacks
  ): Promise<boolean> {
    // Track thread root
    const isNewSession = !this.sessionManager.has(chatId);

    if (isNewSession) {
      // Create new session
      const queue = this.sessionManager.create(chatId, callbacks);

      // Set thread root
      this.sessionManager.setThreadRoot(chatId, message.messageId);

      // Call onCreateSession callback to set up agent loop
      if (this.onCreateSession) {
        await this.onCreateSession(chatId, queue, callbacks);
      }

      this.logger.debug({ chatId, messageId: message.messageId }, 'New session created for message');
    } else {
      // Update thread root for existing session
      this.sessionManager.setThreadRoot(chatId, message.messageId);

      // Update callbacks for existing session (they might have new parentMessageId)
      // Note: This is a no-op for now as callbacks are typically the same
    }

    // Queue the message
    const queue = this.sessionManager.getQueue(chatId);
    if (queue) {
      queue.push(message);
    }

    return isNewSession;
  }

  /**
   * Get the message queue for a chatId.
   * Returns undefined if no session exists.
   */
  getQueue(chatId: string): MessageQueue | undefined {
    return this.sessionManager.getQueue(chatId);
  }

  /**
   * Get the thread root for a chatId.
   * Returns undefined if no session or no thread root set.
   */
  getThreadRoot(chatId: string): string | undefined {
    return this.sessionManager.getThreadRoot(chatId);
  }

  /**
   * Set the thread root for a chatId.
   * Creates a session if one doesn't exist.
   *
   * @param chatId - Platform-specific chat identifier
   * @param messageId - The message ID to use as thread root
   */
  setThreadRoot(chatId: string, messageId: string): void {
    // Create session if it doesn't exist
    if (!this.sessionManager.has(chatId)) {
      // Create with empty callbacks - will be updated when processMessage is called
      this.sessionManager.create(chatId, {
        onMessage: async () => {},
        onFile: async () => {},
      });
    }
    this.sessionManager.setThreadRoot(chatId, messageId);
  }

  /**
   * Check if a session exists for a chatId.
   */
  hasSession(chatId: string): boolean {
    return this.sessionManager.has(chatId);
  }

  /**
   * Reset state for a specific chatId.
   *
   * This closes the session and removes it from tracking.
   * Used for /reset commands that clear conversation context.
   *
   * @param chatId - Platform-specific chat identifier
   * @returns true if session was reset, false if no session existed
   */
  reset(chatId: string): boolean {
    const deleted = this.sessionManager.delete(chatId);

    if (deleted) {
      this.logger.info({ chatId }, 'Session reset');
    } else {
      this.logger.debug({ chatId }, 'No session to reset');
    }

    return deleted;
  }

  /**
   * Get the number of active sessions.
   */
  getActiveSessionCount(): number {
    return this.sessionManager.size();
  }

  /**
   * Get statistics about the conversation layer.
   */
  getStats(): ConversationStats {
    const activeChatIds = this.sessionManager.getActiveChatIds();
    let totalQueuedMessages = 0;

    for (const chatId of activeChatIds) {
      const queue = this.sessionManager.getQueue(chatId);
      if (queue) {
        totalQueuedMessages += queue.size();
      }
    }

    return {
      activeSessions: activeChatIds.length,
      totalQueuedMessages,
      activeChatIds,
    };
  }

  /**
   * Cleanup resources on shutdown.
   */
  async shutdown(): Promise<void> {
    await Promise.resolve(); // No-op to satisfy async pattern
    this.logger.info('Shutting down ConversationOrchestrator');

    // Close all sessions
    this.sessionManager.closeAll();

    this.logger.info('ConversationOrchestrator shutdown complete');
  }

  // ===== Backward Compatibility Methods =====
  // These methods provide compatibility with the old SessionManager + ConversationContext API

  /**
   * Get session size (alias for getActiveSessionCount).
   * @deprecated Use getActiveSessionCount() instead
   */
  size(): number {
    return this.sessionManager.size();
  }

  /**
   * Clear all sessions (alias for shutdown without logging).
   * @deprecated Use reset() for individual sessions or shutdown() for all
   */
  clearAll(): void {
    this.sessionManager.clearAll();
  }

  /**
   * Delete thread root for a chatId.
   * @deprecated Use reset() instead
   */
  deleteThreadRoot(chatId: string): boolean {
    return this.sessionManager.deleteThreadRoot(chatId);
  }
}
