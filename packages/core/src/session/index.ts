/**
 * Temporary Session Management module.
 *
 * Provides a file-based "ask user → wait for response → get response" workflow.
 * Each session follows a three-state lifecycle: pending → active → expired.
 *
 * @module core/session
 * @see Issue #1391
 */

// Types
export type {
  SessionStatus,
  SessionEndReason,
  SessionCreateGroup,
  SessionOption,
  SessionResponse,
  SessionExpiry,
  TemporarySession,
  CreateTemporarySessionOptions,
  SessionSummary,
} from './types.js';

// Session Manager
export {
  TemporarySessionManager,
  type TemporarySessionManagerOptions,
} from './session-manager.js';
