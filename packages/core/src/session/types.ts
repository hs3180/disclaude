/**
 * Temporary Session Types.
 *
 * Defines the types for the temporary session management system.
 * Sessions enable "ask user → wait for response → get response" workflows.
 *
 * @see Issue #1391 - 临时会话管理系统（简化版设计）
 * @see Issue #393 - PR Scanner
 * @see Issue #631 - 离线提问
 * @see Issue #946 - 御书房体验
 */

/**
 * Session status.
 * - pending: Waiting for group chat creation
 * - active: Group chat created, waiting for user response
 * - expired: Session ended (user responded or timeout)
 */
export type SessionStatus = 'pending' | 'active' | 'expired';

/**
 * Group chat creation configuration.
 */
export interface SessionCreateGroup {
  /** Group chat name/topic */
  name: string;
  /** Initial member open_ids */
  members: string[];
}

/**
 * User response option.
 */
export interface SessionOption {
  /** Option value (used as action value) */
  value: string;
  /** Display text */
  text: string;
}

/**
 * User response data.
 */
export interface SessionResponse {
  /** Selected option value */
  selectedValue: string;
  /** Responder open_id */
  responder: string;
  /** Response timestamp */
  repliedAt: string;
}

/**
 * Context data for the session (customizable by caller).
 */
export interface SessionContext {
  [key: string]: unknown;
}

/**
 * Temporary session data structure.
 *
 * This is stored as a YAML file in temporary-sessions/ directory.
 */
export interface TemporarySession {
  // === Status ===
  /** Session status */
  status: SessionStatus;
  /** Group chat ID (filled after creation) */
  chatId: string | null;
  /** Message ID (filled after sending) */
  messageId: string | null;
  /** Session expiration time (ISO string) */
  expiresAt: string;

  // === Configuration (set at creation) ===
  /** Group chat creation config */
  createGroup: SessionCreateGroup;
  /** Message content to send */
  message: string;
  /** User response options */
  options: SessionOption[];
  /** Custom context data */
  context: SessionContext;

  // === Response (filled after user action) ===
  /** User response (null if not responded) */
  response: SessionResponse | null;
}

/**
 * Options for creating a new temporary session.
 */
export interface CreateTempSessionOptions {
  /** Session ID (filename without .yaml extension) */
  id: string;
  /** Group chat creation config */
  createGroup: SessionCreateGroup;
  /** Message content to send */
  message: string;
  /** User response options */
  options?: SessionOption[];
  /** Custom context data */
  context?: SessionContext;
  /** Timeout in minutes (default: 60) */
  timeoutMinutes?: number;
}

/**
 * Session file storage format.
 * Matches the YAML file structure.
 */
export type SessionFile = TemporarySession;
