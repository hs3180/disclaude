/**
 * BotChatMapping - File-based mapping table for Bot ↔ Feishu Chat ID relationships.
 *
 * Issue #2947: Maintains PR↔ChatId (and future) corresponding relationships.
 * Follows the ChatStore/CooldownManager pattern: file-based persistence + in-memory cache.
 *
 * Key design principles:
 * - Single JSON file (not per-record files) for efficient bulk reads
 * - Mapping table is a cache — all data can be rebuilt from Feishu API
 * - No state machine, no locks, no concurrency control (low-frequency operations)
 * - Extensible via `purpose` field for different use cases
 *
 * Storage location: workspace/bot-chat-mapping.json
 *
 * @module @disclaude/core/scheduling
 */

import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('BotChatMapping');

/**
 * A single mapping entry representing a context key → Feishu chat relationship.
 */
export interface BotChatMappingEntry {
  /** The Feishu chat ID */
  chatId: string;
  /** ISO timestamp of when the mapping was created */
  createdAt: string;
  /** Purpose/category of this mapping (e.g., 'pr-review', 'discussion') */
  purpose: string;
}

/**
 * The full mapping table structure stored as JSON.
 *
 * Keys are context identifiers like 'pr-123', 'discussion-456'.
 */
export interface BotChatMappingTable {
  [key: string]: BotChatMappingEntry;
}

/**
 * Options for the BotChatMapping constructor.
 */
export interface BotChatMappingOptions {
  /** Absolute path to the mapping JSON file (e.g., workspace/bot-chat-mapping.json) */
  filePath: string;
}

/**
 * Result of a rebuild operation from external data.
 */
export interface RebuildResult {
  /** Number of entries rebuilt */
  rebuilt: number;
  /** Number of entries that were already present and kept */
  kept: number;
  /** Total entries in the mapping after rebuild */
  total: number;
}

/**
 * BotChatMapping - Manages the bot-chat mapping table.
 *
 * Pure data storage utility, similar to ChatStore and CooldownManager.
 * Uses a single JSON file for all mappings (not per-record files)
 * since the mapping table is typically small and needs atomic bulk reads.
 *
 * Usage:
 * ```typescript
 * const mapping = new BotChatMapping({ filePath: './workspace/bot-chat-mapping.json' });
 *
 * // Write a mapping
 * await mapping.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
 *
 * // Look up by key
 * const entry = await mapping.get('pr-123');
 *
 * // Delete a mapping
 * await mapping.delete('pr-123');
 *
 * // Rebuild from external data
 * await mapping.rebuild([
 *   { key: 'pr-123', entry: { chatId: 'oc_xxx', createdAt: '...', purpose: 'pr-review' } }
 * ]);
 * ```
 */
export class BotChatMapping {
  private filePath: string;
  /** In-memory cache for fast lookups */
  private cache: Map<string, BotChatMappingEntry> = new Map();
  /** Whether the store has been initialized */
  private initialized = false;

  constructor(options: BotChatMappingOptions) {
    this.filePath = options.filePath;
    logger.info({ filePath: this.filePath }, 'BotChatMapping initialized');
  }

