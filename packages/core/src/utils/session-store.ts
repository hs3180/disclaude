/**
 * Temporary Session Store.
 *
 * Provides file-based session management for the "ask user → wait for response → get response"
 * pattern. Each session follows a three-state lifecycle: pending → active → expired.
 *
 * Design principles (learned from rejected PRs #1436, #1470):
 * - JSON format (no hand-written YAML parser)
 * - Pure functions (no Manager class abstraction)
 * - Session ID validation (prevents path traversal)
 * - Optimistic concurrency (updatedAt check)
 * - No side effects in query functions
 * - Auto-cleanup of old expired sessions
 *
 * Issue #1391: Temporary Session Management System (Simplified Design)
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Session status values.
 */
export type SessionStatus = 'pending' | 'active' | 'expired';

/**
 * Session file on disk (JSON format).
 */
export interface SessionFile {
  /** Unique session identifier (validated against SAFE_SESSION_ID) */
  id: string;
  /** Current lifecycle status */
  status: SessionStatus;
  /** Chat ID where the card was sent (filled when group is created) */
  chatId: string | null;
  /** Message ID of the sent card (filled after message is sent) */
  messageId: string | null;
  /** ISO 8601 timestamp when the session expires */
  expiresAt: string | null;
  /** ISO 8601 timestamp of the last update */
  updatedAt: string;
  /** ISO 8601 timestamp when the session was created */
  createdAt: string;

  // --- Configuration (set at creation time) ---

  /** Group creation options (used by schedule to create the chat) */
  createGroup?: {
    name: string;
    members?: string[];
  } | null;
  /** Card message content to send to the user */
  message?: string | null;
  /** Card action options */
  options?: Array<{ value: string; text: string }> | null;
  /** Arbitrary context data for the caller */
  context?: Record<string, unknown> | null;

  // --- Response (filled when user responds) ---

  /** User's response, if any */
  response?: {
    selectedValue: string;
    responder?: string;
    repliedAt?: string;
  } | null;
}

/**
 * Filter options for listing sessions.
 */
export interface ListSessionsFilter {
  status?: SessionStatus;
}

/**
 * Result of an update operation.
 */
export interface UpdateResult {
  success: boolean;
  session?: SessionFile;
  error?: string;
}

/**
 * Regex for safe session IDs.
 * Allows alphanumeric, hyphens, underscores, and dots (no path traversal).
 */
const SAFE_SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_\-]*$/;

/**
 * Default directory name for session files (relative to workspace).
 */
const DEFAULT_SESSION_DIR_NAME = 'temporary-sessions';

/**
 * Default max age for expired session cleanup (24 hours in ms).
 */
const DEFAULT_CLEANUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * File system operations used by session-store.
 * Replace for testing to avoid real file I/O.
 * @internal
 */
export const sessionFs = {
  readFile: fs.readFile,
  writeFile: fs.writeFile,
  unlink: fs.unlink,
  readdir: fs.readdir,
  stat: fs.stat,
};

// ---------------------------------------------------------------------------
// Session ID Validation
// ---------------------------------------------------------------------------

/**
 * Validate a session ID to prevent path traversal attacks.
 *
 * Only allows alphanumeric characters, hyphens, and underscores.
 * Must start with an alphanumeric character.
 *
 * @param sessionId - The session ID to validate
 * @returns true if the session ID is safe to use
 *
 * @example
 * ```typescript
 * isValidSessionId('pr-123');           // true
 * isValidSessionId('offline-deploy');   // true
 * isValidSessionId('../etc/passwd');    // false
 * isValidSessionId('');                 // false
 * ```
 */
export function isValidSessionId(sessionId: string): boolean {
  return SAFE_SESSION_ID.test(sessionId);
}

// ---------------------------------------------------------------------------
// Path Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the session directory path.
 *
 * @param baseDir - The workspace base directory
 * @returns The absolute path to the session directory
 */
export function getSessionDir(baseDir: string): string {
  return path.join(baseDir, DEFAULT_SESSION_DIR_NAME);
}

/**
 * Resolve the file path for a specific session.
 *
 * The sessionId is validated before constructing the path.
 *
 * @param sessionId - The session ID (must pass isValidSessionId)
 * @param baseDir - The workspace base directory
 * @returns The absolute path to the session file
 * @throws Error if sessionId is invalid
 */
export function getSessionFilePath(sessionId: string, baseDir: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`Invalid session ID: "${sessionId}" — must match ${SAFE_SESSION_ID}`);
  }
  return path.join(getSessionDir(baseDir), `${sessionId}.json`);
}

