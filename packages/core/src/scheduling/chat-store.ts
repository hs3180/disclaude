/**
 * TempChatStore - Manages temporary chat lifecycle records.
 *
 * Issue #1703: Core data layer for temporary chat lifecycle management.
 * Follows the CooldownManager pattern: file-based persistence with in-memory cache.
 *
 * Features:
 * - File-based persistence (survives restarts)
 * - Memory + file dual storage for performance
 * - Automatic lookup of expired records for cleanup
 *
 * Storage location: workspace/temp-chats/{chatId}.json
 *
 * @module @disclaude/core/scheduling
 */

import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TempChatStore');

/**
 * User response record for a temporary chat.
 */
export interface TempChatResponse {
  /** The value of the button the user clicked */
  selectedValue: string;
  /** User identifier who responded */
  responder: string;
  /** ISO timestamp of when the user responded */
  repliedAt: string;
}

/**
 * Temporary chat record stored per chat.
 */
export interface TempChatRecord {
  /** Chat ID of the temporary group */
  chatId: string;
  /** ISO timestamp of when the record was created */
  createdAt: string;
  /** ISO timestamp of when the chat should expire */
  expiresAt: string;
  /** Chat ID of the group where the creation request originated (optional) */
  creatorChatId?: string;
  /** Arbitrary context data associated with this temp chat */
  context?: Record<string, unknown>;
  /** User response, if the user has interacted */
  response?: TempChatResponse;
}

/**
 * Options for registering a temporary chat.
 */
export interface RegisterTempChatOptions {
  /** Chat ID of the temporary group */
  chatId: string;
  /** ISO timestamp of when the chat should expire (defaults to 24h from now) */
  expiresAt?: string;
  /** Chat ID of the group where the creation request originated */
  creatorChatId?: string;
  /** Arbitrary context data */
  context?: Record<string, unknown>;
}

/**
 * TempChatStore options.
 */
export interface TempChatStoreOptions {
  /** Directory for temp chat state files */
  tempChatsDir: string;
}

/**
 * TempChatStore - Manages temporary chat lifecycle records.
 *
 * Usage:
 * ```typescript
 * const store = new TempChatStore({ tempChatsDir: './workspace/temp-chats' });
 *
 * // Register a temporary chat
 * await store.registerTempChat({ chatId: 'oc_xxx', expiresAt: '2026-03-29T00:00:00Z' });
 *
 * // List all temp chats
 * const chats = await store.listTempChats();
 *
 * // Get expired chats for cleanup
 * const expired = await store.getExpiredTempChats();
 *
 * // Remove a temp chat record
 * await store.removeTempChat('oc_xxx');
 * ```
 */
export class TempChatStore {
  private tempChatsDir: string;
  /** In-memory cache for fast lookups */
  private cache: Map<string, TempChatRecord> = new Map();
  /** Whether the store has been initialized */
  private initialized = false;

  /** Default TTL: 24 hours in milliseconds */
  static readonly DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

  constructor(options: TempChatStoreOptions) {
    this.tempChatsDir = options.tempChatsDir;
    logger.info({ tempChatsDir: this.tempChatsDir }, 'TempChatStore initialized');
  }

