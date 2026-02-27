/**
 * Conversation Layer - Unified Type Definitions.
 *
 * These types provide a platform-agnostic abstraction for conversation management.
 * They decouple the conversation logic from specific agent implementations (Claude, OpenAI, etc.)
 * and platform-specific concerns (Feishu, REST API, etc.)
 */

import type { FileRef } from '../file-transfer/types.js';

/**
 * Message queued for processing.
 *
 * Represents a user message waiting to be processed by the agent.
 * This is the input type for the message queue.
 */
export interface QueuedMessage {
  /** The text content of the message */
  text: string;
  /** Unique identifier for this message */
  messageId: string;
  /** Sender's platform-specific identifier (e.g., Feishu open_id) */
  senderOpenId?: string;
  /** Optional file attachments */
  attachments?: FileRef[];
}

/**
 * Session state for a conversation.
 *
 * Tracks all state needed for a single conversation session.
 * This interface is used by the session manager to maintain per-chat state.
 */
export interface SessionState<T = unknown> {
  /** Messages queued for processing */
  messageQueue: QueuedMessage[];
  /** Resolver for the pending promise when waiting for messages */
  messageResolver?: () => void;
  /** The active query/agent instance (type varies by implementation) */
  queryInstance?: T;
  /** Files pending write operations */
  pendingWriteFiles: Set<string>;
  /** Whether the session has been explicitly closed */
  closed: boolean;
  /** Timestamp of last activity (for timeout/health checks) */
  lastActivity: number;
  /** Whether the session has started processing */
  started: boolean;
  /** Current thread root ID for reply threading */
  currentThreadRootId?: string;
}

/**
 * Callbacks for session events.
 *
 * These callbacks are provided by the platform layer (e.g., Pilot)
 * to handle session lifecycle events.
 */
export interface SessionCallbacks {
  /** Called when a message should be sent to the user */
  onMessage: (chatId: string, text: string, threadId?: string) => Promise<void>;
  /** Called when a file should be processed */
  onFile?: (chatId: string, filePath: string) => Promise<void>;
  /** Called when the session completes normally */
  onDone?: (chatId: string, threadId?: string) => Promise<void>;
  /** Called when an error occurs during processing */
  onError?: (chatId: string, error: Error, threadId?: string) => Promise<void>;
}

/**
 * Configuration for creating a new session.
 */
export interface CreateSessionOptions {
  /** Platform-specific chat identifier */
  chatId: string;
  /** Optional initial message to process */
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
 * Statistics about the conversation layer.
 */
export interface ConversationStats {
  /** Total number of active sessions */
  activeSessions: number;
  /** Total number of queued messages across all sessions */
  totalQueuedMessages: number;
  /** List of active chat IDs */
  activeChatIds: string[];
}

/**
 * Options for the conversation orchestrator.
 */
export interface ConversationOrchestratorOptions {
  /** Maximum time to wait for a message before considering session idle (ms) */
  idleTimeoutMs?: number;
  /** Maximum number of retries on failure */
  maxRetries?: number;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Message context for building enhanced content.
 */
export interface MessageContext {
  /** Platform-specific chat identifier */
  chatId: string;
  /** Unique message identifier */
  messageId: string;
  /** Sender's open_id for @ mentions (optional) */
  senderOpenId?: string;
  /** Optional file attachments */
  attachments?: FileRef[];
}
