/**
 * REST Channel Session Manager.
 *
 * Manages async-mode session state, including:
 * - Session lifecycle (create, update, complete)
 * - TTL-based cleanup and LRU eviction
 *
 * Extracted from rest-channel.ts (Issue #4127 part 1).
 *
 * @see Issue #1263 - Session state memory leak fix
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('RestChannel.Session');

/**
 * Session status for async mode.
 */
export type SessionStatus = 'pending' | 'processing' | 'completed' | 'error';

/**
 * Stored message in session.
 */
export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/**
 * Session state for async mode.
 */
export interface SessionState {
  chatId: string;
  status: SessionStatus;
  messages: SessionMessage[];
  lastMessageId?: string;
  createdAt: number;
  updatedAt: number;
}

/** Session TTL: 1 hour */
const SESSION_TTL = 3600000;

/** Maximum number of sessions before LRU eviction */
const MAX_SESSIONS = 10000;

/** Cleanup interval: 1 minute */
const CLEANUP_INTERVAL_MS = 60000;

/**
 * Manages async session state for REST channel.
 *
 * Handles session creation, updates, TTL-based cleanup, and LRU eviction
 * to prevent memory leaks from abandoned sessions.
 */
export class RestSessionManager {
  private sessionStates = new Map<string, SessionState>();
  private cleanupTimer?: NodeJS.Timeout;

  /**
   * Start the periodic session cleanup timer.
   * Idempotent: calling start() when already running is a no-op.
   */
  start(): void {
    if (this.cleanupTimer) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanupSessions();
    }, CLEANUP_INTERVAL_MS);

    this.cleanupTimer.unref();

    logger.info(
      { cleanupInterval: CLEANUP_INTERVAL_MS, sessionTtl: SESSION_TTL, maxSessions: MAX_SESSIONS },
      'Session cleanup timer started',
    );
  }

  /**
   * Stop the session cleanup timer and clear all sessions.
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
      logger.info('Session cleanup timer stopped');
    }
    this.sessionStates.clear();
  }

  /**
   * Get a session by chat ID.
   */
  get(chatId: string): SessionState | undefined {
    return this.sessionStates.get(chatId);
  }

  /**
   * Create a new session.
   */
  create(chatId: string): SessionState {
    const now = Date.now();
    const session: SessionState = {
      chatId,
      status: 'pending',
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.sessionStates.set(chatId, session);
    return session;
  }

  /**
   * Add a message to a session and update its state.
   */
  addMessage(chatId: string, message: SessionMessage): void {
    const session = this.sessionStates.get(chatId);
    if (session) {
      session.messages.push(message);
      session.lastMessageId = message.id;
      session.updatedAt = message.timestamp;
    }
  }

  /**
   * Update session status.
   */
  setStatus(chatId: string, status: SessionStatus): void {
    const session = this.sessionStates.get(chatId);
    if (session) {
      session.status = status;
      session.updatedAt = Date.now();
    }
  }

  /**
   * Mark a session as completed.
   */
  complete(chatId: string): void {
    const session = this.sessionStates.get(chatId);
    if (!session) {
      return;
    }
    session.status = 'completed';
    session.updatedAt = Date.now();
  }

  /**
   * Check if a session exists.
   */
  has(chatId: string): boolean {
    return this.sessionStates.has(chatId);
  }

  /**
   * Get the number of active sessions.
   */
  count(): number {
    return this.sessionStates.size;
  }

  /**
   * Clean up expired sessions and enforce max session limit.
   */
  private cleanupSessions(): void {
    const now = Date.now();
    let expiredCount = 0;
    let evictedCount = 0;

    // Remove expired sessions (TTL-based cleanup)
    for (const [chatId, session] of this.sessionStates) {
      if (now - session.updatedAt > SESSION_TTL) {
        this.sessionStates.delete(chatId);
        expiredCount++;
      }
    }

    // Enforce max sessions limit (LRU eviction)
    if (this.sessionStates.size > MAX_SESSIONS) {
      const sortedSessions = Array.from(this.sessionStates.entries())
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt);

      const toEvict = sortedSessions.slice(0, this.sessionStates.size - MAX_SESSIONS);
      for (const [chatId] of toEvict) {
        this.sessionStates.delete(chatId);
        evictedCount++;
      }
    }

    if (expiredCount > 0 || evictedCount > 0) {
      logger.info(
        { expiredCount, evictedCount, remainingSessions: this.sessionStates.size },
        'Session cleanup completed',
      );
    }
  }
}
