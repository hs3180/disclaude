/**
 * Temporary session file I/O utilities.
 *
 * Inline file operations for temporary session management (Issue #1317).
 * No Manager class — follows the approved approach of direct file I/O
 * from Skills/Schedules, modeled after CooldownManager's JSON pattern.
 *
 * Storage: workspace/temporary-sessions/{sanitized-session-id}.json
 *
 * @module mcp-server/tools/temporary-session
 */

import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '@disclaude/core';
import { getWorkspaceDir } from './credentials.js';
import type { TemporarySession, SessionStatus } from './types.js';

const logger = createLogger('TemporarySession');

/** Directory name for session files (under workspace) */
const SESSIONS_DIR = 'temporary-sessions';

/**
 * Get the sessions directory path, creating it if needed.
 */
async function ensureSessionsDir(): Promise<string> {
  const sessionsDir = path.join(getWorkspaceDir(), SESSIONS_DIR);
  await fsPromises.mkdir(sessionsDir, { recursive: true });
  return sessionsDir;
}

/**
 * Sanitize a session ID for use as a filename.
 * Replaces non-alphanumeric characters with underscores.
 */
function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Get the file path for a session.
 */
function getSessionFilePath(sessionId: string, sessionsDir: string): string {
  return path.join(sessionsDir, `${sanitizeSessionId(sessionId)}.json`);
}

/**
 * Read a session file from disk.
 *
 * @param sessionId - The session identifier
 * @returns The parsed session, or null if not found / invalid
 */
export async function readSession(sessionId: string): Promise<TemporarySession | null> {
  try {
    const sessionsDir = path.join(getWorkspaceDir(), SESSIONS_DIR);
    const filePath = getSessionFilePath(sessionId, sessionsDir);
    const content = await fsPromises.readFile(filePath, 'utf-8');
    const session = JSON.parse(content) as TemporarySession;

    // Basic validation
    if (!session.sessionId || !session.status || !session.createdAt) {
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
 * Write a session file to disk.
 *
 * @param session - The session object to persist
 */
export async function writeSession(session: TemporarySession): Promise<void> {
  const sessionsDir = await ensureSessionsDir();
  const filePath = getSessionFilePath(session.sessionId, sessionsDir);
  const content = JSON.stringify(session, null, 2);

  await fsPromises.writeFile(filePath, content, 'utf-8');
  logger.debug({ sessionId: session.sessionId, status: session.status }, 'Session file written');
}

/**
 * Update specific fields of an existing session.
 *
 * @param sessionId - The session identifier
 * @param updates - Partial update to merge into the session
 * @returns The updated session, or null if session not found
 */
export async function updateSession(
  sessionId: string,
  updates: Partial<TemporarySession>
): Promise<TemporarySession | null> {
  const session = await readSession(sessionId);
  if (!session) {
    logger.warn({ sessionId }, 'Cannot update: session not found');
    return null;
  }

  const updated: TemporarySession = {
    ...session,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await writeSession(updated);
  return updated;
}

/**
 * List all session files, optionally filtered by status.
 *
 * @param statusFilter - Optional status to filter by
 * @returns Array of sessions matching the filter
 */
export async function listSessions(statusFilter?: SessionStatus): Promise<TemporarySession[]> {
  try {
    const sessionsDir = path.join(getWorkspaceDir(), SESSIONS_DIR);
    let files: string[];

    try {
      files = await fsPromises.readdir(sessionsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const jsonFiles = files.filter(f => f.endsWith('.json'));
    const sessions: TemporarySession[] = [];

    for (const file of jsonFiles) {
      try {
        const filePath = path.join(sessionsDir, file);
        const content = await fsPromises.readFile(filePath, 'utf-8');
        const session = JSON.parse(content) as TemporarySession;

        if (session.sessionId && session.status) {
          if (!statusFilter || session.status === statusFilter) {
            sessions.push(session);
          }
        }
      } catch {
        // Skip invalid files
      }
    }

    // Sort by creation time, newest first
    sessions.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return sessions;
  } catch (error) {
    logger.error({ err: error }, 'Failed to list sessions');
    return [];
  }
}

/**
 * Mark expired sessions (those past their expiresAt timestamp).
 *
 * @returns Number of sessions marked as expired
 */
export async function expireOverdueSessions(): Promise<number> {
  const activeSessions = await listSessions('active');
  const pendingSessions = await listSessions('pending');
  const candidates = [...activeSessions, ...pendingSessions];
  const now = Date.now();
  let expiredCount = 0;

  for (const session of candidates) {
    if (new Date(session.expiresAt).getTime() <= now) {
      await updateSession(session.sessionId, { status: 'expired' });
      expiredCount++;
    }
  }

  if (expiredCount > 0) {
    logger.info({ expiredCount }, 'Marked overdue sessions as expired');
  }

  return expiredCount;
}

/**
 * Delete a session file from disk.
 *
 * @param sessionId - The session identifier
 * @returns true if deleted, false if not found
 */
export async function deleteSession(sessionId: string): Promise<boolean> {
  try {
    const sessionsDir = path.join(getWorkspaceDir(), SESSIONS_DIR);
    const filePath = getSessionFilePath(sessionId, sessionsDir);
    await fsPromises.unlink(filePath);
    logger.debug({ sessionId }, 'Session file deleted');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    logger.error({ err: error, sessionId }, 'Failed to delete session file');
    return false;
  }
}

/**
 * Generate a unique session ID based on topic and timestamp.
 *
 * @param topic - The discussion topic (used as prefix)
 * @returns A unique session ID string
 */
export function generateSessionId(topic: string): string {
  const sanitized = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  return `${sanitized}-${timestamp}-${random}`;
}
