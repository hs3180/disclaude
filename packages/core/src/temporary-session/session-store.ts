/**
 * Temporary Session Store - Pure functions for session file I/O.
 *
 * Issue #1391: Simplified temporary session management using JSON files.
 *
 * Design Principles:
 * - Pure functions, no class/manager abstraction
 * - Direct file I/O with atomic writes (write-to-temp-then-rename)
 * - JSON format for session files
 * - Sessions stored in: workspace/temporary-sessions/{id}.json
 *
 * @module temporary-session/session-store
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import type {
  TemporarySession,
  SessionStatus,
  CreateTemporarySessionOptions,
} from './types.js';

const logger = createLogger('TemporarySessionStore');

/** Default session timeout in minutes */
const DEFAULT_TIMEOUT_MINUTES = 60;

/**
 * Get the directory path for temporary session files.
 */
export function getSessionDir(baseDir?: string): string {
  const workspaceDir = baseDir || Config.getWorkspaceDir();
  return path.join(workspaceDir, 'temporary-sessions');
}

/**
 * Get the file path for a specific session.
 */
export function getSessionFilePath(sessionId: string, baseDir?: string): string {
  return path.join(getSessionDir(baseDir), `${sessionId}.json`);
}

/**
 * Ensure the session directory exists.
 */
export async function ensureSessionDir(baseDir?: string): Promise<void> {
  await fs.mkdir(getSessionDir(baseDir), { recursive: true });
}

/**
 * Create a new temporary session.
 *
 * Creates a session file in pending state with the given options.
 *
 * @param options - Session creation options
 * @returns The created session
 *
 * @example
 * ```typescript
 * const session = await createSession({
 *   id: 'pr-123-review',
 *   message: 'Please review PR #123',
 *   options: [
 *     { value: 'merge', text: '✓ Merge' },
 *     { value: 'close', text: '✗ Close' },
 *   ],
 *   createGroup: {
 *     name: 'PR #123 Review',
 *     members: ['ou_developer'],
 *   },
 *   timeoutMinutes: 60,
 * });
 * ```
 */
