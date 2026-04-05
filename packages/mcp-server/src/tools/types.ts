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
 * Interactive message option configuration.
 * Used by send_interactive_message to define button options.
 */
export interface InteractiveOption {
  /** Button display text */
  text: string;
  /** Action value (plain string, used as action prompt key) */
  value: string;
  /** Button style */
  type?: 'primary' | 'default' | 'danger';
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

/**
 * Result type for register_temp_chat tool.
 * Issue #1703: Temp chat lifecycle management.
 */
export interface RegisterTempChatResult {
  success: boolean;
  message: string;
  chatId?: string;
  expiresAt?: string;
  error?: string;
}

/**
 * Result type for upload_image tool.
 * Issue #1919: Image upload for card embedding.
 */
export interface UploadImageResult {
  success: boolean;
  message: string;
  imageKey?: string;
  fileName?: string;
  fileSize?: number;
  sizeMB?: string;
  error?: string;
  platformCode?: string | number;
  platformMsg?: string;
}