  /**
   * Ensure the mapping file exists and load existing records.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) { return; }

    try {
      // Ensure parent directory exists
      const dir = path.dirname(this.filePath);
      await fsPromises.mkdir(dir, { recursive: true });
      await this.loadFromFile();
      this.initialized = true;
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize BotChatMapping');
      // Continue without persistence on error
      this.initialized = true;
    }
  }

  /**
   * Load the mapping table from the JSON file into memory.
   */
  private async loadFromFile(): Promise<void> {
    try {
      const content = await fsPromises.readFile(this.filePath, 'utf-8');
      const table = JSON.parse(content) as BotChatMappingTable;

      for (const [key, entry] of Object.entries(table)) {
        this.cache.set(key, entry);
      }

      logger.debug({ count: this.cache.size }, 'Loaded bot-chat mapping entries');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist yet — start with empty cache
        logger.debug('No existing mapping file found, starting with empty cache');
      } else {
        logger.error({ err: error }, 'Error loading bot-chat mapping file');
      }
    }
  }

  /**
   * Persist the entire in-memory cache to the JSON file.
   */
  private async persist(): Promise<void> {
    const table: BotChatMappingTable = {};
    for (const [key, entry] of this.cache) {
      table[key] = entry;
    }

    try {
      await fsPromises.writeFile(
        this.filePath,
        JSON.stringify(table, null, 2),
        'utf-8'
      );
    } catch (error) {
      logger.error({ err: error }, 'Failed to persist bot-chat mapping file');
    }
  }

  /**
   * Get a mapping entry by key.
   *
   * @param key - The context key (e.g., 'pr-123')
   * @returns The mapping entry, or null if not found
   */
  async get(key: string): Promise<BotChatMappingEntry | null> {
    await this.ensureInitialized();
    return this.cache.get(key) ?? null;
  }

  /**
   * Check if a mapping entry exists for the given key.
   *
   * @param key - The context key (e.g., 'pr-123')
   * @returns true if the key exists in the mapping
   */
  async has(key: string): Promise<boolean> {
    await this.ensureInitialized();
    return this.cache.has(key);
  }

  /**
   * Set (create or update) a mapping entry.
   *
   * @param key - The context key (e.g., 'pr-123')
   * @param entry - The mapping entry data (chatId and purpose required; createdAt auto-generated if omitted)
   */
  async set(key: string, entry: Omit<BotChatMappingEntry, 'createdAt'> & { createdAt?: string }): Promise<void> {
    await this.ensureInitialized();

    const fullEntry: BotChatMappingEntry = {
      chatId: entry.chatId,
      createdAt: entry.createdAt ?? new Date().toISOString(),
      purpose: entry.purpose,
    };

    this.cache.set(key, fullEntry);
    await this.persist();

    logger.debug({ key, chatId: fullEntry.chatId, purpose: fullEntry.purpose }, 'Mapping entry set');
  }

  /**
   * Delete a mapping entry by key.
   *
   * @param key - The context key to remove
   * @returns true if the entry existed and was deleted, false otherwise
   */
  async delete(key: string): Promise<boolean> {
    await this.ensureInitialized();

    const existed = this.cache.delete(key);
    if (existed) {
      await this.persist();
      logger.debug({ key }, 'Mapping entry deleted');
    }

    return existed;
  }

  /**
   * List all mapping entries.
   *
   * @returns Array of all key-entry pairs
   */
  async list(): Promise<Array<{ key: string; entry: BotChatMappingEntry }>> {
    await this.ensureInitialized();

    const result: Array<{ key: string; entry: BotChatMappingEntry }> = [];
    for (const [key, entry] of this.cache) {
      result.push({ key, entry });
    }
    return result;
  }

  /**
   * List all mapping entries filtered by purpose.
   *
   * @param purpose - The purpose to filter by (e.g., 'pr-review')
   * @returns Array of matching key-entry pairs
   */
  async listByPurpose(purpose: string): Promise<Array<{ key: string; entry: BotChatMappingEntry }>> {
    await this.ensureInitialized();

    const result: Array<{ key: string; entry: BotChatMappingEntry }> = [];
    for (const [key, entry] of this.cache) {
      if (entry.purpose === purpose) {
        result.push({ key, entry });
      }
    }
    return result;
  }

  /**
   * Look up a key by chatId (reverse lookup).
   *
   * Useful when you have a chatId from a Feishu event and need to find
   * the corresponding context key.
   *
   * @param chatId - The Feishu chat ID to look up
   * @returns The key and entry, or null if not found
   */
  async findByChatId(chatId: string): Promise<{ key: string; entry: BotChatMappingEntry } | null> {
    await this.ensureInitialized();

    for (const [key, entry] of this.cache) {
      if (entry.chatId === chatId) {
        return { key, entry };
      }
    }
    return null;
  }

  /**
   * Rebuild the mapping table from external data.
   *
   * This is used when the mapping file is lost or corrupted.
   * The caller provides entries parsed from external sources
   * (e.g., Feishu bot chat list + naming convention parsing).
   *
   * Preserves existing entries that are also present in the provided data.
   * Existing entries not in the provided data are kept (not removed)
   * to avoid losing mappings that the external source may not cover.
   *
   * @param entries - Array of key-entry pairs to rebuild from
   * @returns Rebuild result statistics
   */
  async rebuild(entries: Array<{ key: string; entry: BotChatMappingEntry }>): Promise<RebuildResult> {
    await this.ensureInitialized();

    let kept = 0;
    let rebuilt = 0;

    for (const { key, entry } of entries) {
      const existing = this.cache.get(key);
      if (existing && existing.chatId === entry.chatId) {
        // Already present with same chatId — keep existing (preserves original createdAt)
        kept++;
      } else {
        // New or changed entry — write it
        this.cache.set(key, entry);
        rebuilt++;
      }
    }

    await this.persist();

    logger.info({ rebuilt, kept, total: this.cache.size }, 'Mapping table rebuilt');

    return {
      rebuilt,
      kept,
      total: this.cache.size,
    };
  }

  /**
   * Clear all mapping entries and persist the empty table.
   *
   * Mainly useful for testing or complete reset scenarios.
   */
  async clear(): Promise<void> {
    await this.ensureInitialized();
    this.cache.clear();
    await this.persist();
    logger.info('Mapping table cleared');
  }

  /**
   * Get the total number of mapping entries.
   */
  async size(): Promise<number> {
    await this.ensureInitialized();
    return this.cache.size;
  }
}
