/**
 * BotChatMappingStore - File-based storage for bot group chat mappings.
 *
 * Issue #2947: Maintains the correspondence between context keys (e.g. "pr-123")
 * and Feishu group chat IDs. Enables quick lookups, avoids duplicate group
 * creation, and supports self-healing rebuild from Feishu API.
 *
 * Storage location: workspace/bot-chat-mapping.json
 *
 * Follows the ChatStore pattern: file-based persistence + in-memory cache.
 *
 * @module @disclaude/core/scheduling
 */

import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('BotChatMapping');

// ---- Types ----

/**
 * Purpose of a mapped group chat.
 * Different bot workflows create groups for different reasons.
 */
export type MappingPurpose = 'pr-review' | 'discussion' | (string & {});

/**
 * A single mapping entry: links a context key to a Feishu group chat.
 */
export interface MappingEntry {
  /** The Feishu group chat ID (oc_xxx format) */
  chatId: string;
  /** ISO timestamp of when the mapping was created */
  createdAt: string;
  /** Purpose of the group (e.g. "pr-review", "discussion") */
  purpose: MappingPurpose;
}

/**
 * The complete mapping table structure.
 * Keys are context identifiers like "pr-123", "discussion-456".
 */
export interface MappingTable {
  [key: string]: MappingEntry;
}

/**
 * Result of a rebuild operation from Feishu API scan.
 */
export interface RebuildResult {
  /** Total groups scanned from API */
  scanned: number;
  /** New mappings added */
  added: number;
  /** Existing mappings kept (unchanged) */
  kept: number;
  /** Mappings removed (key existed but group no longer in scan) */
  removed: number;
}

/**
 * BotChatMappingStore options.
 */
export interface BotChatMappingStoreOptions {
  /** Path to the mapping JSON file */
  filePath: string;
}

// ---- Constants ----

/**
 * Regex to parse PR review group names.
 * Expected format: `PR #123 · Some title text`
 * Captures the PR number for key generation.
 */
const PR_GROUP_NAME_REGEX = /^PR\s+#(\d+)\s*[·•\-–—]\s*/;

/**
 * Key prefix for PR review groups.
 */
const PR_KEY_PREFIX = 'pr-';

// ---- Helpers ----

/**
 * Generate a mapping key from a purpose and identifier.
 *
 * @param purpose - The purpose of the group
 * @param identifier - The identifier (e.g. PR number)
 * @returns A mapping key (e.g. "pr-123")
 */
export function makeMappingKey(purpose: string, identifier: string | number): string {
  switch (purpose) {
    case 'pr-review':
      return `${PR_KEY_PREFIX}${identifier}`;
    default:
      return `${purpose}-${identifier}`;
  }
}

/**
 * Parse a Feishu group name to extract a mapping key.
 *
 * Supports:
 * - `PR #123 · Title` → `pr-123`
 * - `PR #123 - Title` → `pr-123`
 *
 * Returns null if the group name doesn't match any known pattern.
 *
 * @param groupName - The Feishu group name to parse
 * @returns The extracted mapping key, or null
 */
export function parseGroupNameToKey(groupName: string): string | null {
  // PR review group pattern
  const prMatch = groupName.match(PR_GROUP_NAME_REGEX);
  if (prMatch) {
    return `${PR_KEY_PREFIX}${prMatch[1]}`;
  }

  // Future: add more patterns here for other group types

  return null;
}

/**
 * Determine the purpose from a mapping key.
 *
 * @param key - The mapping key
 * @returns The purpose string
 */
export function purposeFromKey(key: string): MappingPurpose {
  if (key.startsWith(PR_KEY_PREFIX)) {
    return 'pr-review';
  }
  // Default: extract prefix before first hyphen or the whole key
  const parts = key.split('-');
  return parts.length > 1 ? parts.slice(0, -1).join('-') : 'discussion';
}

// ---- Store ----

/**
 * BotChatMappingStore - Manages context-to-chatId mappings.
 *
 * Simple JSON file store with in-memory cache. Supports:
 * - Query: lookup chatId by key
 * - Write: add a new mapping
 * - Delete: remove a mapping entry
 * - Rebuild: reconstruct from Feishu group list scan
 *
 * Usage:
 * ```typescript
 * const store = new BotChatMappingStore({
 *   filePath: './workspace/bot-chat-mapping.json'
 * });
 *
 * // Write
 * await store.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
 *
 * // Query
 * const chatId = await store.get('pr-123');
 *
 * // Rebuild from Feishu API
 * const result = await store.rebuildFromGroupList(groups);
 * ```
 */
export class BotChatMappingStore {
  private filePath: string;
  /** In-memory cache for fast lookups */
  private cache: MappingTable = {};
  /** Whether the store has been initialized */
  private initialized = false;

  constructor(options: BotChatMappingStoreOptions) {
    this.filePath = options.filePath;
    logger.info({ filePath: this.filePath }, 'BotChatMappingStore initialized');
  }

  // ---- Initialization ----

