/**
 * Shared type definitions for MCP tools.
 *
 * @module mcp/tools/types
 */

/**
 * Result type for send_message tool.
 */
export interface SendMessageResult {
  success: boolean;
  message: string;
  error?: string;
}

/**
 * Result type for send_file tool.
 */
export interface SendFileResult {
  success: boolean;
  message: string;
  fileName?: string;
  fileSize?: number;
  sizeMB?: string;
  error?: string;
  platformCode?: string | number;
  platformMsg?: string;
  platformLogId?: string;
  troubleshooterUrl?: string;
}

/**
 * Message sent callback type.
 * Called when a message is successfully sent to track user communication.
 */
export type MessageSentCallback = (chatId: string) => void;

/**
 * Map of action values to prompt templates.
 * Keys are action values from button/menu components.
 * Values are prompt templates that can include placeholders:
 * - {{actionText}} - The display text of the clicked button/option
 * - {{actionValue}} - The value of the action
 * - {{actionType}} - The type of action (button, select_static, etc.)
 * - {{form.fieldName}} - Form field values (for form submissions)
 */
export type ActionPromptMap = Record<string, string>;

/**
 * Context for an interactive message.
 */
export interface InteractiveMessageContext {
  messageId: string;
  chatId: string;
  actionPrompts: ActionPromptMap;
  createdAt: number;
}

/**
 * Result type for send_interactive_message tool.
 */
export interface SendInteractiveResult {
  success: boolean;
  message: string;
  messageId?: string;
  error?: string;
}

