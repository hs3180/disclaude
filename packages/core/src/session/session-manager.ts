/**
 * Temporary Session Manager
 *
 * File-based session management with state machine transitions.
 * Each session consists of:
 * - `session.md`: Static configuration (YAML frontmatter + Markdown)
 * - `state.yaml`: Dynamic state (YAML)
 *
 * State machine: pending → sent → replied | expired
 *
 * The manager only handles state transitions and file I/O.
 * Group creation and message sending are handled by the schedule/skill layer.
 *
 * Related issues: #393, #631, #946, #1317
 *
 * @module @disclaude/core/session
 */

import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger.js';
import type {
  SessionConfig,
  SessionState,
  TemporarySession,
  SessionSummary,
  SessionFilterOptions,
  SessionResponse,
  CreateTemporarySessionOptions,
  SessionManagerOptions,
} from './types.js';

const logger = createLogger('SessionManager');

// ============================================================================
// Constants
// ============================================================================

/** Session config file name */
const SESSION_CONFIG_FILE = 'session.md';

/** Session state file name */
const SESSION_STATE_FILE = 'state.yaml';

/** Default session expiration (24 hours) */
const DEFAULT_EXPIRATION = '24h';

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Parse YAML frontmatter from markdown content.
 * Returns parsed frontmatter object and the markdown body.
 *
 * Format:
 * ```markdown
 * ---
 * key: value
 * ---
 * Markdown content...
 * ```
 */
function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const [, frontmatterText, body] = match;
  const parsed = yaml.load(frontmatterText) as Record<string, unknown> || {};

  return { frontmatter: parsed, body: body.trim() };
}

/**
 * Parse duration string to milliseconds.
 * Supports: '30m', '1h', '24h', '1d', '2d', '1d12h', '30m30s'
 */
export function parseDuration(duration: string): number {
  if (!duration || typeof duration !== 'string') {
    return 24 * 60 * 60 * 1000; // Default 24h
  }

  const regex = /(\d+)([dhms])/g;
  let totalMs = 0;
  let match;

  while ((match = regex.exec(duration)) !== null) {
    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case 'd': totalMs += value * 24 * 60 * 60 * 1000; break;
      case 'h': totalMs += value * 60 * 60 * 1000; break;
      case 'm': totalMs += value * 60 * 1000; break;
      case 's': totalMs += value * 1000; break;
    }
  }

  return totalMs > 0 ? totalMs : 24 * 60 * 60 * 1000;
}

/**
 * Validate session config fields.
 * Returns an array of validation error messages.
 */
function validateConfig(config: SessionConfig): string[] {
  const errors: string[] = [];

  if (!config.type || !['blocking', 'non-blocking'].includes(config.type)) {
    errors.push('Invalid or missing session type');
  }

  if (!config.channel || !['group', 'private', 'existing'].includes(config.channel.type)) {
    errors.push('Invalid or missing channel type');
  }

  if (config.channel.type === 'group' && !config.channel.name) {
    errors.push('Channel name is required for group type');
  }

  if (config.channel.type === 'existing' && !config.channel.chatId) {
    errors.push('Channel chatId is required for existing type');
  }

  return errors;
}

/**
 * Check if a session has expired based on its expiresAt timestamp.
 */
export function isSessionExpired(session: TemporarySession): boolean {
  if (!session.state.expiresAt) return false;
  return new Date(session.state.expiresAt) < new Date();
}

// ============================================================================
// Session Manager
// ============================================================================

/**
 * SessionManager - Manages temporary sessions with file-based persistence.
 *
 * Sessions are stored as folders, each containing:
 * - `session.md`: YAML frontmatter (config) + Markdown body (message content)
 * - `state.yaml`: YAML state file with status, timestamps, and response
 *
 * Usage:
 * ```typescript
 * const manager = new SessionManager({ sessionsDir: './workspace/temporary-sessions' });
 *
 * // Create a new session
 * const session = await manager.create({
 *   config: {
 *     type: 'blocking',
 *     purpose: 'pr-review',
 *     channel: { type: 'group', name: 'PR #123 Review' },
 *     expiresIn: '24h',
 *     options: [
 *       { value: 'merge', text: '✓ Merge' },
 *       { value: 'close', text: '✗ Close' },
 *     ],
 *   },
 * });
 *
 * // Update state when message is sent
 * await manager.markAsSent(session.id, 'oc_xxx', 'om_xxx');
 *
 * // Record user response
 * await manager.recordResponse(session.id, {
 *   selectedValue: 'merge',
 *   responder: 'ou_xxx',
 *   repliedAt: new Date().toISOString(),
 * });
 * ```
 */
export class SessionManager {
  private sessionsDir: string;

  constructor(options: SessionManagerOptions) {
    this.sessionsDir = options.sessionsDir;
    logger.info({ sessionsDir: this.sessionsDir }, 'SessionManager initialized');
  }

  /**
   * Get the sessions directory path.
   */
  getSessionsDir(): string {
    return this.sessionsDir;
  }