  /**
   * Ensure the mapping file is loaded into memory.
   * Creates an empty file if it doesn't exist.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) { return; }

    try {
      const dir = path.dirname(this.filePath);
      await fsPromises.mkdir(dir, { recursive: true });

      try {
        const content = await fsPromises.readFile(this.filePath, 'utf-8');
        const parsed = JSON.parse(content) as MappingTable;
        // Validate structure
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          this.cache = parsed;
        } else {
          logger.warn('Mapping file has invalid structure, starting with empty cache');
          this.cache = {};
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // File doesn't exist yet — start with empty cache
          this.cache = {};
        } else if (error instanceof SyntaxError) {
          logger.warn({ err: error }, 'Mapping file has invalid JSON, starting with empty cache');
          this.cache = {};
        } else {
          throw error;
        }
      }

      this.initialized = true;
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize BotChatMappingStore');
      this.cache = {};
      this.initialized = true;
    }
  }

  /**
   * Persist the in-memory cache to disk.
   */
  private async persist(): Promise<void> {
    try {
      const content = `${JSON.stringify(this.cache, null, 2)  }\n`;
      // Atomic write: write to temp then rename
      const tmpFile = `${this.filePath}.${Date.now()}.tmp`;
      await fsPromises.writeFile(tmpFile, content, 'utf-8');
      await fsPromises.rename(tmpFile, this.filePath);
    } catch (error) {
      logger.error({ err: error }, 'Failed to persist mapping file');
    }
  }

  // ---- CRUD Operations ----

  /**
   * Look up a chatId by key.
   *
   * @param key - The context key (e.g. "pr-123")
   * @returns The mapping entry, or null if not found
   */
  async get(key: string): Promise<MappingEntry | null> {
    await this.ensureInitialized();
    return this.cache[key] ?? null;
  }

  /**
   * Check if a mapping exists for the given key.
   *
   * @param key - The context key
   * @returns Whether a mapping exists
   */
  async has(key: string): Promise<boolean> {
    await this.ensureInitialized();
    return key in this.cache;
  }

  /**
   * Set (or update) a mapping entry.
   *
   * @param key - The context key (e.g. "pr-123")
   * @param entry - Partial entry data (chatId required, purpose and createdAt optional)
   * @returns The full entry that was stored
   */
  async set(key: string, entry: Omit<MappingEntry, 'createdAt'> & { createdAt?: string }): Promise<MappingEntry> {
    await this.ensureInitialized();

    const fullEntry: MappingEntry = {
      chatId: entry.chatId,
      createdAt: entry.createdAt ?? new Date().toISOString(),
      purpose: entry.purpose,
    };

    this.cache[key] = fullEntry;
    await this.persist();

    logger.debug({ key, chatId: fullEntry.chatId }, 'Mapping entry set');
    return fullEntry;
  }

  /**
   * Remove a mapping entry by key.
   *
   * @param key - The context key to remove
   * @returns Whether the entry existed and was removed
   */
  async delete(key: string): Promise<boolean> {
    await this.ensureInitialized();

    if (!(key in this.cache)) {
      return false;
    }

    delete this.cache[key];
    await this.persist();

    logger.debug({ key }, 'Mapping entry deleted');
    return true;
  }

  /**
   * List all mapping entries.
   *
   * @returns Array of [key, entry] tuples
   */
  async list(): Promise<Array<[string, MappingEntry]>> {
    await this.ensureInitialized();
    return Object.entries(this.cache);
  }

  /**
   * Get all mappings filtered by purpose.
   *
   * @param purpose - The purpose to filter by
   * @returns Array of [key, entry] tuples matching the purpose
   */
  async listByPurpose(purpose: MappingPurpose): Promise<Array<[string, MappingEntry]>> {
    await this.ensureInitialized();
    return Object.entries(this.cache).filter(([, entry]) => entry.purpose === purpose);
  }

  // ---- Rebuild ----

  /**
   * Rebuild the mapping table from a list of Feishu groups.
   *
   * This is the self-healing mechanism: scan all bot groups via
   * `lark-cli im chats list --as bot`, parse group names to extract keys,
   * and rebuild the mapping table.
   *
   * Groups whose names don't match any known pattern are skipped.
   * Existing mappings not found in the scan are removed (group was dissolved).
   *
   * @param groups - Array of group objects from Feishu API ({ chatId, name })
   * @returns Rebuild statistics
   */
  async rebuildFromGroupList(groups: Array<{ chatId: string; name: string }>): Promise<RebuildResult> {
    await this.ensureInitialized();

    const result: RebuildResult = { scanned: 0, added: 0, kept: 0, removed: 0 };
    const scannedKeys = new Set<string>();

    for (const group of groups) {
      result.scanned++;

      const key = parseGroupNameToKey(group.name);
      if (!key) {
        // Group name doesn't match any known pattern — skip
        continue;
      }

      scannedKeys.add(key);

      if (key in this.cache) {
        // Existing mapping — update chatId if changed
        if (this.cache[key].chatId !== group.chatId) {
          this.cache[key] = {
            ...this.cache[key],
            chatId: group.chatId,
          };
          result.kept++;
        } else {
          result.kept++;
        }
      } else {
        // New mapping
        this.cache[key] = {
          chatId: group.chatId,
          createdAt: new Date().toISOString(),
          purpose: purposeFromKey(key),
        };
        result.added++;
      }
    }

    // Remove mappings whose key wasn't found in the scan
    for (const key of Object.keys(this.cache)) {
      if (!scannedKeys.has(key)) {
        delete this.cache[key];
        result.removed++;
      }
    }

    await this.persist();

    logger.info(
      { scanned: result.scanned, added: result.added, kept: result.kept, removed: result.removed },
      'Mapping rebuild completed',
    );

    return result;
  }

  // ---- Utility ----

  /**
   * Get the number of mappings in the store.
   */
  async size(): Promise<number> {
    await this.ensureInitialized();
    return Object.keys(this.cache).length;
  }

  /**
   * Clear all mappings and persist.
   */
  async clear(): Promise<void> {
    await this.ensureInitialized();
    this.cache = {};
    await this.persist();
    logger.info('All mapping entries cleared');
  }
}