  /**
   * Ensure the temp chats directory exists and load existing records.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) { return; }

    try {
      await fsPromises.mkdir(this.tempChatsDir, { recursive: true });
      await this.loadAllRecords();
      this.initialized = true;
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize TempChatStore');
      // Continue without persistence on error
      this.initialized = true;
    }
  }

  /**
   * Load all temp chat records from disk into memory.
   */
  private async loadAllRecords(): Promise<void> {
    try {
      const files = await fsPromises.readdir(this.tempChatsDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));

      for (const file of jsonFiles) {
        try {
          const filePath = path.join(this.tempChatsDir, file);
          const content = await fsPromises.readFile(filePath, 'utf-8');
          const record = JSON.parse(content) as TempChatRecord;

          // Always load (expired records may need cleanup by lifecycle service)
          this.cache.set(record.chatId, record);
        } catch {
          // Ignore parse errors
        }
      }

      logger.debug({ count: this.cache.size }, 'Loaded temp chat records');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: error }, 'Error loading temp chat records');
      }
    }
  }

  /**
   * Get the file path for a chat's temp record.
   */
  private getFilePath(chatId: string): string {
    // Sanitize chat ID for filename
    const safeId = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.tempChatsDir, `${safeId}.json`);
  }

  /**
   * Register a temporary chat, beginning its lifecycle tracking.
   *
   * @param opts - Registration options
   * @returns The created record
   * @throws Error if a record already exists for the given chatId
   */
  async registerTempChat(opts: RegisterTempChatOptions): Promise<TempChatRecord> {
    await this.ensureInitialized();

    const { chatId } = opts;

    // Prevent duplicate registration
    if (this.cache.has(chatId)) {
      throw new Error(`Temp chat already registered: ${chatId}`);
    }

    const now = new Date();
    const expiresAt = opts.expiresAt
      ? new Date(opts.expiresAt)
      : new Date(now.getTime() + TempChatStore.DEFAULT_TTL_MS);

    const record: TempChatRecord = {
      chatId,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      creatorChatId: opts.creatorChatId,
      context: opts.context,
    };

    // Update memory cache
    this.cache.set(chatId, record);

    // Persist to file
    try {
      const filePath = this.getFilePath(chatId);
      await fsPromises.writeFile(filePath, JSON.stringify(record, null, 2), 'utf-8');
      logger.debug({ chatId, expiresAt: record.expiresAt }, 'Registered temp chat');
    } catch (error) {
      logger.error({ err: error, chatId }, 'Failed to persist temp chat record');
    }

    return record;
  }

  /**
   * Get a temporary chat record by chatId.
   *
   * @param chatId - Chat ID to look up
   * @returns The record, or null if not found
   */
  async getTempChat(chatId: string): Promise<TempChatRecord | null> {
    await this.ensureInitialized();

    return this.cache.get(chatId) ?? null;
  }

  /**
   * List all temporary chat records.
   *
   * @returns Array of all temp chat records
   */
  async listTempChats(): Promise<TempChatRecord[]> {
    await this.ensureInitialized();

    return Array.from(this.cache.values());
  }

  /**
   * Remove a temporary chat record.
   *
   * @param chatId - Chat ID to remove
   * @returns true if the record existed and was removed, false otherwise
   */
  async removeTempChat(chatId: string): Promise<boolean> {
    await this.ensureInitialized();

    // Remove from memory
    const existed = this.cache.delete(chatId);

    // Remove file
    try {
      const filePath = this.getFilePath(chatId);
      await fsPromises.unlink(filePath);
      logger.debug({ chatId }, 'Removed temp chat record');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: error, chatId }, 'Failed to remove temp chat file');
      }
    }

    return existed;
  }

  /**
   * Record a user response to a temporary chat.
   *
   * @param chatId - Chat ID of the temporary chat
   * @param response - The user's response
   * @returns The updated record, or null if not found
   */
  async markTempChatResponded(chatId: string, response: TempChatResponse): Promise<TempChatRecord | null> {
    await this.ensureInitialized();

    const record = this.cache.get(chatId);
    if (!record) {
      return null;
    }

    record.response = response;

    // Persist updated record
    try {
      const filePath = this.getFilePath(chatId);
      await fsPromises.writeFile(filePath, JSON.stringify(record, null, 2), 'utf-8');
      logger.debug({ chatId, responder: response.responder }, 'Marked temp chat as responded');
    } catch (error) {
      logger.error({ err: error, chatId }, 'Failed to persist updated temp chat record');
    }

    return record;
  }

  /**
   * Get all expired temporary chat records that haven't been cleaned up yet.
   *
   * Used by the lifecycle service to identify chats that need dissolution.
   *
   * @returns Array of expired temp chat records
   */
  async getExpiredTempChats(): Promise<TempChatRecord[]> {
    await this.ensureInitialized();

    const now = Date.now();
    const expired: TempChatRecord[] = [];

    for (const record of this.cache.values()) {
      const expiresAt = new Date(record.expiresAt).getTime();
      if (now > expiresAt) {
        expired.push(record);
      }
    }

    return expired;
  }
}
