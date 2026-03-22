/**
 * TemporarySessionManager - File-based session lifecycle management.
 *
 * Manages temporary sessions stored as YAML files in a directory.
 * Each session follows a three-state lifecycle: pending → active → expired.
 *
 * This module handles only data I/O and state transitions.
 * Business logic (group creation, message sending) is handled by Skills.
 *
 * @module core/session/session-manager
 * @see Issue #1391
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type {
  TemporarySession,
  CreateTemporarySessionOptions,
  SessionStatus,
  SessionResponse,
  SessionSummary,
} from './types.js';

const logger = createLogger('TemporarySessionManager');

/** Default directory name for session storage */
const DEFAULT_SESSION_DIR = 'temporary-sessions';

/**
 * Options for configuring TemporarySessionManager.
 */
export interface TemporarySessionManagerOptions {
  /** Base directory for session files (default: process.cwd()/workspace) */
  baseDir?: string;
  /** Subdirectory name for sessions (default: 'temporary-sessions') */
  sessionDirName?: string;
}

/**
 * Minimal YAML parser/writer for session files.
 *
 * Uses a simple approach: reads YAML-like structure for our known schema.
 * For full YAML support, the caller (Skill) can use a proper YAML library.
 *
 * This module uses JSON internally for reliability, but supports reading
 * YAML files written by other tools.
 */
function readYamlOrJson(filePath: string): TemporarySession | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');

    // Try JSON first (our primary format)
    try {
      return JSON.parse(content) as TemporarySession;
    } catch {
      // Fall back to simple YAML parsing for interop
      return parseSimpleYaml(content);
    }
  } catch (error) {
    logger.error({ filePath, err: error }, 'Failed to read session file');
    return null;
  }
}

/**
 * Parse a simple YAML file into a TemporarySession.
 * Handles the subset of YAML used by the session schema.
 */
