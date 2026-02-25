/**
 * WebSocket message types for Communication Node and Execution Node communication.
 *
 * These types define the message format exchanged between the two nodes:
 * - Communication Node sends: PromptMessage, CommandMessage
 * - Execution Node sends: FeedbackMessage
 */

/**
 * Message sent from Communication Node to Execution Node when a user sends a prompt.
 */
export interface PromptMessage {
  type: 'prompt';
  chatId: string;
  prompt: string;
  messageId: string;
  senderOpenId?: string;
  /** Parent message ID for thread replies */
  parentId?: string;
}

/**
 * Message sent from Communication Node to Execution Node for control commands.
 */
export interface CommandMessage {
  type: 'command';
  command: 'reset' | 'restart';
  chatId: string;
}

/**
 * Message sent from Execution Node to Communication Node for feedback.
 */
export interface FeedbackMessage {
  type: 'text' | 'card' | 'file' | 'done' | 'error';
  chatId: string;
  text?: string;
  card?: Record<string, unknown>;
  filePath?: string;
  error?: string;
  /** Parent message ID for thread replies */
  parentId?: string;
}
