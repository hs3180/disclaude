/**
 * BotChatMappingStore - File-based storage for bot group chat mappings.
 *
 * Issue #2947: Maintains the correspondence between context keys (e.g. "pr-123")
 * and Feishu group chat IDs. Enables quick lookups, avoids duplicate group
 * creation, and supports self-healing rebuild from Feishu API.
 *
 * Storage location: workspace/bot-chat-mapping.json
 *
 * Follows the CooldownManager pattern: file-based persistence + in-memory cache.
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
  /** Optional: PR branch temp directory path, cleaned up when PR is closed */
  workdir?: string;
  /** Optional: ISO timestamp of the last inactivity reminder sent (Issue #3965) */
  lastReminderAt?: string;
  /** Optional: Number of inactivity reminders sent for escalation (Issue #3966) */
  reminderCount?: number;
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

/**
 * Reserved key prefix for project main-group declarations (Issue #5396).
 * Entries under this namespace map a normalized workdir → the group chat that
 * is the project's "main battlefield" chat. They share the same persistence
 * file and CRUD machinery as ordinary context mappings.
 */
const MAIN_GROUP_KEY_PREFIX = 'main-group:';

/**
 * Mapping purpose for main-group declaration entries.
 */
const MAIN_GROUP_PURPOSE = 'main-group';

/**
 * Build the reserved mapping key for a workdir's main-group declaration.
 * The workdir is resolved to an absolute path so the same project always maps
 * to one key regardless of how the caller spelled the path.
 */
export function makeMainGroupKey(workdir: string): string {
  return `${MAIN_GROUP_KEY_PREFIX}${path.resolve(workdir)}`;
}

/**
 * Normalize a workdir for main-group lookups (absolute, trailing separators removed).
 */