  /**
   * Ensure the sessions directory exists.
   */
  private async ensureDir(): Promise<void> {
    await fsPromises.mkdir(this.sessionsDir, { recursive: true });
  }

  /**
   * Ensure a session folder directory exists.
   */
  private async ensureSessionDir(sessionId: string): Promise<string> {
    const sessionDir = path.join(this.sessionsDir, sessionId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    return sessionDir;
  }

  // ============================================================================
  // Create
  // ============================================================================

  /**
   * Create a new temporary session.
   *
   * Creates a session folder with session.md (config) and state.yaml (initial state).
   *
   * @param options - Session creation options
   * @returns The created session
   * @throws Error if config validation fails
   */
  async create(options: CreateTemporarySessionOptions): Promise<TemporarySession> {
    const errors = validateConfig(options.config);
    if (errors.length > 0) {
      throw new Error(`Invalid session config: ${errors.join('; ')}`);
    }

    await this.ensureDir();

    const sessionId = options.id || this.generateSessionId(options.config);
    const sessionDir = await this.ensureSessionDir(sessionId);

    // Create initial state
    const now = new Date().toISOString();
    const expirationMs = parseDuration(options.config.expiresIn || DEFAULT_EXPIRATION);
    const expiresAt = new Date(Date.now() + expirationMs).toISOString();

    const state: SessionState = {
      status: 'pending',
      createdAt: now,
      expiresAt,
    };

    // Write config file (session.md)
    await this.writeSessionConfig(sessionDir, options.config);

    // Write state file (state.yaml)
    await this.writeSessionState(sessionDir, state);

    logger.info(
      { sessionId, purpose: options.config.purpose, expiresIn: options.config.expiresIn },
      'Session created',
    );

    return {
      id: sessionId,
      config: options.config,
      state,
      folderPath: sessionDir,
    };
  }

  /**
   * Generate a session ID based on config purpose and UUID.
   */
  private generateSessionId(config: SessionConfig): string {
    const prefix = config.purpose || 'session';
    const shortId = uuidv4().split('-')[0];
    return `${prefix}-${shortId}`;
  }

  // ============================================================================
  // Read
  // ============================================================================

  /**
   * Read a session by ID.
   *
   * @param sessionId - Session ID (folder name)
   * @returns The session or undefined if not found
   */
  async get(sessionId: string): Promise<TemporarySession | undefined> {
    const sessionDir = path.join(this.sessionsDir, sessionId);

    try {
      const config = await this.readSessionConfig(sessionDir);
      const state = await this.readSessionState(sessionDir);

      return {
        id: sessionId,
        config,
        state,
        folderPath: sessionDir,
      };
    } catch (error) {
      logger.debug({ sessionId, error }, 'Session not found');
      return undefined;
    }
  }

  /**
   * List sessions with optional filtering.
   *
   * @param filter - Filter options
   * @returns Array of session summaries
   */
  async list(filter?: SessionFilterOptions): Promise<SessionSummary[]> {
    await this.ensureDir();

    let sessions: TemporarySession[];

    try {
      const entries = await fsPromises.readdir(this.sessionsDir, {
        withFileTypes: true,
      });
      const dirs = entries.filter(e => e.isDirectory());

      sessions = [];
      for (const dir of dirs) {
        const session = await this.get(dir.name);
        if (session) {
          sessions.push(session);
        }
      }
    } catch {
      sessions = [];
    }

    // Apply filters
    let filtered = sessions;

    if (filter?.status) {
      filtered = filtered.filter(s => s.state.status === filter.status);
    }

    if (filter?.purpose) {
      filtered = filtered.filter(s => s.config.purpose === filter.purpose);
    }

    if (!filter?.includeExpired) {
      filtered = filtered.filter(s => {
        if (s.state.status === 'expired') return false;
        if (isSessionExpired(s)) return false;
        return true;
      });
    }

    // Check for timed-out sent sessions
    for (const session of filtered) {
      if (session.state.status === 'sent' && isSessionExpired(session)) {
        await this.markAsExpired(session.id);
        session.state.status = 'expired';
      }
    }

    if (filter?.limit && filter.limit > 0) {
      filtered = filtered.slice(0, filter.limit);
    }

    // Map to summaries
    return filtered.map(s => this.toSummary(s));
  }

  /**
   * Get a session summary from a full session object.
   */
  private toSummary(session: TemporarySession): SessionSummary {
    return {
      id: session.id,
      status: session.state.status,
      purpose: session.config.purpose,
      type: session.config.type,
      channelTarget:
        session.config.channel.name || session.config.channel.chatId || 'unknown',
      createdAt: session.state.createdAt,
      expiresAt: session.state.expiresAt,
      hasResponse: !!session.state.response,
    };
  }

  /**
   * Find a session by message ID (used for card click handling).
   *
   * @param messageId - Message ID to search for
   * @returns The session or undefined if not found
   */
  async findByMessageId(messageId: string): Promise<TemporarySession | undefined> {
    const sessions = await this.list({ includeExpired: true });

    for (const summary of sessions) {
      const session = await this.get(summary.id);
      if (session?.state.messageId === messageId) {
        return session;
      }
    }

    return undefined;
  }

  // ============================================================================
  // State Transitions
  // ============================================================================

  /**
   * Mark a session as sent (after group creation and message delivery).
   *
   * Transitions: pending → sent
   *
   * @param sessionId - Session ID
   * @param chatId - Chat ID where message was sent
   * @param messageId - Message ID of the sent card
   */
  async markAsSent(
    sessionId: string,
    chatId: string,
    messageId: string,
  ): Promise<TemporarySession> {
    const session = await this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.state.status !== 'pending') {
      throw new Error(
        `Invalid state transition: ${session.state.status} → sent (expected pending)`,
      );
    }

    session.state.status = 'sent';
    session.state.chatId = chatId;
    session.state.messageId = messageId;
    session.state.sentAt = new Date().toISOString();

    await this.writeSessionState(session.folderPath, session.state);

    logger.info({ sessionId, chatId, messageId }, 'Session marked as sent');
    return session;
  }

