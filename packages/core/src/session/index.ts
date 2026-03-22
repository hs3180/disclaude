/**
 * Temporary Session Management Module
 *
 * Provides file-based session management with state machine transitions.
 * Each session consists of session.md (config) + state.yaml (state).
 *
 * State machine: pending → sent → replied | expired
 *
 * Related issues: #393, #631, #946, #1317
 *
 * @module @disclaude/core/session
 */

export {
  SessionManager,
  parseDuration,
  isSessionExpired,
} from './session-manager.js';

export type {
  // Config types (session.md)
  SessionType,
  SessionPurpose,
  ChannelType,
  SessionChannelConfig,
  SessionOption,
  SessionConfig,

  // State types (state.yaml)
  SessionStatus,
  SessionResponse,
  SessionState,

  // Combined types
  TemporarySession,

  // Manager types
  SessionManagerOptions,
  CreateTemporarySessionOptions,
  SessionSummary,
  SessionFilterOptions,
} from './types.js';
