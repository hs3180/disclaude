/**
 * Temporary Session module - Simplified session management using JSON files.
 *
 * Issue #1391: File-based temporary session system for the
 * "ask user → wait for response → get response" pattern.
 *
 * Three-state lifecycle: pending → active → expired
 *
 * @module temporary-session
 */

export type {
  SessionStatus,
  TemporarySession,
  CreateGroupConfig,
  SessionOption,
  SessionResponse,
  CreateTemporarySessionOptions,
} from './types.js';

export {
  getSessionDir,
  getSessionFilePath,
  ensureSessionDir,
  createSession,
  readSession,
  writeSession,
  updateSessionStatus,
  activateSession,
  respondToSession,
  expireSession,
  listSessions,
  listTimedOutSessions,
  findSessionByMessageId,
  deleteSession,
} from './session-store.js';