export function normalizeWorkdir(workdir: string): string {
  return path.resolve(workdir);
}

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
  /** Cached initialization promise to prevent concurrent init */
  private initPromise: Promise<void> | null = null;

  constructor(options: BotChatMappingStoreOptions) {
    this.filePath = options.filePath;
    logger.info({ filePath: this.filePath }, 'BotChatMappingStore initialized');
  }

  // ---- Initialization ----

  /**
   * Ensure the mapping file is loaded into memory.
   * Uses cached promise pattern to prevent concurrent initialization.
   * Creates an empty file if it doesn't exist.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) { return; }
    // Reuse the same promise for all concurrent callers
    this.initPromise = this.initPromise ?? this._init();
    await this.initPromise;
  }

  /**
   * Internal initialization logic.
   */
  private async _init(): Promise<void> {
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
   * Throws on failure so callers can detect persistence issues.
   */
  private async persist(): Promise<void> {
    const content = `${JSON.stringify(this.cache, null, 2)  }\n`;
    // Atomic write: write to temp then rename
    const tmpFile = `${this.filePath}.${Date.now()}.tmp`;
    try {
      await fsPromises.writeFile(tmpFile, content, 'utf-8');
      await fsPromises.rename(tmpFile, this.filePath);
    } catch (error) {
      // Clean up temp file on failure
      try { await fsPromises.unlink(tmpFile); } catch {}
      logger.error({ err: error }, 'Failed to persist mapping file');
      throw error;
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
  async set(key: string, entry: Omit<MappingEntry, 'createdAt'> & { createdAt?: string }): Promise<MappingEntry & { persisted: boolean }> {
    await this.ensureInitialized();

    const fullEntry: MappingEntry = {
      ...this.cache[key],
      chatId: entry.chatId,
      createdAt: entry.createdAt ?? this.cache[key]?.createdAt ?? new Date().toISOString(),
      purpose: entry.purpose,
      ...(entry.workdir !== undefined && entry.workdir !== null ? { workdir: entry.workdir } : {}),
      ...(entry.lastReminderAt !== undefined && entry.lastReminderAt !== null ? { lastReminderAt: entry.lastReminderAt } : {}),
      ...(entry.reminderCount !== undefined ? { reminderCount: entry.reminderCount } : {}),
    };

    this.cache[key] = fullEntry;
    let persisted = true;
    try {
      await this.persist();
    } catch {
      persisted = false;
    }

    logger.debug({ key, chatId: fullEntry.chatId, persisted }, 'Mapping entry set');
    return { ...fullEntry, persisted };
  }

  /**
   * Partially update a mapping entry (e.g. reminder fields).
   * Preserves all existing fields; only the provided fields are overwritten.
   * Returns null if the key does not exist.
   *
   * @param key - The context key (e.g. "pr-123")
   * @param partial - Fields to update
   * @returns The updated entry, or null if key not found
   */
  async update(key: string, partial: Partial<MappingEntry>): Promise<MappingEntry | null> {
    await this.ensureInitialized();

    if (!(key in this.cache)) {
      return null;
    }

    this.cache[key] = { ...this.cache[key], ...partial };
    try {
      await this.persist();
    } catch (error) {
      logger.error({ err: error, key }, 'Failed to persist after update');
    }

    logger.debug({ key, partial }, 'Mapping entry updated');
    return this.cache[key];
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
    try {
      await this.persist();
    } catch (error) {
      logger.error({ err: error, key }, 'Failed to persist after deletion');
    }

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

  // ---- Main-group declarations (Issue #5396) ----

  /**
   * Look up the declared main-group chatId for a project workdir.
   *
   * @param workdir - The project working directory (any spelling; normalized internally)
   * @returns The main-group chatId, or null when no declaration exists
   */
  async getMainGroup(workdir: string): Promise<string | null> {
    await this.ensureInitialized();
    const entry = this.cache[makeMainGroupKey(workdir)];
    return entry?.chatId ?? null;
  }

  /**
   * Declare (or switch) the main-group chat for a project workdir.
   *
   * Persisting workdir → main-group chatId is the runtime carrier for the
   * project's "main battlefield" chat (Issue #5396). Group creation flows and
   * the explicit `/main-group` command both land here. Callers use the
   * returned `previousChatId` to send the old group a one-time migration
   * notice when the declaration switches an existing main group.
   *
   * @param workdir - The project working directory
   * @param chatId - The Feishu group chat to declare as main
   * @returns The previous main-group chatId (null on first declaration) and persistence flag
   */
  async declareMainGroup(
    workdir: string,
    chatId: string,
  ): Promise<{ previousChatId: string | null; persisted: boolean }> {
    const key = makeMainGroupKey(workdir);
    const previousChatId = (await this.getMainGroup(workdir)) ?? null;
    const result = await this.set(key, { chatId, purpose: MAIN_GROUP_PURPOSE, workdir: normalizeWorkdir(workdir) });
    logger.info({ workdir: normalizeWorkdir(workdir), chatId, previousChatId }, 'Main group declared');
    return { previousChatId, persisted: result.persisted };
  }

  /**
   * Remove a workdir's main-group declaration.
   *
   * @param workdir - The project working directory
   * @returns Whether a declaration existed and was removed
   */
  async clearMainGroup(workdir: string): Promise<boolean> {
    await this.ensureInitialized();
    const key = makeMainGroupKey(workdir);
    if (!(key in this.cache)) { return false; }
    delete this.cache[key];
    try {
      await this.persist();
    } catch (error) {
      logger.error({ err: error, key }, 'Failed to persist after main-group clear');
    }
    return true;
  }

  /**
   * Reverse lookup: find the project mapping entry for a chat.
   *
   * Used by the message entrypoint to learn which workdir a group belongs to
   * (Issue #5396). Reserved main-group declaration entries are excluded —
   * only ordinary context mappings (e.g. `pr-123` with a workdir) identify a
   * chat's project.
   *
   * @param chatId - The Feishu chat ID
   * @returns The first mapping entry carrying this chatId, or null
   */
  async findEntryByChatId(chatId: string): Promise<MappingEntry | null> {
    await this.ensureInitialized();
    for (const [key, entry] of Object.entries(this.cache)) {
      if (key.startsWith(MAIN_GROUP_KEY_PREFIX)) { continue; }
      if (entry.chatId === chatId) { return entry; }
    }
    return null;
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
   *
   * By default, this is **append-only**: existing mappings not found in the scan
   * are kept (the scan may be incomplete due to network issues or pagination).
   * Pass `{ removeStale: true }` to remove mappings not found in the scan.
   *
   * @param groups - Array of group objects from Feishu API ({ chatId, name })
   * @param options.removeStale - If true, remove mappings not present in the scan (default: false)
   * @returns Rebuild statistics
   */
  async rebuildFromGroupList(
    groups: Array<{ chatId: string; name: string }>,
    options: { removeStale?: boolean } = {},
  ): Promise<RebuildResult> {
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

    // Only remove mappings not found in scan when explicitly requested.
    // Main-group declarations (Issue #5396) are never derived from group
    // names, so a name scan can never confirm them — keep them unconditionally.
    if (options.removeStale) {
      for (const key of Object.keys(this.cache)) {
        if (key.startsWith(MAIN_GROUP_KEY_PREFIX)) { continue; }
        if (!scannedKeys.has(key)) {
          delete this.cache[key];
          result.removed++;
        }
      }
    }

    await this.persist();

    logger.info(
      { scanned: result.scanned, added: result.added, kept: result.kept, removed: result.removed, removeStale: options.removeStale ?? false },
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
    try {
      await this.persist();
    } catch (error) {
      logger.error({ err: error }, 'Failed to persist after clear');
    }
    logger.info('All mapping entries cleared');
  }
}
