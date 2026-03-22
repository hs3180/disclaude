/**
 * Temporary Session Management Types
 *
 * Defines the type system for the temporary session management feature.
 * Sessions follow a file-based approach: session.md (static config) + state.yaml (dynamic state).
 *
 * State machine: pending → sent → replied | expired
 *
 * Related issues: #393, #631, #946, #1317
 *
 * @module @disclaude/core/session
 */

// ============================================================================
// Session Configuration (session.md - static)
// ============================================================================

/**
 * Session type determines blocking behavior.
 */
export type SessionType = 'blocking' | 'non-blocking';

/**
 * Session purpose defines the use case.
 */
export type SessionPurpose = 'pr-review' | 'offline-question' | 'agent-confirm' | 'custom';

/**
 * Channel creation strategy.
 */
export type ChannelType = 'group' | 'private' | 'existing';

/**
 * Channel configuration for session message delivery.
 */
export interface SessionChannelConfig {
  /** Channel creation strategy */
  type: ChannelType;
  /** Group name (for type=group) */
  name?: string;
  /** Existing chat ID (for type=existing) */
  chatId?: string;
  /** Member open IDs to add (for type=group) */
  members?: string[];
}

/**
 * Session option for interactive cards.
 */
export interface SessionOption {
  /** Option value returned on click */
  value: string;
  /** Display text for the button */
  text: string;
  /** Button style: primary, default, danger */
  style?: 'primary' | 'default' | 'danger';
  /** Optional action prompt template */
  actionPrompt?: string;
}

/**
 * Static session configuration stored in session.md.
 *
 * Uses YAML frontmatter + Markdown format, consistent with the
 * existing schedule file pattern in the codebase.
 */
export interface SessionConfig {
  /** Session type: blocking or non-blocking */
  type: SessionType;
  /** Session purpose for categorization */
  purpose: SessionPurpose;
  /** Channel configuration */
  channel: SessionChannelConfig;
  /** Custom context data (e.g., PR number, repository) */
  context?: Record<string, unknown>;
  /** Session expiration duration (e.g., '24h', '30m', '1d') */
  expiresIn: string;
  /** Interactive options for user response */
  options?: SessionOption[];
}

// ============================================================================
// Session State (state.yaml - dynamic)
// ============================================================================

/**
 * Session status following the state machine: pending → sent → replied | expired
 */
export type SessionStatus = 'pending' | 'sent' | 'replied' | 'expired';

/**
 * User response data recorded when user interacts with the session.
 */
export interface SessionResponse {
  /** Selected option value */
  selectedValue: string;
  /** Responder open ID */
  responder: string;
  /** Response timestamp (ISO 8601) */
  repliedAt: string;
  /** Optional text input from user */
  textInput?: string;
}

/**
 * Dynamic session state stored in state.yaml.
 *
 * Updated by the management schedule and card click handlers.
 */
export interface SessionState {
  /** Current status in the state machine */
  status: SessionStatus;
  /** Chat ID where message was sent (filled after activation) */
  chatId?: string;
  /** Message ID of the sent interactive card (filled after activation) */
  messageId?: string;
  /** Session creation timestamp (ISO 8601) */
  createdAt: string;
  /** Message sent timestamp (ISO 8601) */
  sentAt?: string;
  /** Session expiration timestamp (ISO 8601) */
  expiresAt?: string;
  /** Response data (filled when user responds) */
  response?: SessionResponse;
}

// ============================================================================
// Combined Session
// ============================================================================

/**
 * Complete session combining static config and dynamic state.
 */
export interface TemporarySession {
  /** Unique session identifier (derived from folder name) */
  id: string;
  /** Session configuration (from session.md) */
  config: SessionConfig;
  /** Session state (from state.yaml) */
  state: SessionState;
  /** Path to session folder on disk */
  folderPath: string;
}

// ============================================================================
// Session Manager Options & Results
// ============================================================================

/**
 * Options for creating a new temporary session.
 */
export interface CreateTemporarySessionOptions {
  /** Session ID (used as folder name). Auto-generated if not provided */
  id?: string;
  /** Session configuration */
  config: SessionConfig;
  /** Directory where sessions are stored */
  sessionsDir?: string;
}

/**
 * Options for SessionManager initialization.
 */
export interface SessionManagerOptions {
  /** Base directory for temporary sessions */
  sessionsDir: string;
}

/**
 * Session summary for listing purposes.
 */
export interface SessionSummary {
  /** Session ID */
  id: string;
  /** Current status */
  status: SessionStatus;
  /** Session purpose */
  purpose: SessionPurpose;
  /** Session type */
  type: SessionType;
  /** Channel name or chat ID */
  channelTarget: string;
  /** Creation time */
  createdAt: string;
  /** Expiration time */
  expiresAt?: string;
  /** Whether session has a response */
  hasResponse: boolean;
}

/**
 * Session filter options for listing.
 */
export interface SessionFilterOptions {
  /** Filter by status */
  status?: SessionStatus;
  /** Filter by purpose */
  purpose?: SessionPurpose;
  /** Include expired sessions (default: false) */
  includeExpired?: boolean;
  /** Maximum number of sessions to return */
  limit?: number;
}
