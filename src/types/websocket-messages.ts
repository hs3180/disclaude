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

/**
 * Action prompt map for interactive cards.
 * Maps action values to prompt templates.
 */
export interface ActionPromptMap {
  [actionValue: string]: string;
}

/**
 * Message sent from Execution Node to Communication Node to register card context.
 * Issue #935: Enables Worker Node to receive card action callbacks through Primary Node.
 */
export interface CardContextMessage {
  type: 'card_context';
  /** The card message ID (assigned by Feishu) */
  messageId: string;
  chatId: string;
  /** Map of action values to prompt templates */
  actionPrompts: ActionPromptMap;
  /** Worker Node ID that sent this context */
  nodeId: string;
}

/**
 * Message sent from Communication Node to Execution Node when a card action is triggered.
 * Issue #935: Routes card action callbacks from Primary Node to Worker Node.
 */
export interface CardActionMessage {
  type: 'card_action';
  /** The card message ID */
  messageId: string;
  chatId: string;
  /** Action value from the button/menu */
  actionValue: string;
  /** Display text of the action */
  actionText?: string;
  /** Action type (button, select_static, etc.) */
  actionType?: string;
  /** User who triggered the action */
  userId?: string;
  /** Form data if the action includes form inputs */
  formData?: Record<string, unknown>;
}

/**
 * Union type for all WebSocket message types.
 */
export type WebSocketMessage =
  | PromptMessage
  | CommandMessage
  | RegisterMessage
  | FeedbackMessage
  | CardContextMessage
  | CardActionMessage;
