/**
 * SessionManager - Manages conversation session lifecycle.
 *
 * This is an agent-agnostic session manager that handles:
 * - Session state tracking (per chatId)
 * - Thread root management
 * - Session creation, retrieval, and cleanup
 *
 * Unlike the agents/ SessionManager which is tightly coupled to Query/Channel,
 * this version focuses on pure conversation state management.
 */

import type pino from 'pino';
import type { SessionState, QueuedMessage, SessionStats } from './types.js';

/**
 * Configuration for ConversationSessionManager.
 */
export interface ConversationSessionManagerConfig {
  /** Logger instance */
  logger: pino.Logger;
}

/**
 * Internal session data structure.
 */
interface InternalSession extends SessionState {
  /** When this session was created */
  createdAt: number;
}

/**
 * ConversationSessionManager - Agent-agnostic session lifecycle management.
 *
 * Each chatId gets its own session containing conversation state.
 * This class provides:
 * - Session creation with default state
 * - Thread root tracking
 * - Session statistics
 * - Lifecycle management (get, has, delete, closeAll)
 */
export class ConversationSessionManager {
  private readonly logger: pino.Logger;
  private readonly sessions = new Map<string, InternalSession>();

  constructor(config: ConversationSessionManagerConfig) {
    this.logger = config.logger;
  }

  /**
   * Check if a session exists for the given chatId.
   */
  has(chatId: string): boolean {
    return this.sessions.has(chatId);
  }

  /**
   * Get an existing session for the chatId.
   * Returns undefined if no session exists.
   */
  get(chatId: string): SessionState | undefined {
    return this.sessions.get(chatId);
  }

  /**
   * Get or create a session for the chatId.
   * If the session doesn't exist, creates one with default state.
   *
   * @param chatId - The chat identifier
   * @returns The session state
   */
  getOrCreate(chatId: string): SessionState {
    let session = this.sessions.get(chatId);
    if (!session) {
      session = this.createDefaultSession();
      this.sessions.set(chatId, session);
      this.logger.debug({ chatId }, 'Session created');
    }
    return session;
  }

  /**
   * Create a new session with default state.
   */
  private createDefaultSession(): InternalSession {
    const now = Date.now();
    return {
      messageQueue: [],
      closed: false,
      lastActivity: now,
      started: false,
      createdAt: now,
    };
  }

  /**
   * Update the thread root for a session.
   *
   * @param chatId - The chat identifier
   * @param threadRootId - The message ID to use as thread root
   */
  setThreadRoot(chatId: string, threadRootId: string): void {
    const session = this.getOrCreate(chatId);
    session.currentThreadRootId = threadRootId;
    session.lastActivity = Date.now();
    this.logger.debug({ chatId, threadRootId }, 'Thread root set');
  }

  /**
   * Get the thread root for a session.
   *
   * @param chatId - The chat identifier
   * @returns The thread root message ID, or undefined if not set
   */
  getThreadRoot(chatId: string): string | undefined {
    return this.sessions.get(chatId)?.currentThreadRootId;
  }

  /**
   * Delete the thread root for a session.
   * Used during session reset to clear thread tracking.
   *
   * @param chatId - The chat identifier
   * @returns true if thread root was deleted, false if not set
   */
  deleteThreadRoot(chatId: string): boolean {
    const session = this.sessions.get(chatId);
    if (session && session.currentThreadRootId) {
      session.currentThreadRootId = undefined;
      this.logger.debug({ chatId }, 'Thread root deleted');
      return true;
    }
    return false;
  }

  /**
   * Queue a message for a session.
   *
   * @param chatId - The chat identifier
   * @param message - The message to queue
   * @returns true if message was queued, false if session is closed
   */
  queueMessage(chatId: string, message: QueuedMessage): boolean {
    const session = this.getOrCreate(chatId);
    if (session.closed) {
      return false;
    }
    session.messageQueue.push(message);
    session.lastActivity = Date.now();
    if (session.messageResolver) {
      session.messageResolver();
      session.messageResolver = undefined;
    }
    this.logger.debug({ chatId, messageId: message.messageId }, 'Message queued');
    return true;
  }

  /**
   * Mark a session as started.
   */
  markStarted(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.started = true;
      session.lastActivity = Date.now();
    }
  }

  /**
   * Delete a session for the chatId.
   *
   * @param chatId - The chat identifier
   * @returns true if session was deleted, false if it didn't exist
   */
  delete(chatId: string): boolean {
    const session = this.sessions.get(chatId);
    if (!session) {
      return false;
    }

    // Mark as closed first
    session.closed = true;

    // Resolve any pending resolver
    if (session.messageResolver) {
      session.messageResolver();
    }

    // Remove from map
    this.sessions.delete(chatId);
    this.logger.debug({ chatId }, 'Session deleted');
    return true;
  }

  /**
   * Get statistics for a session.
   *
   * @param chatId - The chat identifier
   * @returns Session statistics, or undefined if no session
   */
  getStats(chatId: string): SessionStats | undefined {
    const session = this.sessions.get(chatId);
    if (!session) {
      return undefined;
    }
    return {
      chatId,
      queueLength: session.messageQueue.length,
      isClosed: session.closed,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      started: session.started,
      threadRootId: session.currentThreadRootId,
    };
  }

  /**
   * Get the number of active sessions.
   */
  size(): number {
    return this.sessions.size;
  }

  /**
   * Get all chatIds with active sessions.
   */
  getActiveChatIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Close all sessions and clear tracking.
   * Used during shutdown.
   */
  closeAll(): void {
    // Mark all as closed and resolve any pending resolvers
    for (const [_chatId, session] of this.sessions) {
      session.closed = true;
      if (session.messageResolver) {
        session.messageResolver();
      }
    }

    // Clear the map
    this.sessions.clear();
    this.logger.info('All sessions closed');
  }

  /**
   * Mark a session as processing (task in progress).
   * Used to prevent timeout during task execution.
   * @see Issue #1313
   *
   * @param chatId - The chat identifier
   * @param isProcessing - Whether the session is processing
   */
  setProcessing(chatId: string, isProcessing: boolean): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.isProcessing = isProcessing;
      if (isProcessing) {
        session.lastActivity = Date.now();
      }
      this.logger.debug({ chatId, isProcessing }, 'Session processing state updated');
    }
  }

  /**
   * Check if a session is currently processing.
   * @see Issue #1313
   *
   * @param chatId - The chat identifier
   * @returns true if session is processing, false otherwise
   */
  isProcessing(chatId: string): boolean {
    const session = this.sessions.get(chatId);
    return session?.isProcessing ?? false;
  }

  /**
   * Get all sessions that have been idle for longer than the specified threshold.
   * Excludes sessions that are currently processing.
   * @see Issue #1313
   *
   * @param idleMs - Idle threshold in milliseconds
   * @returns Array of chatIds that are idle
   */
  getIdleSessions(idleMs: number): string[] {
    const now = Date.now();
    const idleChatIds: string[] = [];

    for (const [chatId, session] of this.sessions) {
      // Skip if session is closed or currently processing
      if (session.closed || session.isProcessing) {
        continue;
      }
      // Check if idle time exceeds threshold
      const idleTime = now - session.lastActivity;
      if (idleTime >= idleMs) {
        idleChatIds.push(chatId);
      }
    }

    return idleChatIds;
  }
}
