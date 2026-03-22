/**
 * Temporary Session Manager.
 *
 * Manages temporary sessions stored as YAML files.
 * Provides utilities for creating, reading, updating, and querying sessions.
 *
 * @see Issue #1391 - 临时会话管理系统（简化版设计）
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { createLogger } from '../utils/logger.js';
import type {
  TemporarySession,
  CreateTempSessionOptions,
  SessionStatus,
  SessionResponse,
} from './types.js';

const logger = createLogger('SessionManager');

/**
 * Default sessions directory (relative to workspace).
 */
const DEFAULT_SESSIONS_DIR = 'temporary-sessions';

/**
 * Get the sessions directory path.
 */
export function getSessionsDir(): string {
  // Use WORKSPACE_DIR if set, otherwise use current directory
  const workspaceDir = process.env.WORKSPACE_DIR || process.cwd();
  return path.join(workspaceDir, DEFAULT_SESSIONS_DIR);
}

/**
 * Ensure the sessions directory exists.
 */
export function ensureSessionsDir(): void {
  const sessionsDir = getSessionsDir();
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
    logger.info({ path: sessionsDir }, 'Created sessions directory');
  }
}

/**
 * Get session file path.
 *
 * @param sessionId - Session ID (filename without .yaml)
 */
export function getSessionFilePath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}.yaml`);
}

/**
 * Create a new session.
 *
 * @param options - Session creation options
 * @returns The created session
 */
export function createSession(options: CreateTempSessionOptions): TemporarySession {
  const {
    id,
    createGroup,
    message,
    options: sessionOptions = [],
    context = {},
    timeoutMinutes = 60,
  } = options;

  ensureSessionsDir();

  const expiresAt = new Date(Date.now() + timeoutMinutes * 60 * 1000).toISOString();

  const session: TemporarySession = {
    status: 'pending',
    chatId: null,
    messageId: null,
    expiresAt,
    createGroup,
    message,
    options: sessionOptions,
    context,
    response: null,
  };

  const filePath = getSessionFilePath(id);

  // Check if session already exists
  if (fs.existsSync(filePath)) {
    throw new Error(`Session '${id}' already exists`);
  }

  // Write session file
  writeSession(id, session);

  logger.info({ sessionId: id, expiresAt }, 'Session created');
  return session;
}

/**
 * Read a session by ID.
 *
 * @param sessionId - Session ID
 * @returns The session or null if not found
 */
export function readSession(sessionId: string): TemporarySession | null {
  const filePath = getSessionFilePath(sessionId);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const session = yaml.load(content) as TemporarySession;
    return session;
  } catch (error) {
    logger.error({ err: error, sessionId }, 'Failed to read session');
    return null;
  }
}

/**
 * Write a session to file.
 *
 * @param sessionId - Session ID
 * @param session - Session data
 */
export function writeSession(sessionId: string, session: TemporarySession): void {
  ensureSessionsDir();

  const filePath = getSessionFilePath(sessionId);
  const content = yaml.dump(session, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
  });

  fs.writeFileSync(filePath, content, 'utf-8');
  logger.debug({ sessionId, status: session.status }, 'Session written');
}

/**
 * Update session status.
 *
 * @param sessionId - Session ID
 * @param status - New status
 * @param updates - Additional fields to update
 */
export function updateSessionStatus(
  sessionId: string,
  status: SessionStatus,
  updates?: Partial<TemporarySession>
): TemporarySession | null {
  const session = readSession(sessionId);
  if (!session) {
    logger.warn({ sessionId }, 'Cannot update session: not found');
    return null;
  }

  const updatedSession: TemporarySession = {
    ...session,
    status,
    ...updates,
  };

  writeSession(sessionId, updatedSession);
  logger.info({ sessionId, status, updates }, 'Session status updated');
  return updatedSession;
}

/**
 * Activate a session (mark as active after group creation).
 *
 * @param sessionId - Session ID
 * @param chatId - Created group chat ID
 * @param messageId - Sent message ID
 */
export function activateSession(
  sessionId: string,
  chatId: string,
  messageId: string
): TemporarySession | null {
  return updateSessionStatus(sessionId, 'active', { chatId, messageId });
}

/**
 * Expire a session with response.
 *
 * @param sessionId - Session ID
 * @param response - User response
 */
export function expireSessionWithResponse(
  sessionId: string,
  response: SessionResponse
): TemporarySession | null {
  return updateSessionStatus(sessionId, 'expired', { response });
}

/**
 * Expire a session due to timeout.
 *
 * @param sessionId - Session ID
 */
export function expireSessionTimeout(sessionId: string): TemporarySession | null {
  return updateSessionStatus(sessionId, 'expired');
}

/**
 * List all sessions.
 *
 * @param status - Optional status filter
 * @returns Array of sessions with their IDs
 */
export function listSessions(status?: SessionStatus): Array<{ id: string; session: TemporarySession }> {
  const sessionsDir = getSessionsDir();

  if (!fs.existsSync(sessionsDir)) {
    return [];
  }

  const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.yaml'));
  const sessions: Array<{ id: string; session: TemporarySession }> = [];

  for (const file of files) {
    const sessionId = file.replace('.yaml', '');
    const session = readSession(sessionId);

    if (session && (!status || session.status === status)) {
      sessions.push({ id: sessionId, session });
    }
  }

  return sessions;
}

/**
 * List pending sessions.
 */
export function listPendingSessions(): Array<{ id: string; session: TemporarySession }> {
  return listSessions('pending');
}

/**
 * List active sessions.
 */
export function listActiveSessions(): Array<{ id: string; session: TemporarySession }> {
  return listSessions('active');
}

/**
 * List expired sessions.
 */
export function listExpiredSessions(): Array<{ id: string; session: TemporarySession }> {
  return listSessions('expired');
}

/**
 * Check if an active session has timed out.
 *
 * @param session - Session to check
 * @returns True if timed out
 */
export function isSessionTimedOut(session: TemporarySession): boolean {
  if (session.status !== 'active') {
    return false;
  }

  const expiresAt = new Date(session.expiresAt);
  return new Date() > expiresAt;
}

/**
 * Delete a session.
 *
 * @param sessionId - Session ID
 * @returns True if deleted
 */
export function deleteSession(sessionId: string): boolean {
  const filePath = getSessionFilePath(sessionId);

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    logger.info({ sessionId }, 'Session deleted');
    return true;
  }

  return false;
}

/**
 * Find session by message ID.
 * Used when handling card click callbacks.
 *
 * @param messageId - Message ID to search for
 * @returns Session ID and session, or null if not found
 */
export function findSessionByMessageId(messageId: string): { id: string; session: TemporarySession } | null {
  const sessions = listSessions('active');

  for (const { id, session } of sessions) {
    if (session.messageId === messageId) {
      return { id, session };
    }
  }

  return null;
}
