/**
 * Temporary Session Types - Type definitions for the temporary session system.
 *
 * Issue #1391: Simplified temporary session management using JSON files.
 *
 * Three-state lifecycle: pending → active → expired
 *
 * - pending: Session created, waiting for group chat creation
 * - active: Group chat created, waiting for user response
 * - expired: Session ended (user responded OR timed out)
 */

/**
 * Session status enum.
 */
export type SessionStatus = 'pending' | 'active' | 'expired';

/**
 * Group chat creation configuration.
 * Used when creating a new session that requires a group chat.
 */
export interface CreateGroupConfig {
  /** Group chat name */
  name: string;
  /** Member open IDs to invite */
  members?: string[];
}

/**
 * Interactive option for user selection.
 */
export interface SessionOption {
  /** Value returned when selected */
  value: string;
  /** Display text */
  text: string;
}

/**
 * User response data, filled when user interacts with the session.
 */
export interface SessionResponse {
  /** Selected option value */
  selectedValue: string;
  /** Open ID of the responder */
  responder: string;
  /** ISO timestamp of response */
  repliedAt: string;
}

/**
 * Temporary session file format (JSON).
 *
 * Stored in: workspace/temporary-sessions/{session-id}.json
 *
 * @example
 * ```json
 * {
 *   "id": "pr-123-review",
 *   "status": "pending",
 *   "chatId": null,
 *   "messageId": null,
 *   "expiresAt": "2026-03-11T10:00:00Z",
 *   "createGroup": {
 *     "name": "PR #123: Fix auth bug",
 *     "members": ["ou_developer"]
 *   },
 *   "message": "Please review PR #123",
 *   "options": [
 *     { "value": "merge", "text": "✓ Merge" },
 *     { "value": "close", "text": "✗ Close" }
 *   ],
 *   "context": { "prNumber": 123 },
 *   "response": null,
 *   "createdAt": "2026-03-10T10:00:00Z",
 *   "updatedAt": "2026-03-10T10:00:00Z"
 * }
 * ```
 */
export interface TemporarySession {
  /** Unique session identifier */
  id: string;

  /** Current status */
  status: SessionStatus;

  /** Group chat ID (filled after group creation) */
  chatId: string | null;

  /** Message ID of the interactive card (filled after message sent) */
  messageId: string | null;

  /** ISO timestamp when the session expires */
  expiresAt: string;

  /** Group chat creation config (only for sessions requiring group creation) */
  createGroup?: CreateGroupConfig;

  /** Message content to display to the user */
  message: string;

  /** Interactive options for user selection */
  options?: SessionOption[];

  /** Arbitrary context data for the caller */
  context?: Record<string, unknown>;

  /** User response (filled when user interacts) */
  response: SessionResponse | null;

  /** ISO timestamp of creation */
  createdAt: string;

  /** ISO timestamp of last update */
  updatedAt: string;
}

/**
 * Options for creating a new temporary session.
 */
export interface CreateTemporarySessionOptions {
  /** Session identifier (must be unique) */
  id: string;

  /** Message content to display */
  message: string;

  /** Interactive options */
  options?: SessionOption[];

  /** Group chat creation config */
  createGroup?: CreateGroupConfig;

  /** Expiration time in minutes (default: 60) */
  timeoutMinutes?: number;

  /** Arbitrary context data */
  context?: Record<string, unknown>;
}