function parseSimpleYaml(content: string): TemporarySession | null {
  const lines = content.split('\n');
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentArray: unknown[] = [];
  let inArray = false;
  let inObject = false;
  let objectDepth = 0;
  let objectContents: Record<string, unknown> = {};

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Check indentation for array/object exit
    if (line[0] !== ' ' && line[0] !== '\t') {
      // Top-level key
      if (inArray) {
        result[currentKey!] = currentArray;
        currentArray = [];
        inArray = false;
      }
      if (inObject) {
        result[currentKey!] = objectContents;
        objectContents = {};
        inObject = false;
        objectDepth = 0;
      }

      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;

      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();

      currentKey = key;

      if (value === '' || value === '|' || value === '>') {
        // Next lines are a block (array or object)
        // Determine what comes next
        continue;
      } else if (value === 'null' || value === '~' || value === '') {
        result[key] = null;
      } else if (value === 'true') {
        result[key] = true;
      } else if (value === 'false') {
        result[key] = false;
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // Inline array
        const items = value.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
        result[key] = items;
      } else if (value.startsWith('{') && value.endsWith('}')) {
        // Inline object - store raw, will be parsed separately
        result[key] = value;
      } else if (value.startsWith('"') || value.startsWith("'")) {
        result[key] = value.slice(1, -1);
      } else {
        // Try to parse as number
        const num = Number(value);
        result[key] = isNaN(num) ? value : num;
      }
    } else {
      // Indented content
      const indent = line.search(/\S/);
      const content_part = trimmed;

      if (content_part.startsWith('- ')) {
        // Array item
        inArray = true;
        const itemValue = content_part.slice(2).trim();
        if (itemValue.startsWith('{')) {
          // Inline object in array
          try {
            currentArray.push(JSON.parse(itemValue.replace(/'/g, '"')));
          } catch {
            currentArray.push(itemValue);
          }
        } else {
          currentArray.push(itemValue.replace(/^['"]|['"]$/g, ''));
        }
      } else if (indent > objectDepth && currentKey) {
        // Object property
        if (!inObject) {
          inObject = true;
          objectDepth = indent;
          objectContents = {};
        }

        const colonIdx = content_part.indexOf(':');
        if (colonIdx !== -1) {
          const propKey = content_part.slice(0, colonIdx).trim();
          const propValue = content_part.slice(colonIdx + 1).trim();

          if (propValue === 'null' || propValue === '~' || propValue === '') {
            objectContents[propKey] = null;
          } else if (propValue.startsWith('[')) {
            const items = propValue.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
            objectContents[propKey] = items;
          } else if (propValue.startsWith('"') || propValue.startsWith("'")) {
            objectContents[propKey] = propValue.slice(1, -1);
          } else {
            objectContents[propKey] = propValue;
          }
        }
      } else if (indent <= objectDepth && inObject) {
        // Exited object scope
        result[currentKey!] = objectContents;
        objectContents = {};
        inObject = false;
        objectDepth = 0;

        // Re-process this line
        const colonIdx = content_part.indexOf(':');
        if (colonIdx !== -1) {
          const key = content_part.slice(0, colonIdx).trim();
          const value = content_part.slice(colonIdx + 1).trim();
          currentKey = key;
          if (value !== '' && value !== 'null' && value !== '|') {
            result[key] = value.replace(/^['"]|['"]$/g, '');
          }
        }
      }
    }
  }

  // Flush remaining
  if (inArray && currentKey) {
    result[currentKey!] = currentArray;
  }
  if (inObject && currentKey) {
    result[currentKey!] = objectContents;
  }

  // Map to TemporarySession
  return mapToSession(result);
}

/**
 * Map a generic object to TemporarySession, handling type coercion.
 */
function mapToSession(obj: Record<string, unknown>): TemporarySession | null {
  if (!obj.id || !obj.status) return null;

  return {
    id: String(obj.id),
    status: obj.status as SessionStatus,
    chatId: obj.chatId ? String(obj.chatId) : null,
    messageId: obj.messageId ? String(obj.messageId) : null,
    expiresAt: String(obj.expiresAt),
    createGroup: obj.createGroup && typeof obj.createGroup === 'object'
      ? obj.createGroup as TemporarySession['createGroup']
      : undefined,
    message: String(obj.message || ''),
    options: Array.isArray(obj.options)
      ? (obj.options as Array<Record<string, unknown>>).map(o => ({
          value: String(o.value),
          text: String(o.text),
        }))
      : [],
    context: obj.context && typeof obj.context === 'object'
      ? obj.context as Record<string, unknown>
      : undefined,
    response: obj.response && typeof obj.response === 'object'
      ? obj.response as SessionResponse
      : null,
    expiry: obj.expiry && typeof obj.expiry === 'object'
      ? obj.expiry as TemporarySession['expiry']
      : null,
    createdAt: String(obj.createdAt || new Date().toISOString()),
    updatedAt: String(obj.updatedAt || new Date().toISOString()),
  };
}

/**
 * Write a session to a JSON file.
 */
function writeSessionFile(filePath: string, session: TemporarySession): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
}

/**
 * TemporarySessionManager - Manages temporary session files.
 *
 * Usage:
 * ```typescript
 * const manager = new TemporarySessionManager({ baseDir: '/path/to/workspace' });
 *
 * // Create a new session
 * const session = manager.create({
 *   id: 'pr-123',
 *   expiresAt: '2026-03-11T10:00:00Z',
 *   createGroup: { name: 'PR #123', members: ['ou_xxx'] },
 *   message: 'Please review this PR',
 *   options: [{ value: 'merge', text: '✓ 合并' }],
 * });
 *
 * // Activate the session (group created, message sent)
 * manager.activate('pr-123', { chatId: 'oc_xxx', messageId: 'om_xxx' });
 *
 * // Record a response
 * manager.respond('pr-123', { selectedValue: 'merge', responder: 'ou_xxx', repliedAt: '...' });
 *
 * // Check for expired sessions
 * const expired = manager.checkTimeouts();
 * ```
 */
export class TemporarySessionManager {
  private readonly sessionDir: string;

  constructor(options: TemporarySessionManagerOptions = {}) {
    const baseDir = options.baseDir || path.join(process.cwd(), 'workspace');
    const dirName = options.sessionDirName || DEFAULT_SESSION_DIR;
    this.sessionDir = path.join(baseDir, dirName);

    // Ensure directory exists
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  /**
   * Get the path to a session file by ID.
   */
  private getSessionPath(id: string): string {
    // Sanitize ID for use as filename
    const sanitized = id.replace(/[^a-zA-Z0-9_\-]/g, '_');
    return path.join(this.sessionDir, `${sanitized}.json`);
  }

  /**
   * Get all session IDs (filenames without extension).
   */
  private listSessionIds(): string[] {
    try {
      const files = fs.readdirSync(this.sessionDir);
      return files
        .filter(f => f.endsWith('.json') || f.endsWith('.yaml') || f.endsWith('.yml'))
        .map(f => path.basename(f, path.extname(f)));
    } catch {
      return [];
    }
  }

  /**
   * Create a new session.
   *
   * @param options - Session creation options
   * @returns The created session
   * @throws Error if a session with the same ID already exists
   */
  create(options: CreateTemporarySessionOptions): TemporarySession {
    const filePath = this.getSessionPath(options.id);
    if (fs.existsSync(filePath)) {
      throw new Error(`Session '${options.id}' already exists`);
    }

    const now = new Date().toISOString();
    const session: TemporarySession = {
      id: options.id,
      status: 'pending',
      chatId: null,
      messageId: null,
      expiresAt: options.expiresAt,
      createGroup: options.createGroup,
      message: options.message,
      options: options.options,
      context: options.context,
      response: null,
      expiry: null,
      createdAt: now,
      updatedAt: now,
    };

    writeSessionFile(filePath, session);
    logger.info({ id: options.id }, 'Session created');
    return session;
  }

  /**
   * Read a session by ID.
   *
   * @param id - Session ID
   * @returns The session or null if not found
   */
  read(id: string): TemporarySession | null {
    // Try both .json and .yaml extensions
    const jsonPath = this.getSessionPath(id);
    const yamlPath = jsonPath.replace(/\.json$/, '.yaml');

    for (const filePath of [jsonPath, yamlPath]) {
      if (fs.existsSync(filePath)) {
        return readYamlOrJson(filePath);
      }
    }

    return null;
  }

  /**
   * Activate a session (group chat created and message sent).
   *
   * Transitions the session from 'pending' to 'active'.
   *
   * @param id - Session ID
   * @param chatId - The created group chat ID
   * @param messageId - The sent message ID
   * @returns The updated session or null if not found
   * @throws Error if session is not in 'pending' status
   */
  activate(id: string, chatId: string, messageId: string): TemporarySession | null {
    const session = this.read(id);
    if (!session) {
      logger.warn({ id }, 'Cannot activate: session not found');
      return null;
    }
    if (session.status !== 'pending') {
      throw new Error(`Cannot activate session '${id}': status is '${session.status}', expected 'pending'`);
    }

    session.status = 'active';
    session.chatId = chatId;
    session.messageId = messageId;
    session.updatedAt = new Date().toISOString();

    writeSessionFile(this.getSessionPath(id), session);
    logger.info({ id, chatId }, 'Session activated');
    return session;
  }

  /**
   * Record a user response to the session.
   *
   * Transitions the session from 'active' to 'expired'.
   *
   * @param id - Session ID
   * @param response - The user's response
   * @returns The updated session or null if not found
   * @throws Error if session is not in 'active' status
   */
  respond(id: string, response: SessionResponse): TemporarySession | null {
    const session = this.read(id);
    if (!session) {
      logger.warn({ id }, 'Cannot record response: session not found');
      return null;
    }
    if (session.status !== 'active') {
      throw new Error(`Cannot record response for session '${id}': status is '${session.status}', expected 'active'`);
    }

    session.status = 'expired';
    session.response = response;
    session.expiry = {
      reason: 'response',
      expiredAt: response.repliedAt,
    };
    session.updatedAt = new Date().toISOString();

    writeSessionFile(this.getSessionPath(id), session);
    logger.info({ id, selectedValue: response.selectedValue }, 'Session response recorded');
    return session;
  }

  /**
   * Cancel a session.
   *
   * Transitions the session from any non-expired status to 'expired'.
   *
   * @param id - Session ID
   * @returns The updated session or null if not found
   */
  cancel(id: string): TemporarySession | null {
    const session = this.read(id);
    if (!session) {
      logger.warn({ id }, 'Cannot cancel: session not found');
      return null;
    }
    if (session.status === 'expired') {
      return session;
    }

    const now = new Date().toISOString();
    session.status = 'expired';
    session.expiry = {
      reason: 'cancelled',
      expiredAt: now,
    };
    session.updatedAt = now;

    writeSessionFile(this.getSessionPath(id), session);
    logger.info({ id }, 'Session cancelled');
    return session;
  }

  /**
   * Check all sessions for timeouts and expire them.
   *
   * Transitions timed-out 'active' sessions to 'expired'.
   *
   * @returns Array of sessions that were expired due to timeout
   */
  checkTimeouts(): TemporarySession[] {
    const now = new Date();
    const expired: TemporarySession[] = [];
    const ids = this.listSessionIds();

    for (const id of ids) {
      const session = this.read(id);
      if (!session) continue;
      if (session.status !== 'active') continue;

      const expiresAt = new Date(session.expiresAt);
      if (now >= expiresAt) {
        const expiredAt = now.toISOString();
        session.status = 'expired';
        session.expiry = {
          reason: 'timeout',
          expiredAt,
        };
        session.updatedAt = expiredAt;

        writeSessionFile(this.getSessionPath(id), session);
        expired.push(session);
        logger.info({ id, expiresAt: session.expiresAt }, 'Session expired due to timeout');
      }
    }

    if (expired.length > 0) {
      logger.info({ count: expired.length }, 'Sessions expired due to timeout');
    }

    return expired;
  }

  /**
   * List all sessions, optionally filtered by status.
   *
   * @param status - Optional status filter
   * @returns Array of session summaries
   */
  list(status?: SessionStatus): SessionSummary[] {
    const ids = this.listSessionIds();
    const summaries: SessionSummary[] = [];

    for (const id of ids) {
      const session = this.read(id);
      if (!session) continue;
      if (status && session.status !== status) continue;

      summaries.push({
        id: session.id,
        status: session.status,
        chatId: session.chatId,
        expiresAt: session.expiresAt,
        hasResponse: session.response !== null,
        endReason: session.expiry?.reason,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
    }

    return summaries;
  }

  /**
   * Delete a session file.
   *
   * @param id - Session ID
   * @returns true if deleted, false if not found
   */
  delete(id: string): boolean {
    const jsonPath = this.getSessionPath(id);
    const yamlPath = jsonPath.replace(/\.json$/, '.yaml');

    for (const filePath of [jsonPath, yamlPath]) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logger.info({ id }, 'Session deleted');
        return true;
      }
    }

    return false;
  }

  /**
   * Clean up expired sessions older than the specified duration.
   *
   * @param maxAgeMs - Maximum age in milliseconds (default: 24 hours)
   * @returns Number of sessions cleaned up
   */
  cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;
    const ids = this.listSessionIds();

    for (const id of ids) {
      const session = this.read(id);
      if (!session) continue;
      if (session.status !== 'expired') continue;

      const updatedAt = new Date(session.updatedAt).getTime();
      if (now - updatedAt > maxAgeMs) {
        this.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info({ count: cleaned }, 'Expired sessions cleaned up');
    }

    return cleaned;
  }

  /**
   * Get the session directory path.
   */
  getSessionDir(): string {
    return this.sessionDir;
  }
}
