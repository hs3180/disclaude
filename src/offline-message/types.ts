/**
 * Offline Message Types - Type definitions for non-blocking communication.
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 *
 * This module defines types for the offline messaging system that allows
 * agents to send messages without blocking and trigger new tasks when
 * users reply.
 */

/**
 * Context information included in offline messages.
 * Provides enough context for the follow-up task to understand the situation.
 */
export interface OfflineMessageContext {
  /** Original task or conversation topic */
  topic: string;
  /** Key question or issue being raised */
  question: string;
  /** Additional context data (JSON serializable) */
  metadata?: Record<string, unknown>;
  /** Original chatId where the task was running */
  sourceChatId: string;
  /** Timestamp when the message was sent */
  createdAt: number;
}

/**
 * Callback configuration for handling user replies.
 * Defines what happens when a user responds to an offline message.
 */
export interface OfflineMessageCallback {
  /** Type of callback to trigger */
  type: 'new_task' | 'continue_task' | 'custom';
  /** Prompt template for the follow-up task */
  promptTemplate: string;
  /** Optional skill to invoke */
  skill?: string;
  /** Maximum time to wait for a reply (in milliseconds) */
  timeoutMs?: number;
}

/**
 * Registered offline message entry.
 * Tracks an offline message waiting for a user reply.
 */
export interface OfflineMessageEntry {
  /** Unique identifier for this offline message */
  id: string;
  /** Feishu message ID of the sent card */
  messageId: string;
  /** Chat ID where the message was sent */
  chatId: string;
  /** Context information for the follow-up task */
  context: OfflineMessageContext;
  /** Callback configuration */
  callback: OfflineMessageCallback;
  /** When this entry was created */
  createdAt: number;
  /** When this entry expires (no reply expected after this) */
  expiresAt: number;
}

/**
 * Result of sending an offline message.
 */
export interface SendOfflineMessageResult {
  success: boolean;
  message: string;
  /** ID of the registered offline message entry */
  entryId?: string;
  /** Feishu message ID of the sent card */
  messageId?: string;
  error?: string;
}

/**
 * Result of handling a user reply.
 */
export interface ReplyHandleResult {
  success: boolean;
  /** Whether a matching offline message was found */
  matched: boolean;
  /** ID of the triggered task (if any) */
  triggeredTaskId?: string;
  error?: string;
}

/**
 * Options for the OfflineMessageManager.
 */
export interface OfflineMessageManagerOptions {
  /** Default timeout for offline messages (default: 24 hours) */
  defaultTimeoutMs?: number;
  /** Cleanup interval for expired entries (default: 1 hour) */
  cleanupIntervalMs?: number;
  /** Maximum number of pending offline messages per chat */
  maxPerChat?: number;
}
