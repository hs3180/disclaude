/**
 * ChatStore - File-based storage for temporary chat lifecycle records.
 *
 * Issue #1703: Phase 1 — Core data layer for temporary chat management.
 * Follows the CooldownManager pattern: file-based persistence + in-memory cache.
 *
 * Storage location: workspace/schedules/.temp-chats/{chatId}.json
 *
 * @module @disclaude/core/scheduling
 */

import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { TriggerMode } from '../config/types.js';

const logger = createLogger('ChatStore');

/**
 * Response recorded when a user interacts with a temporary chat.
 */
export interface TempChatResponse {
  /** The selected action value from the interactive card */
  selectedValue: string;
  /** The open_id of the user who responded */
  responder: string;
  /** ISO timestamp of the response */
  repliedAt: string;
}

/**
 * Temporary chat record stored per chat.
 */
export interface TempChatRecord {
  /** The chat ID being tracked */
  chatId: string;
  /** ISO timestamp of when the record was created */
  createdAt: string;
  /** ISO timestamp of when the chat should expire */
  expiresAt: string;
  /** Optional: the chat ID where the creation request originated */
  creatorChatId?: string;
  /** Optional: arbitrary context data attached at creation */
  context?: Record<string, unknown>;
  /** Response data, populated when a user interacts */
  response?: TempChatResponse;
  /**
   * Declarative passive mode configuration for this chat (legacy).
   * Retained for backward compatibility with persisted records only.
   * New code should use `triggerMode` instead.
   */
  passiveMode?: boolean;
  /**
   * Trigger mode configuration for this chat (Issue #2291, #3345).
   *
   * - `'mention'`: Bot only responds to @mentions
   * - `'always'`: Bot responds to all messages
   * - `'auto'`: Intelligent — responds to all when group has ≤2 members, mention-only otherwise (default)
   * - `undefined`: Use default behavior (`'auto'`)
   */
  triggerMode?: TriggerMode;
}


/**
 * ChatStore options.
 */
export interface ChatStoreOptions {
  /** Directory for temp chat state files */
  storeDir: string;
}

/**
 * ChatStore - Manages temporary chat lifecycle records.
 *
 * Pure data storage utility, similar to CooldownManager.
 * All operations are atomic: read → modify → write per-record.
 *
 * Records are created externally and loaded from disk on initialization.
 *
 * Usage:
 * ```typescript
 * const store = new ChatStore({ storeDir: './workspace/schedules/.temp-chats' });
 *
 * // Check for expired chats
 * const expired = await store.getExpiredTempChats();
 *
 * // Clean up
 * await store.removeTempChat('oc_xxx');
 * ```
 */
export class ChatStore {
  private storeDir: string;
  /** In-memory cache for fast lookups */
  private cache: Map<string, TempChatRecord> = new Map();
  /** Whether the store has been initialized */
  private initialized = false;

  constructor(options: ChatStoreOptions) {
    this.storeDir = options.storeDir;
    logger.info({ storeDir: this.storeDir }, 'ChatStore initialized');
  }

  /**
   * Ensure the store directory exists and load existing records.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) { return; }

    try {
      await fsPromises.mkdir(this.storeDir, { recursive: true });
      await this.loadAllRecords();
      this.initialized = true;
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize ChatStore');
      // Continue without persistence on error
      this.initialized = true;
    }
  }

  /**
   * Load all temp chat records from disk into memory.
   */
  private async loadAllRecords(): Promise<void> {
    try {
      const files = await fsPromises.readdir(this.storeDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));

      for (const file of jsonFiles) {
        try {
          const filePath = path.join(this.storeDir, file);
          const content = await fsPromises.readFile(filePath, 'utf-8');
          const record = JSON.parse(content) as TempChatRecord;

          // Always load into cache (expiry is checked lazily via getExpiredTempChats)
          this.cache.set(record.chatId, record);
        } catch {
          // Ignore parse errors for individual files
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
   * Get the file path for a chat's record.
   */
  private getFilePath(chatId: string): string {
    // Sanitize chat ID for filename
    const safeId = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.storeDir, `${safeId}.json`);
  }

  /**
   * Get a temp chat record by chat ID.
   *
   * @param chatId - The chat ID to look up
   * @returns The temp chat record, or null if not found
   */
  async getTempChat(chatId: string): Promise<TempChatRecord | null> {
    await this.ensureInitialized();
    return this.cache.get(chatId) ?? null;
  }

  /**
   * List all temp chat records.
   *
   * @returns Array of all temp chat records
   */
  async listTempChats(): Promise<TempChatRecord[]> {
    await this.ensureInitialized();
    return Array.from(this.cache.values());
  }

  /**
   * Remove a temp chat record.
   *
   * @param chatId - The chat ID to remove
   * @returns Whether the record was removed
   */
  async removeTempChat(chatId: string): Promise<boolean> {
    await this.ensureInitialized();

    // Remove from memory
    const existed = this.cache.delete(chatId);

    // Remove file
    try {
      const filePath = this.getFilePath(chatId);
      await fsPromises.unlink(filePath);
      logger.debug({ chatId }, 'Temp chat record removed');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: error, chatId }, 'Failed to remove temp chat file');
      }
    }

    return existed;
  }

  /**
   * Mark a temp chat as responded by a user.
   *
   * Atomically updates the record: reads from cache → modifies → writes to file.
   *
   * @param chatId - The chat ID to update
   * @param response - The response data
   * @returns Whether the record was found and updated
   */
  async markTempChatResponded(chatId: string, response: TempChatResponse): Promise<boolean> {
    await this.ensureInitialized();

    const record = this.cache.get(chatId);
    if (!record) {
      return false;
    }

    // Update in-memory record (spread to avoid mutation of cached object)
    const updatedRecord = { ...record, response };
    this.cache.set(chatId, updatedRecord);

    // Persist to file
    try {
      const filePath = this.getFilePath(chatId);
      await fsPromises.writeFile(filePath, JSON.stringify(updatedRecord, null, 2), 'utf-8');
      logger.debug({ chatId, responder: response.responder }, 'Temp chat marked as responded');
    } catch (error) {
      logger.error({ err: error, chatId }, 'Failed to persist temp chat response');
    }

    return true;
  }

  /**
   * Get all expired temp chat records (expiresAt < now, no response yet).
   *
   * @returns Array of expired temp chat records
   */
  async getExpiredTempChats(): Promise<TempChatRecord[]> {
    await this.ensureInitialized();

    const now = Date.now();
    const expired: TempChatRecord[] = [];

    for (const record of this.cache.values()) {
      const expiryTime = new Date(record.expiresAt).getTime();
      if (expiryTime < now && !record.response) {
        expired.push(record);
      }
    }

    return expired;
  }
}
