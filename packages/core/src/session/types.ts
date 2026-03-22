/**
 * Temporary Session types for the session management system.
 *
 * Provides a file-based "ask user → wait for response → get response" workflow.
 * Each session is stored as a single YAML file with a three-state lifecycle:
 * pending → active → expired
 *
 * @module core/session/types
 * @see Issue #1391
 */

/**
 * Session status in the three-state lifecycle.
 *
 * ```
 * pending ──(group created)──> active ──(timeout/response)──> expired
 * ```
 */
export type SessionStatus = 'pending' | 'active' | 'expired';

/**
 * How the session ended.
 */
export type SessionEndReason = 'timeout' | 'response' | 'cancelled';

/**
 * Configuration for creating a group chat for the session.
 */
export interface SessionCreateGroup {
  /** Group name/topic */
  name: string;
  /** Member open_ids to add to the group */
  members: string[];
}

/**
 * An option that the user can select from the interactive card.
 */
export interface SessionOption {
  /** Internal value returned when selected */
  value: string;
  /** Display text on the button */
  text: string;
}

/**
 * The user's response to the session.
 */
export interface SessionResponse {
  /** The selected option value */
  selectedValue: string;
  /** The display text of the selected option */
  selectedText?: string;
  /** Open ID of the responder */
  responder: string;
  /** ISO timestamp of when the response was given */
  repliedAt: string;
}

/**
 * Metadata for the session expiration.
 */
export interface SessionExpiry {
  /** How the session ended */
  reason: SessionEndReason;
  /** ISO timestamp of expiration */
  expiredAt: string;
}

/**
 * A temporary session file structure.
 *
 * Stored as a YAML file in the `workspace/temporary-sessions/` directory.
 *
 * @example
 * ```yaml
 * id: pr-123
 * status: pending
 * chatId: null
 * messageId: null
 * expiresAt: 2026-03-11T10:00:00Z
 * createGroup:
 *   name: "PR #123: Fix auth bug"
 *   members:
 *     - ou_developer
 * message: "Please review this PR"
 * options:
 *   - value: merge
 *     text: "✓ 合并"
 * context:
 *   prNumber: 123
 * response: null
 * expiry: null
 * createdAt: 2026-03-10T09:00:00Z
 * updatedAt: 2026-03-10T09:00:00Z
 * ```
 */
export interface TemporarySession {
  /** Unique session identifier */
  id: string;
  /** Current status in the lifecycle */
  status: SessionStatus;
  /** Group chat ID (null until group is created) */
  chatId: string | null;
  /** Message ID of the sent interactive card (null until message is sent) */
  messageId: string | null;
  /** ISO timestamp for when the session should expire */
  expiresAt: string;
  /** Configuration for group creation (if needed) */
  createGroup?: SessionCreateGroup;
  /** Message content to send to the group */
  message: string;
  /** Available options for the user to select */
  options: SessionOption[];
  /** Additional context data (arbitrary, caller-defined) */
  context?: Record<string, unknown>;
  /** User response (null until user responds) */
  response: SessionResponse | null;
  /** Expiration metadata (null until session expires) */
  expiry: SessionExpiry | null;
  /** ISO timestamp of session creation */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
}

/**
 * Options for creating a new temporary session.
 */
export interface CreateTemporarySessionOptions {
  /** Unique session identifier */
  id: string;
  /** ISO timestamp for when the session should expire */
  expiresAt: string;
  /** Configuration for group creation (optional - if omitted, uses existing chat) */
  createGroup?: SessionCreateGroup;
  /** Message content to send */
  message: string;
  /** Available options for the user */
  options: SessionOption[];
  /** Additional context data */
  context?: Record<string, unknown>;
}

/**
 * Summary of session for display purposes.
 */
export interface SessionSummary {
  id: string;
  status: SessionStatus;
  chatId: string | null;
  expiresAt: string;
  hasResponse: boolean;
  endReason?: SessionEndReason;
  createdAt: string;
  updatedAt: string;
}
