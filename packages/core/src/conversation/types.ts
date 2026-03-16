/**
 * Types for the conversation management layer.
 *
 * These types define the interfaces for the conversation components,
 * following the single responsibility principle and enabling
 * agent-agnostic conversation management.
 */

import type { FileRef } from '../types/file.js';

/**
 * Message queued for processing.
 */
export interface QueuedMessage {
  /** Message text content */
  text: string;
  /** Unique message identifier */
  messageId: string;
  /** Sender's open_id for @ mentions (optional) */
  senderOpenId?: string;
  /** Optional file attachments */
  attachments?: FileRef[];
}

/**
 * Session state for each chatId.
 *
 * This represents the full state needed for a conversation session,
 * including the message queue and context tracking.
 */
export interface SessionState {
  /** Queue of messages waiting to be processed */
  messageQueue: QueuedMessage[];
  /** Resolver for the queue consumer promise */
  messageResolver?: () => void;
  /** Whether the session has been closed */
  closed: boolean;
  /** Timestamp of last activity */
  lastActivity: number;
  /** Whether the session has started processing */
  started: boolean;
  /** Current thread root message ID for replies */
  currentThreadRootId?: string;
}

/**
 * Callbacks for session events.
 *
 * These callbacks allow the consumer to handle conversation events
 * without the conversation layer knowing about specific implementations.
 */
export interface SessionCallbacks {
  /**
   * Called when a message should be processed.
   * @param chatId - Platform-specific chat identifier
   * @param text - Message content
   * @param threadId - Optional thread ID for replies
   */
  onMessage: (chatId: string, text: string, threadId?: string) => Promise<void>;

  /**
   * Called when a file should be processed.
   * @param chatId - Platform-specific chat identifier
   * @param filePath - Local file path
   */
  onFile?: (chatId: string, filePath: string) => Promise<void>;

  /**
   * Called when the session is done processing a turn.
   * @param chatId - Platform-specific chat identifier
   * @param threadId - Optional thread ID for replies
   */
  onDone?: (chatId: string, threadId?: string) => Promise<void>;

  /**
   * Called when an error occurs.
   * @param chatId - Platform-specific chat identifier
   * @param error - The error that occurred
   * @param threadId - Optional thread ID for replies
   */
  onError?: (chatId: string, error: Error, threadId?: string) => Promise<void>;
}

/**
 * Options for creating a new session.
 */
export interface CreateSessionOptions {
  /** Platform-specific chat identifier */
  chatId: string;
  /** Initial message to queue (optional) */
  initialMessage?: QueuedMessage;
  /** Callbacks for session events */
  callbacks?: SessionCallbacks;
}

/**
 * Result of processing a message.
 */
export interface ProcessMessageResult {
  /** Whether the message was successfully queued */
  success: boolean;
  /** Queue length after adding the message */
  queueLength: number;
  /** Error if queuing failed */
  error?: Error;
}

/**
 * Statistics about a conversation session.
 */
export interface SessionStats {
  /** Chat ID for this session */
  chatId: string;
  /** Number of messages in queue */
  queueLength: number;
  /** Whether the session is closed */
  isClosed: boolean;
  /** When the session was created (ms since epoch) */
  createdAt: number;
  /** Time of last activity (ms since epoch) */
  lastActivity: number;
  /** Whether the session has started processing */
  started: boolean;
  /** Current thread root ID if set */
  threadRootId?: string;
}

/**
 * Message context for building enhanced content.
 * Renamed to avoid conflict with agents/conversation-context.ts MessageContext.
 */
export interface ConversationMessageContext {
  /** Platform-specific chat identifier */
  chatId: string;
  /** Unique message identifier */
  messageId: string;
  /** Sender's open_id for @ mentions (optional) */
  senderOpenId?: string;
  /** Optional file attachments */
  attachments?: FileRef[];
}