  /**
   * Record user response to a session.
   *
   * Transitions: sent → replied
   *
   * @param sessionId - Session ID
   * @param response - User response data
   */
  async recordResponse(
    sessionId: string,
    response: SessionResponse,
  ): Promise<TemporarySession> {
    const session = await this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.state.status !== 'sent') {
      throw new Error(
        `Invalid state transition: ${session.state.status} → replied (expected sent)`,
      );
    }

    session.state.status = 'replied';
    session.state.response = response;

    await this.writeSessionState(session.folderPath, session.state);

    logger.info(
      { sessionId, selectedValue: response.selectedValue, responder: response.responder },
      'Session response recorded',
    );
    return session;
  }

  /**
   * Mark a session as expired (timeout).
   *
   * Transitions: sent → expired
   *
   * @param sessionId - Session ID
   * @param reason - Optional reason for expiration
   */
  async markAsExpired(sessionId: string, reason?: string): Promise<TemporarySession> {
    const session = await this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.state.status !== 'sent') {
      // Already in terminal state, return as-is
      return session;
    }

    session.state.status = 'expired';

    await this.writeSessionState(session.folderPath, session.state);

    logger.info({ sessionId, reason }, 'Session expired');
    return session;
  }

  // ============================================================================
  // File I/O
  // ============================================================================

  /**
   * Write session config as session.md (YAML frontmatter + Markdown).
   */
  private async writeSessionConfig(
    sessionDir: string,
    config: SessionConfig,
  ): Promise<void> {
    // Serialize config as YAML frontmatter
    const frontmatter = yaml.dump(config, {
      lineWidth: -1,
      noRefs: true,
      sortKeys: true,
    });

    const content = `---\n${frontmatter}---\n`;

    const configPath = path.join(sessionDir, SESSION_CONFIG_FILE);
    await fsPromises.writeFile(configPath, content, 'utf-8');
  }

  /**
   * Read session config from session.md.
   */
  private async readSessionConfig(sessionDir: string): Promise<SessionConfig> {
    const configPath = path.join(sessionDir, SESSION_CONFIG_FILE);
    const content = await fsPromises.readFile(configPath, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    return frontmatter as unknown as SessionConfig;
  }

  /**
   * Write session state as state.yaml.
   */
  private async writeSessionState(
    sessionDir: string,
    state: SessionState,
  ): Promise<void> {
    const statePath = path.join(sessionDir, SESSION_STATE_FILE);
    const content = yaml.dump(state, {
      lineWidth: -1,
      noRefs: true,
      sortKeys: true,
    });
    await fsPromises.writeFile(statePath, content, 'utf-8');
  }

  /**
   * Read session state from state.yaml.
   */
  private async readSessionState(sessionDir: string): Promise<SessionState> {
    const statePath = path.join(sessionDir, SESSION_STATE_FILE);
    const content = await fsPromises.readFile(statePath, 'utf-8');
    return yaml.load(content) as SessionState;
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Delete a session folder.
   *
   * @param sessionId - Session ID to delete
   */
  async delete(sessionId: string): Promise<void> {
    const sessionDir = path.join(this.sessionsDir, sessionId);

    try {
      await fsPromises.rm(sessionDir, { recursive: true, force: true });
      logger.info({ sessionId }, 'Session deleted');
    } catch (error) {
      logger.warn({ sessionId, error }, 'Failed to delete session');
    }
  }

  /**
   * Clean up expired sessions older than a given threshold.
   *
   * @param olderThan - Delete sessions expired before this date
   * @returns Number of sessions cleaned up
   */
  async cleanupExpired(olderThan?: Date): Promise<number> {
    const sessions = await this.list({ includeExpired: true });
    const threshold = olderThan || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
    let deleted = 0;

    for (const session of sessions) {
      if (
        (session.status === 'expired' || session.status === 'replied') &&
        new Date(session.createdAt) < threshold
      ) {
        await this.delete(session.id);
        deleted++;
      }
    }

    if (deleted > 0) {
      logger.info({ deleted, threshold: threshold.toISOString() }, 'Session cleanup completed');
    }

    return deleted;
  }
}
