/**
 * Shared type definitions for Feishu MCP tools.
 *
 * @module mcp/tools/types
 */

/**
 * Result type for send_user_feedback tool.
 */
export interface SendFeedbackResult {
  success: boolean;
  message: string;
  error?: string;
}

/**
 * Result type for send_file_to_feishu tool.
 */
export interface SendFileResult {
  success: boolean;
  message: string;
  fileName?: string;
  fileSize?: number;
  sizeMB?: string;
  error?: string;
  feishuCode?: string | number;
  feishuMsg?: string;
  feishuLogId?: string;
  troubleshooterUrl?: string;
}

/**
 * Result type for update_card tool.
 */
export interface UpdateCardResult {
  success: boolean;
  message: string;
  error?: string;
}

/**
 * Result type for wait_for_interaction tool.
 */
export interface WaitForInteractionResult {
  success: boolean;
  message: string;
  actionValue?: string;
  actionType?: string;
  userId?: string;
  error?: string;
}

/**
 * Message sent callback type.
 * Called when a message is successfully sent to track user communication.
 */
export type MessageSentCallback = (chatId: string) => void;

/**
 * Pending interaction tracker for wait_for_interaction tool.
 */
export interface PendingInteraction {
  messageId: string;
  chatId: string;
  resolve: (action: { actionValue: string; actionType: string; userId: string }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}
