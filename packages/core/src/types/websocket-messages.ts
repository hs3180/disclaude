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
  /** Whether this is a local execution capability */
  isLocal?: boolean;
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

/**
 * Feishu API action types supported by the WS routing.
 * Issue #1036: WebSocket request routing (WorkerNode → PrimaryNode)
 */
export type FeishuApiAction = 'sendMessage' | 'sendCard' | 'uploadFile';

/**
 * Message sent from Worker Node to Primary Node for Feishu API requests.
 * Enables Worker Node to make Feishu API calls via Primary Node's LarkClientService.
 *
 * Issue #1036: WebSocket request routing (WorkerNode → PrimaryNode)
 */
export interface FeishuApiRequestMessage {
  type: 'feishu-api-request';
  /** Unique request ID for response matching */
  requestId: string;
  /** Action to perform */
  action: FeishuApiAction;
  /** Action parameters */
  params: {
    chatId?: string;
    text?: string;
    card?: Record<string, unknown>;
    filePath?: string;
    threadId?: string;
    description?: string;
  };
}

/**
 * Message sent from Primary Node to Worker Node for Feishu API responses.
 *
 * Issue #1036: WebSocket request routing (WorkerNode → PrimaryNode)
 */
export interface FeishuApiResponseMessage {
  type: 'feishu-api-response';
  /** Request ID matching the original request */
  requestId: string;
  /** Whether the request was successful */
  success: boolean;
  /** Response data (on success) */
  data?: unknown;
  /** Error message (on failure) */
  error?: string;
}
