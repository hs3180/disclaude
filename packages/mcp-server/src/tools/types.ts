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
 * Result type for create_chat tool.
 */
export interface CreateChatResult {
  success: boolean;
  message: string;
  chatId?: string;
  name?: string;
  error?: string;
}

/**
 * Result type for dissolve_chat tool.
 */
export interface DissolveChatResult {
  success: boolean;
  message: string;
  chatId?: string;
  error?: string;
}

// ============================================================================
// Issue #1317: Temporary session types (JSON file-based, no Manager class)
// ============================================================================

/**
 * Temporary session status lifecycle.
 *
 * Transitions: pending → active → expired
 * - pending: Session file created, waiting for group chat creation + message send
 * - active: Group chat created and message sent, waiting for user response
 * - expired: User responded or session timed out
 */
export type SessionStatus = 'pending' | 'active' | 'expired';

/**
 * Interactive option stored in session JSON.
 * Subset of InteractiveOption with only serializable fields.
 */
export interface SessionOption {
  text: string;
  value: string;
  type?: 'primary' | 'default' | 'danger';
}

/**
 * Temporary session file format (JSON).
 *
 * Each session is stored as a single JSON file in workspace/temporary-sessions/.
 * File naming: {sanitized-session-id}.json
 *
 * @see https://github.com/hs3180/disclaude/issues/1317
 */
export interface TemporarySession {
  /** Unique session identifier */
  sessionId: string;
  /** Current session status */
  status: SessionStatus;
  /** Target chat ID (null until group is created) */
  chatId: string | null;
  /** Message ID of the interactive card (null until sent) */
  messageId: string | null;
  /** ISO timestamp when the session was created */
  createdAt: string;
  /** ISO timestamp when the session was last updated */
  updatedAt: string;
  /** ISO timestamp when the session expires */
  expiresAt: string;
  /** The discussion topic/title */
  topic: string;
  /** The message content sent to the user */
  message: string;
  /** Interactive button options for user response */
  options: SessionOption[];
  /** Action prompts mapping (action value → prompt template) */
  actionPrompts: ActionPromptMap;
  /** Use-case specific context (e.g., PR number, repository) */
  context: Record<string, unknown>;
  /** User's response (null until user interacts) */
  response: {
    /** The action value the user selected */
    value: string | null;
    /** The display text of the selected action */
    text: string | null;
    /** ISO timestamp when the user responded */
    respondedAt: string | null;
  } | null;
}

/**
 * Result type for start_discussion tool.
 */
export interface StartDiscussionResult {
  success: boolean;
  message: string;
  sessionId?: string;
  chatId?: string;
  error?: string;
}

/**
 * Result type for check_discussion tool.
 */
export interface CheckDiscussionResult {
  success: boolean;
  message: string;
  session?: TemporarySession;
  error?: string;
}

/**
 * Result type for list_discussions tool.
 */
export interface ListDiscussionsResult {
  success: boolean;
  message: string;
  sessions?: TemporarySession[];
  error?: string;
}
