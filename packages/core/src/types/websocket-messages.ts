/**
 * WebSocket message types for Communication Node and Execution Node communication.
 *
 * These types define the message format exchanged between the two nodes:
 * - Communication Node sends: PromptMessage, CommandMessage
 * - Execution Node sends: FeedbackMessage
 */

import type { FileRef } from './file.js';

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
 *
 * Note: Only commands that need to be forwarded to Execution Nodes are listed here.
 * Commands like 'switch-node' are handled on Primary Node only and intentionally excluded.
 */
export interface CommandMessage {
  type: 'command';
  command: 'reset' | 'restart' | 'list-nodes';
  chatId: string;
  /** Whether to keep context when resetting (Issue #1213) */
  keepContext?: boolean;
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

/**
 * Message sent from Communication Node to Execution Node when a card action occurs.
 * This enables Worker Node to receive card interaction callbacks from Primary Node.
 *
 * Issue #935: WebSocket bidirectional communication for card actions.
 */
export interface CardActionMessage {
  type: 'card_action';
  /** Chat ID where the card was displayed */
  chatId: string;
  /** The card message ID in Feishu */
  cardMessageId: string;
  /** Action type (button, select_static, etc.) */
  actionType: string;
  /** Action value from the button/menu */
  actionValue: string;
  /** Display text of the action (optional) */
  actionText?: string;
  /** User who triggered the action */
  userId?: string;
  /**
   * Resolved prompt from InteractiveContextStore (Issue #1629).
   * When Primary Node routes card actions to remote Worker Nodes,
   * it resolves the prompt template before forwarding so the
   * Worker Node can use the contextual message instead of a
   * generic default.
   */
  resolvedPrompt?: string;
  /** Full action data for complex interactions */
  action?: {
    type: string;
    value: string;
    text?: string;
    trigger?: string;
  };
}

/**
 * Message sent from Communication Node to Execution Node for card context registration.
 * After a card is sent successfully, Primary Node notifies Worker Node of the message ID.
 *
 * Issue #935: WebSocket bidirectional communication for card actions.
 */
export interface CardContextMessage {
  type: 'card_context';
  /** Chat ID where the card was sent */
  chatId: string;
  /** The card message ID returned by Feishu */
  cardMessageId: string;
  /** Node ID that sent the card (for routing callbacks) */
  nodeId: string;
}