export async function createSession(
  options: CreateTemporarySessionOptions,
  baseDir?: string
): Promise<TemporarySession> {
  await ensureSessionDir(baseDir);

  const now = new Date();
  const timeoutMs = (options.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60 * 1000;
  const expiresAt = new Date(now.getTime() + timeoutMs);

  const session: TemporarySession = {
    id: options.id,
    status: 'pending',
    chatId: null,
    messageId: null,
    expiresAt: expiresAt.toISOString(),
    createGroup: options.createGroup,
    message: options.message,
    options: options.options,
    context: options.context,
    response: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  await writeSession(session, baseDir);
  logger.info({ sessionId: session.id, expiresAt: session.expiresAt }, 'Session created');

  return session;
}

/**
 * Read a session by ID.
 *
 * @param sessionId - Session identifier
 * @returns The session, or null if not found
 */
export async function readSession(
  sessionId: string,
  baseDir?: string
): Promise<TemporarySession | null> {
  const filePath = getSessionFilePath(sessionId, baseDir);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const session = JSON.parse(content) as TemporarySession;

    // Validate essential fields
    if (!session.id || !session.status) {
      logger.warn({ sessionId }, 'Invalid session file: missing required fields');
      return null;
    }

    return session;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    logger.error({ err: error, sessionId }, 'Failed to read session file');
    return null;
  }
}

/**
 * Write a session to disk using atomic write (write-to-temp-then-rename).
 *
 * @param session - Session to write
 */
export async function writeSession(
  session: TemporarySession,
  baseDir?: string
): Promise<void> {
  await ensureSessionDir(baseDir);

  const filePath = getSessionFilePath(session.id, baseDir);
  const tempFilePath = `${filePath}.${crypto.randomBytes(8).toString('hex')}.tmp`;

  try {
    // Write to temp file first
    await fs.writeFile(tempFilePath, JSON.stringify(session, null, 2), 'utf-8');
    // Atomically rename
    await fs.rename(tempFilePath, filePath);
  } catch (error) {
    // Clean up temp file on failure
    try {
      await fs.unlink(tempFilePath);
    } catch {
      // Ignore cleanup error
    }
    throw error;
  }
}

/**
 * Update a session's status.
 *
 * @param sessionId - Session identifier
 * @param status - New status
 * @returns Updated session, or null if not found
 */
export async function updateSessionStatus(
  sessionId: string,
  status: SessionStatus,
  baseDir?: string
): Promise<TemporarySession | null> {
  const session = await readSession(sessionId, baseDir);
  if (!session) {
    return null;
  }

  session.status = status;
  session.updatedAt = new Date().toISOString();
  await writeSession(session, baseDir);

  logger.info({ sessionId, status }, 'Session status updated');
  return session;
}

/**
 * Activate a session (set status to active with chatId and messageId).
 *
 * @param sessionId - Session identifier
 * @param chatId - Group chat ID
 * @param messageId - Interactive card message ID
 * @returns Updated session, or null if not found
 */
export async function activateSession(
  sessionId: string,
  chatId: string,
  messageId: string,
  baseDir?: string
): Promise<TemporarySession | null> {
  const session = await readSession(sessionId, baseDir);
  if (!session) {
    return null;
  }

  session.status = 'active';
  session.chatId = chatId;
  session.messageId = messageId;
  session.updatedAt = new Date().toISOString();
  await writeSession(session, baseDir);

  logger.info({ sessionId, chatId, messageId }, 'Session activated');
  return session;
}

/**
 * Record a user response and expire the session.
 *
 * @param sessionId - Session identifier
 * @param selectedValue - The selected option value
 * @param responder - Open ID of the responder
 * @returns Updated session, or null if not found
 */
export async function respondToSession(
  sessionId: string,
  selectedValue: string,
  responder: string,
  baseDir?: string
): Promise<TemporarySession | null> {
  const session = await readSession(sessionId, baseDir);
  if (!session) {
    return null;
  }

  session.status = 'expired';
  session.response = {
    selectedValue,
    responder,
    repliedAt: new Date().toISOString(),
  };
  session.updatedAt = new Date().toISOString();
  await writeSession(session, baseDir);

  logger.info({ sessionId, selectedValue, responder }, 'Session response recorded');
  return session;
}

/**
 * Expire a session due to timeout (no response recorded).
 *
 * @param sessionId - Session identifier
 * @returns Updated session, or null if not found
 */
export async function expireSession(
  sessionId: string,
  baseDir?: string
): Promise<TemporarySession | null> {
  return updateSessionStatus(sessionId, 'expired', baseDir);
}

/**
 * List all sessions, optionally filtered by status.
 *
 * @param status - Optional status filter
 * @returns Array of sessions matching the filter
 */
export async function listSessions(
  status?: SessionStatus,
  baseDir?: string
): Promise<TemporarySession[]> {
  await ensureSessionDir(baseDir);

  const dir = getSessionDir(baseDir);
  let files: string[];

  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }

  const sessionFiles = files.filter(f => f.endsWith('.json'));
  const sessions: TemporarySession[] = [];

  for (const file of sessionFiles) {
    try {
      const content = await fs.readFile(path.join(dir, file), 'utf-8');
      const session = JSON.parse(content) as TemporarySession;

      if (!session.id || !session.status) {
        continue;
      }

      if (!status || session.status === status) {
        sessions.push(session);
      }
    } catch {
      // Skip invalid files
    }
  }

  // Sort by creation time (newest first)
  return sessions.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * List sessions that have expired based on their expiresAt timestamp
 * but still have status 'active' or 'pending'.
 *
 * @returns Array of timed-out sessions
 */
export async function listTimedOutSessions(
  baseDir?: string
): Promise<TemporarySession[]> {
  const now = Date.now();
  const allSessions = await listSessions(undefined, baseDir);

  return allSessions.filter(session => {
    if (session.status === 'expired') {
      return false;
    }
    return new Date(session.expiresAt).getTime() < now;
  });
}

/**
 * Find a session by message ID.
 *
 * Useful for handling card action callbacks where we only have the message ID.
 *
 * @param messageId - Card message ID
 * @returns The session, or null if not found
 */
export async function findSessionByMessageId(
  messageId: string,
  baseDir?: string
): Promise<TemporarySession | null> {
  const activeSessions = await listSessions('active', baseDir);

  for (const session of activeSessions) {
    if (session.messageId === messageId) {
      return session;
    }
  }

  return null;
}

/**
 * Delete a session file.
 *
 * @param sessionId - Session identifier
 * @returns Whether the file was deleted
 */
export async function deleteSession(
  sessionId: string,
  baseDir?: string
): Promise<boolean> {
  const filePath = getSessionFilePath(sessionId, baseDir);

  try {
    await fs.unlink(filePath);
    logger.info({ sessionId }, 'Session deleted');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    logger.error({ err: error, sessionId }, 'Failed to delete session file');
    return false;
  }
}
