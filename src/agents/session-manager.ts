/**
 * SessionManager - Manages QueryHandle and MessageChannel lifecycle for Pilot.
 *
 * Extracts session management concerns from Pilot to improve separation of concerns:
 * - QueryHandle instance management (agent interaction)
 * - MessageChannel management (conversation flow)
 * - Session lifecycle (create, get, delete, reset)
 *
 * Architecture:
 * ```
 * Pilot → SessionManager → { QueryHandle, MessageChannel }
 *                     ↓
 *              Per-chatId session tracking
 * ```
 */

import { MessageChannel,  type QueryHandle,
} from '@disclaude/core';
import type pino from 'pino';

/**
 * Represents an active session for a chatId.
 */
export interface PilotSession {
  /** The QueryHandle for SDK interaction */
  handle: QueryHandle;
  /** The MessageChannel for streaming input */
  channel: MessageChannel;
  /** When this session was created */
  createdAt: Date;
}

/**
 * Configuration for SessionManager.
 */
export interface SessionManagerConfig {
  /** Logger instance */
  logger: pino.Logger;
}

/**
 * SessionManager - Manages Pilot session lifecycle.
 *
 * Each chatId gets its own session containing a QueryHandle and MessageChannel.
 * This class handles:
 * - Creating new sessions
 * - Retrieving existing sessions
 * - Deleting sessions
 * - Tracking active session count
 */
export class SessionManager {
  private readonly logger: pino.Logger;
  private readonly sessions = new Map<string, PilotSession>();

  constructor(config: SessionManagerConfig) {
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
  get(chatId: string): PilotSession | undefined {
    return this.sessions.get(chatId);
  }

  /**
   * Get the QueryHandle for a chatId, if it exists.
   */
  getHandle(chatId: string): QueryHandle | undefined {
    return this.sessions.get(chatId)?.handle;
  }

  /**
   * Get the MessageChannel for a chatId, if it exists.
   */
  getChannel(chatId: string): MessageChannel | undefined {
    return this.sessions.get(chatId)?.channel;
  }

  /**
   * Create a new session for the chatId.
   *
   * @param chatId - The chat identifier
   * @param handle - The QueryHandle instance
   * @param channel - The MessageChannel instance
   * @returns The created session
   */
  create(chatId: string, handle: QueryHandle, channel: MessageChannel): PilotSession {
    const session: PilotSession = {
      handle,
      channel,
      createdAt: new Date(),
    };

    this.sessions.set(chatId, session);
    this.logger.debug({ chatId }, 'Session created');

    return session;
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

    // Close resources
    session.channel.close();
    session.handle.close();

    this.logger.debug({ chatId }, 'Session deleted');
    return true;
  }

  /**
   * Delete session tracking without closing resources.
   * Used when resources are already closed or will be closed externally.
   */
  deleteTracking(chatId: string): boolean {
    const existed = this.sessions.delete(chatId);
    if (existed) {
      this.logger.debug({ chatId }, 'Session tracking removed');
    }
    return existed;
  }

  /**
   * Close the channel for a session (keeps the QueryHandle alive).
   * Used during reset to stop the message generator.
   */
  closeChannel(chatId: string): boolean {
    const session = this.sessions.get(chatId);
    if (!session) {
      return false;
    }

    this.sessions.delete(chatId);
    session.channel.close();
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
   * Close all sessions and clear tracking.
   * Used during shutdown.
   */
  closeAll(): void {
    // Clear map FIRST
    const sessions = Array.from(this.sessions.entries());
    this.sessions.clear();

    // Then close all resources
    for (const [chatId, session] of sessions) {
      session.channel.close();
      session.handle.close();
      this.logger.debug({ chatId }, 'Session closed during shutdown');
    }

    this.logger.info('All sessions closed');
  }
}
