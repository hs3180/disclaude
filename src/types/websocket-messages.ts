/**
 * WebSocket message types for Communication Node and Execution Node communication.
 *
 * These types define the message format exchanged between the two nodes:
 * - Communication Node sends: PromptMessage, CommandMessage
 * - Execution Node sends: FeedbackMessage
 */

import type { FileRef } from '../file-transfer/types.js';

/**
 * Message sent from Communication Node to Execution Node when a user sends a prompt.
 */
export interface PromptMessage {
  type: 'prompt';
  chatId: string;
  prompt: string;
  messageId: string;
  senderOpenId?: string;
  /** Thread root message ID for thread replies */
  threadId?: string;
  /** File attachments (if any) */
  attachments?: FileRef[];
  /** Chat history context for passive mode (Issue #517) */
  chatHistoryContext?: string;
}

/**
 * Message sent from Communication Node to Execution Node for control commands.
 */
export interface CommandMessage {
  type: 'command';
  command: 'reset' | 'restart' | 'list-nodes' | 'switch-node';
  chatId: string;
  /** Target exec node ID for switch-node command */
  targetNodeId?: string;
}

/**
 * Message sent from Execution Node to Communication Node for registration.
 */
export interface RegisterMessage {
  type: 'register';
  /** Unique identifier for this exec node */
  nodeId: string;
  /** Human-readable name for this exec node */
  name?: string;
}

/**
 * Information about a connected execution node.
 */
export interface ExecNodeInfo {
  /** Unique identifier */
  nodeId: string;
  /** Human-readable name */
  name: string;
  /** Connection status */
  status: 'connected' | 'disconnected';
  /** Number of active chats assigned */
  activeChats: number;
  /** Connection time */
  connectedAt: Date;
}

/**
 * Message sent from Execution Node to Communication Node for feedback.
 */
export interface FeedbackMessage {
  type: 'text' | 'card' | 'file' | 'done' | 'error';
  chatId: string;
  text?: string;
  card?: Record<string, unknown>;
  error?: string;
  /** Thread root message ID for thread replies */
  threadId?: string;

  // ===== File transfer fields =====

  /** File reference */
  fileRef?: FileRef;

  /** File name (redundant field for convenience) */
  fileName?: string;

  /** File size (bytes) */
  fileSize?: number;

  /** MIME type */
  mimeType?: string;
}