// ---------------------------------------------------------------------------
// Core CRUD Operations
// ---------------------------------------------------------------------------

/**
 * Create a new session file.
 *
 * @param sessionId - Unique session identifier
 * @param data - Session configuration (message, options, context, etc.)
 * @param baseDir - Workspace base directory
 * @returns The created session file
 * @throws Error if session ID is invalid or file already exists
 */
export async function createSession(
  sessionId: string,
  data: {
    createGroup?: SessionFile['createGroup'];
    message?: SessionFile['message'];
    options?: SessionFile['options'];
    context?: SessionFile['context'];
    expiresAt?: string | null;
  },
  baseDir: string,
): Promise<SessionFile> {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`Invalid session ID: "${sessionId}"`);
  }

  const filePath = getSessionFilePath(sessionId, baseDir);
  const now = new Date().toISOString();

  const session: SessionFile = {
    id: sessionId,
    status: 'pending',
    chatId: null,
    messageId: null,
    expiresAt: data.expiresAt ?? null,
    updatedAt: now,
    createdAt: now,
    createGroup: data.createGroup ?? null,
    message: data.message ?? null,
    options: data.options ?? null,
    context: data.context ?? null,
    response: null,
  };

  // Write atomically — fail if file already exists
  const { writeFile } = sessionFs;
  await writeFile(filePath, JSON.stringify(session, null, 2), { flag: 'wx' });

  return session;
}

/**
 * Read a session file.
 *
 * @param sessionId - The session ID
 * @param baseDir - Workspace base directory
 * @returns The session file, or undefined if not found
 */
export async function readSession(
  sessionId: string,
  baseDir: string,
): Promise<SessionFile | undefined> {
  const filePath = getSessionFilePath(sessionId, baseDir);

  try {
    const raw = await sessionFs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as SessionFile;
  } catch (err: unknown) {
    if (isFileNotFoundError(err)) {
      return undefined;
    }
    throw err;
  }
}

/**
 * Update a session file with optimistic concurrency control.
 *
 * The update only succeeds if the session's `updatedAt` still matches the
 * value when it was last read. This prevents lost-update race conditions.
 *
 * @param sessionId - The session ID
 * @param baseDir - Workspace base directory
 * @param updater - Function that receives the current session and returns the updates to apply
 * @param expectedUpdatedAt - The updatedAt value when the session was last read (for concurrency control)
 * @returns UpdateResult with success status, updated session, or error message
 */
export async function updateSession(
  sessionId: string,
  baseDir: string,
  updater: (session: SessionFile) => Partial<SessionFile>,
  expectedUpdatedAt?: string,
): Promise<UpdateResult> {
  const filePath = getSessionFilePath(sessionId, baseDir);

  try {
    const raw = await sessionFs.readFile(filePath, 'utf-8');
    const current = JSON.parse(raw) as SessionFile;

    // Optimistic concurrency check
    if (expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt) {
      return {
        success: false,
        error: `Concurrency conflict: session was updated by another process (expected ${expectedUpdatedAt}, got ${current.updatedAt})`,
      };
    }

    const updates = updater(current);
    const updated: SessionFile = {
      ...current,
      ...updates,
      updatedAt: new Date().toISOString(),
      // Preserve immutable fields
      id: current.id,
      createdAt: current.createdAt,
    };

    await sessionFs.writeFile(filePath, JSON.stringify(updated, null, 2), 'utf-8');

    return { success: true, session: updated };
  } catch (err: unknown) {
    if (isFileNotFoundError(err)) {
      return { success: false, error: `Session not found: ${sessionId}` };
    }
    return { success: false, error: String(err) };
  }
}

/**
 * Delete a session file.
 *
 * @param sessionId - The session ID
 * @param baseDir - Workspace base directory
 * @returns true if the file was deleted, false if it didn't exist
 */
