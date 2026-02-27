/**
 * ConversationSessionManager - Agent-agnostic session lifecycle management.
 *
 * This class manages conversation sessions independently of the agent implementation.
 * Each session tracks its own message queue, thread root, and lifecycle state.
 *
 * Key features:
 * - Per-chatId session tracking
 * - Message queue management
 * - Thread root tracking for reply chains
 * - Session lifecycle (create, get, delete, reset)
 * - Activity tracking for health monitoring
 *
 * Architecture:
 * ```
 * ConversationOrchestrator
 *       ↓
 * ConversationSessionManager → Session state
 *       ↓
 * MessageQueue → Messages
 * ```
 */

import type pino from 'pino';
import { MessageQueue } from './message-queue.js';
import type { SessionCallbacks, SessionState } from './types.js';

/**
 * Internal session representation with queue.
 */
interface InternalSession {
  /** Message queue for this session */
  queue: MessageQueue;
  /** Session state */
  state: SessionState;
  /** Session callbacks */
  callbacks: SessionCallbacks;
  /** When this session was created */
  createdAt: Date;
}

/**
 * Configuration for ConversationSessionManager.
 */
export interface ConversationSessionManagerConfig {
  /** Logger instance */
  logger: pino.Logger;
}

/**
 * Options for creating a new session.
 */
export interface CreateSessionOptions {
  /** Platform-specific chat identifier */
  chatId: string;
  /** Callbacks for session events */
  callbacks: SessionCallbacks;
}

/**
 * ConversationSessionManager - Manages conversation session lifecycle.
 *
 * This is an agent-agnostic session manager that can be used with any
 * agent implementation. It tracks per-chatId sessions with message queues
 * and thread roots.
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
   * Get the message queue for a chatId.
   * Returns undefined if no session exists.
   */
  getQueue(chatId: string): MessageQueue | undefined {
    return this.sessions.get(chatId)?.queue;
  }

  /**
   * Get the session state for a chatId.
   * Returns undefined if no session exists.
   */
  getState(chatId: string): SessionState | undefined {
    return this.sessions.get(chatId)?.state;
  }

  /**
   * Get the session callbacks for a chatId.
   * Returns undefined if no session exists.
   */
  getCallbacks(chatId: string): SessionCallbacks | undefined {
    return this.sessions.get(chatId)?.callbacks;
  }

  /**
   * Get the thread root for a chatId.
   * Returns undefined if no session or no thread root set.
   */
  getThreadRoot(chatId: string): string | undefined {
    return this.sessions.get(chatId)?.state.currentThreadRootId;
  }

  /**
   * Set the thread root for a chatId.
   * No-op if no session exists.
   */
  setThreadRoot(chatId: string, messageId: string): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.state.currentThreadRootId = messageId;
      session.state.lastActivity = Date.now();
      this.logger.debug({ chatId, messageId }, 'Thread root set');
    }
  }

  /**
   * Create a new session for the chatId.
   *
   * @param chatId - The chat identifier
   * @param callbacks - Session callbacks
   * @returns The created message queue
   */
  create(chatId: string, callbacks: SessionCallbacks): MessageQueue {
    const queue = new MessageQueue();

    const state: SessionState = {
      messageQueue: [],
      pendingWriteFiles: new Set(),
      closed: false,
      lastActivity: Date.now(),
      started: false,
    };

    const session: InternalSession = {
      queue,
      state,
      callbacks,
      createdAt: new Date(),
    };

    this.sessions.set(chatId, session);
    this.logger.debug({ chatId }, 'Session created');

    return queue;
  }

  /**
   * Delete a session for the chatId.
   *
   * IMPORTANT: This deletes the session from tracking BEFORE closing resources,
   * so that external observers can distinguish explicit close from unexpected termination.
   *
   * @param chatId - The chat identifier
   * @returns true if session was deleted, false if it didn't exist
   */
  delete(chatId: string): boolean {
    const session = this.sessions.get(chatId);
    if (!session) {
      return false;
    }

    // Remove from map FIRST for explicit close detection
    this.sessions.delete(chatId);

    // Mark as closed and close queue
    session.state.closed = true;
    session.queue.close();

    this.logger.debug({ chatId }, 'Session deleted');
    return true;
  }

  /**
   * Delete session tracking without closing resources.
   * Used when resources are already closed or will be closed externally.
   */
  deleteTracking(chatId: string): boolean {
    const session = this.sessions.get(chatId);
    if (!session) {
      return false;
    }

    this.sessions.delete(chatId);
    this.logger.debug({ chatId }, 'Session tracking removed');
    return true;
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
   * Update last activity timestamp for a session.
   */
  touch(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.state.lastActivity = Date.now();
    }
  }

  /**
   * Mark a session as started.
   */
  markStarted(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.state.started = true;
      this.logger.debug({ chatId }, 'Session marked as started');
    }
  }

  /**
   * Close all sessions and clear tracking.
   * Used during shutdown.
   */
  closeAll(): void {
    // Clear map FIRST
    const sessions = Array.from(this.sessions.entries());
    this.sessions.clear();

    // Then close all resources
    for (const [chatId, session] of sessions) {
      session.state.closed = true;
      session.queue.close();
      this.logger.debug({ chatId }, 'Session closed during shutdown');
    }

    this.logger.info('All sessions closed');
  }

  // ===== Backward Compatibility Methods =====
  // These methods provide compatibility with the old ConversationContext API

  /**
   * Delete the thread root for a chatId.
   * @deprecated Use delete() instead for full cleanup
   */
  deleteThreadRoot(chatId: string): boolean {
    const session = this.sessions.get(chatId);
    if (!session) {
      return false;
    }
    const hadRoot = !!session.state.currentThreadRootId;
    session.state.currentThreadRootId = undefined;
    if (hadRoot) {
      this.logger.debug({ chatId }, 'Thread root deleted');
    }
    return hadRoot;
  }

  /**
   * Clear all sessions.
   * @deprecated Use closeAll() instead
   */
  clearAll(): void {
    this.closeAll();
  }
}