export async function deleteSession(
  sessionId: string,
  baseDir: string,
): Promise<boolean> {
  const filePath = getSessionFilePath(sessionId, baseDir);

  try {
    await sessionFs.unlink(filePath);
    return true;
  } catch (err: unknown) {
    if (isFileNotFoundError(err)) {
      return false;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// State Transition Helpers
// ---------------------------------------------------------------------------

/**
 * Activate a pending session (after group creation and message sending).
 *
 * Only sessions with status `pending` can be activated.
 *
 * @param sessionId - The session ID
 * @param baseDir - Workspace base directory
 * @param chatId - The chat ID where the card was sent
 * @param messageId - The message ID of the sent card
 * @param expectedUpdatedAt - For optimistic concurrency control
 * @returns UpdateResult
 */
export async function activateSession(
  sessionId: string,
  baseDir: string,
  chatId: string,
  messageId: string,
  expectedUpdatedAt?: string,
): Promise<UpdateResult> {
  return updateSession(
    sessionId,
    baseDir,
    (current) => {
      if (current.status !== 'pending') {
        throw new Error(`Cannot activate session with status "${current.status}" — only "pending" sessions can be activated`);
      }
      return { status: 'active', chatId, messageId };
    },
    expectedUpdatedAt,
  );
}

/**
 * Record a user response to an active session.
 *
 * Only sessions with status `active` can receive responses.
 * Automatically transitions to `expired`.
 *
 * @param sessionId - The session ID
 * @param baseDir - Workspace base directory
 * @param response - The user's response
 * @param expectedUpdatedAt - For optimistic concurrency control
 * @returns UpdateResult
 */
export async function respondToSession(
  sessionId: string,
  baseDir: string,
  response: NonNullable<SessionFile['response']>,
  expectedUpdatedAt?: string,
): Promise<UpdateResult> {
  return updateSession(
    sessionId,
    baseDir,
    (current) => {
      if (current.status !== 'active') {
        throw new Error(`Cannot respond to session with status "${current.status}" — only "active" sessions can receive responses`);
      }
      return { status: 'expired', response };
    },
    expectedUpdatedAt,
  );
}

/**
 * Expire a session due to timeout (no user response).
 *
 * Only sessions with status `active` can be timed out.
 *
 * @param sessionId - The session ID
 * @param baseDir - Workspace base directory
 * @param expectedUpdatedAt - For optimistic concurrency control
 * @returns UpdateResult
 */
export async function expireSession(
  sessionId: string,
  baseDir: string,
  expectedUpdatedAt?: string,
): Promise<UpdateResult> {
  return updateSession(
    sessionId,
    baseDir,
    (current) => {
      if (current.status !== 'active') {
        throw new Error(`Cannot expire session with status "${current.status}" — only "active" sessions can be timed out`);
      }
      return { status: 'expired' };
    },
    expectedUpdatedAt,
  );
}

// ---------------------------------------------------------------------------
// Query Operations (no side effects)
// ---------------------------------------------------------------------------

/**
 * List all session files matching the optional filter.
 *
 * This is a read-only operation — it never creates directories or modifies files.
 *
 * @param baseDir - Workspace base directory
 * @param filter - Optional status filter
 * @returns Array of session files (empty if directory doesn't exist)
 */
export async function listSessions(
  baseDir: string,
  filter?: ListSessionsFilter,
): Promise<SessionFile[]> {
  const dir = getSessionDir(baseDir);

  let files: string[];
  try {
    files = await sessionFs.readdir(dir);
  } catch (err: unknown) {
    if (isFileNotFoundError(err)) {
      return [];
    }
    throw err;
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  const sessions: SessionFile[] = [];

  for (const file of jsonFiles) {
    try {
      const raw = await sessionFs.readFile(path.join(dir, file), 'utf-8');
      const session = JSON.parse(raw) as SessionFile;
      if (filter?.status && session.status !== filter.status) {
        continue;
      }
      sessions.push(session);
    } catch {
      // Skip malformed files — don't break the listing
    }
  }

  return sessions;
}

/**
 * Find a session by its associated message ID.
 *
 * Useful for card action handlers that receive a messageId from the callback.
 *
 * @param messageId - The message ID to search for
 * @param baseDir - Workspace base directory
 * @returns The session file, or undefined if not found
 */
export async function findSessionByMessageId(
  messageId: string,
  baseDir: string,
): Promise<SessionFile | undefined> {
  const sessions = await listSessions(baseDir);
  return sessions.find((s) => s.messageId === messageId);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Delete expired sessions that are older than the specified max age.
 *
 * @param baseDir - Workspace base directory
 * @param maxAgeMs - Maximum age in milliseconds (default: 24 hours)
 * @returns Number of sessions cleaned up
 */
export async function cleanupExpiredSessions(
  baseDir: string,
  maxAgeMs: number = DEFAULT_CLEANUP_MAX_AGE_MS,
): Promise<number> {
  const sessions = await listSessions(baseDir, { status: 'expired' });
  const now = Date.now();
  let cleaned = 0;

  for (const session of sessions) {
    const updatedAt = new Date(session.updatedAt).getTime();
    if (now - updatedAt > maxAgeMs) {
      const deleted = await deleteSession(session.id, baseDir);
      if (deleted) {
        cleaned++;
      }
    }
  }

  return cleaned;
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Check if an error is a "file not found" error (ENOENT).
 */
function isFileNotFoundError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
