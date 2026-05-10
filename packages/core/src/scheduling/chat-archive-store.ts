/**
 * ChatArchiveStore - Persistent archive for completed temporary group chats.
 *
 * Issue #2191: Unified group chat records — archive, summarize, and retrieve.
 *
 * When a temporary group chat is closed (completed or expired), its record
 * is archived here instead of being deleted. Each archive includes:
 * - Original creation context (topic, purpose, initiator)
 * - Generated summary (key conclusions, action items)
 * - Full lifecycle metadata (created, active, closed timestamps)
 *
 * Storage location: workspace/chat-archives/{chatId}.json
 * Index file: workspace/chat-archives/index.json
 *
 * @module @disclaude/core/scheduling
 */

import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ChatArchiveStore');

// ---- Types ----

/**
 * Lifecycle status of an archived chat.
 */
export type ArchiveStatus = 'completed' | 'expired';

/**
 * Summary generated when a chat is archived.
 */
export interface ChatSummary {
  /** Brief description of what was discussed */
  topic: string;
  /** Key conclusions reached during the discussion */
  conclusions: string[];
  /** Action items identified during the discussion */
  actionItems: string[];
  /** ISO timestamp of when the summary was generated */
  generatedAt: string;
}

/**
 * An archived temporary group chat record.
 *
 * Extends the TempChatRecord concept with archival data:
 * summary, lifecycle timestamps, and persistent status.
 */
export interface ArchivedChatRecord {
  /** The chat ID (oc_xxx format) */
  chatId: string;
  /** ISO timestamp of when the original temp chat was created */
  createdAt: string;
  /** ISO timestamp of when the chat was archived (closed) */
  closedAt: string;
  /** Why the chat was created */
  topic: string;
  /** Purpose/type of the group chat */
  purpose: string;
  /** The chat ID where the creation request originated */
  creatorChatId?: string;
  /** Open IDs of participants involved in the discussion */
  participants: string[];
  /** Lifecycle status */
  status: ArchiveStatus;
  /** Generated summary (may be absent if chat expired without activity) */
  summary?: ChatSummary;
  /** Arbitrary context data from the original temp chat */
  context?: Record<string, unknown>;
  /** Total number of messages exchanged during the chat */
  messageCount?: number;
}

/**
 * Index entry for quick lookups without loading full archives.
 */
export interface ArchiveIndexEntry {
  chatId: string;
  topic: string;
  purpose: string;
  createdAt: string;
  closedAt: string;
  status: ArchiveStatus;
}

/**
 * ChatArchiveStore options.
 */
export interface ChatArchiveStoreOptions {
  /** Directory for archived chat records */
  archiveDir: string;
}

// ---- Store ----

/**
 * ChatArchiveStore - Manages persistent archives of completed temporary chats.
 *
 * File-based storage following the ChatStore pattern:
 * - Individual JSON files per archived chat: `{archiveDir}/{chatId}.json`
 * - Index file for fast lookups: `{archiveDir}/index.json`
 *
 * Usage:
 * ```typescript
 * const archive = new ChatArchiveStore({ archiveDir: './workspace/chat-archives' });
 *
 * // Archive a completed chat
 * await archive.archive(record);
 *
 * // List recent archives
 * const recent = await archive.listArchives({ limit: 10 });
 *
 * // Search by topic
 * const results = await archive.search('deployment');
 * ```
 */
export class ChatArchiveStore {
  private archiveDir: string;
  /** In-memory cache of index entries for fast lookups */
  private indexCache: Map<string, ArchiveIndexEntry> = new Map();
  /** Whether the store has been initialized */
  private initialized = false;

  constructor(options: ChatArchiveStoreOptions) {
    this.archiveDir = options.archiveDir;
    logger.info({ archiveDir: this.archiveDir }, 'ChatArchiveStore initialized');
  }

  // ---- Initialization ----

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) { return; }

    try {
      await fsPromises.mkdir(this.archiveDir, { recursive: true });
      await this.loadIndex();
      this.initialized = true;
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize ChatArchiveStore');
      this.initialized = true;
    }
  }

  /**
   * Load the index file into memory.
   */
  private async loadIndex(): Promise<void> {
    const indexPath = path.join(this.archiveDir, 'index.json');
    try {
      const content = await fsPromises.readFile(indexPath, 'utf-8');
      const entries = JSON.parse(content) as ArchiveIndexEntry[];
      for (const entry of entries) {
        this.indexCache.set(entry.chatId, entry);
      }
      logger.debug({ count: this.indexCache.size }, 'Loaded archive index');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: error }, 'Error loading archive index');
      }
      // Start with empty index
    }
  }

  /**
   * Persist the in-memory index to disk.
   */
  private async persistIndex(): Promise<void> {
    const indexPath = path.join(this.archiveDir, 'index.json');
    const entries = Array.from(this.indexCache.values());
    const content = JSON.stringify(entries, null, 2);
    try {
      await fsPromises.writeFile(indexPath, content, 'utf-8');
    } catch (error) {
      logger.error({ err: error }, 'Failed to persist archive index');
    }
  }

  /**
   * Sanitize a chat ID for use as a filename.
   */
  private getFilePath(chatId: string): string {
    const safeId = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.archiveDir, `${safeId}.json`);
  }

  // ---- Core Operations ----

  /**
   * Archive a completed temporary chat record.
   *
   * Writes the full record to a JSON file and updates the index.
   * If a record with the same chatId already exists, it is overwritten.
   *
   * @param record - The archived chat record to store
   */
  async archive(record: ArchivedChatRecord): Promise<void> {
    await this.ensureInitialized();

    // Write individual record file
    const filePath = this.getFilePath(record.chatId);
    try {
      await fsPromises.writeFile(filePath, JSON.stringify(record, null, 2), 'utf-8');
    } catch (error) {
      logger.error({ err: error, chatId: record.chatId }, 'Failed to write archive record');
      throw error;
    }

    // Update index
    const indexEntry: ArchiveIndexEntry = {
      chatId: record.chatId,
      topic: record.topic,
      purpose: record.purpose,
      createdAt: record.createdAt,
      closedAt: record.closedAt,
      status: record.status,
    };
    this.indexCache.set(record.chatId, indexEntry);
    await this.persistIndex();

    logger.info({ chatId: record.chatId, status: record.status }, 'Chat archived');
  }

  /**
   * Get a specific archived chat record.
   *
   * @param chatId - The chat ID to look up
   * @returns The archived record, or null if not found
   */
  async getArchive(chatId: string): Promise<ArchivedChatRecord | null> {
    await this.ensureInitialized();

    if (!this.indexCache.has(chatId)) {
      return null;
    }

    const filePath = this.getFilePath(chatId);
    try {
      const content = await fsPromises.readFile(filePath, 'utf-8');
      return JSON.parse(content) as ArchivedChatRecord;
    } catch {
      logger.warn({ chatId }, 'Archive record referenced in index but file not found');
      return null;
    }
  }

  /**
   * List archived chats, sorted by closedAt descending (most recent first).
   *
   * @param options.filter - Filter by status
   * @param options.purpose - Filter by purpose
   * @param options.limit - Maximum number of results (default: 50)
   * @param options.offset - Offset for pagination (default: 0)
   * @returns Array of archived chat records
   */
  async listArchives(options?: {
    filter?: ArchiveStatus;
    purpose?: string;
    limit?: number;
    offset?: number;
  }): Promise<ArchivedChatRecord[]> {
    await this.ensureInitialized();

    const { filter, purpose, limit = 50, offset = 0 } = options ?? {};

    // Collect matching entries from index
    let entries = Array.from(this.indexCache.values());

    if (filter) {
      entries = entries.filter(e => e.status === filter);
    }
    if (purpose) {
      entries = entries.filter(e => e.purpose === purpose);
    }

    // Sort by closedAt descending
    entries.sort((a, b) => b.closedAt.localeCompare(a.closedAt));

    // Apply pagination
    const paged = entries.slice(offset, offset + limit);

    // Load full records
    const records: ArchivedChatRecord[] = [];
    for (const entry of paged) {
      const record = await this.getArchive(entry.chatId);
      if (record) {
        records.push(record);
      }
    }

    return records;
  }

  /**
   * Search archived chats by keyword.
   *
   * Searches in topic, purpose, summary conclusions, and action items.
   *
   * @param query - The search keyword
   * @param options.limit - Maximum results (default: 20)
   * @returns Array of matching archived chat records
   */
  async search(query: string, options?: { limit?: number }): Promise<ArchivedChatRecord[]> {
    await this.ensureInitialized();

    const { limit = 20 } = options ?? {};
    const lowerQuery = query.toLowerCase();
    const results: ArchivedChatRecord[] = [];

    // Search through index entries first, then load full records for deeper matching
    for (const entry of this.indexCache.values()) {
      // Quick match on index fields
      if (
        entry.topic.toLowerCase().includes(lowerQuery) ||
        entry.purpose.toLowerCase().includes(lowerQuery)
      ) {
        const record = await this.getArchive(entry.chatId);
        if (record) {
          results.push(record);
        }
        if (results.length >= limit) { break; }
        continue;
      }

      // Deep match on full record (summary content)
      const record = await this.getArchive(entry.chatId);
      if (record?.summary) {
        const matchInSummary =
          record.summary.conclusions.some(c => c.toLowerCase().includes(lowerQuery)) ||
          record.summary.actionItems.some(a => a.toLowerCase().includes(lowerQuery));
        if (matchInSummary) {
          results.push(record);
          if (results.length >= limit) { break; }
        }
      }
    }

    return results;
  }

  /**
   * Get the total number of archived chats.
   */
  async count(): Promise<number> {
    await this.ensureInitialized();
    return this.indexCache.size;
  }

  /**
   * Get statistics about archived chats.
   */
  async stats(): Promise<{
    total: number;
    completed: number;
    expired: number;
    withSummary: number;
  }> {
    await this.ensureInitialized();

    let completed = 0;
    let expired = 0;
    let withSummary = 0;

    for (const entry of this.indexCache.values()) {
      if (entry.status === 'completed') { completed++; }
      if (entry.status === 'expired') { expired++; }
    }

    // Count records with summaries (need to check files)
    // For efficiency, sample a subset if there are too many
    const sampleSize = Math.min(this.indexCache.size, 100);
    const entries = Array.from(this.indexCache.values()).slice(0, sampleSize);

    for (const entry of entries) {
      const record = await this.getArchive(entry.chatId);
      if (record?.summary) { withSummary++; }
    }

    // Extrapolate if sampled
    if (this.indexCache.size > sampleSize) {
      withSummary = Math.round((withSummary / sampleSize) * this.indexCache.size);
    }

    return {
      total: this.indexCache.size,
      completed,
      expired,
      withSummary,
    };
  }

  /**
   * Delete an archived chat record.
   *
   * @param chatId - The chat ID to delete
   * @returns Whether the record existed and was deleted
   */
  async deleteArchive(chatId: string): Promise<boolean> {
    await this.ensureInitialized();

    if (!this.indexCache.has(chatId)) {
      return false;
    }

    // Remove from index
    this.indexCache.delete(chatId);
    await this.persistIndex();

    // Remove file
    const filePath = this.getFilePath(chatId);
    try {
      await fsPromises.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: error, chatId }, 'Failed to delete archive file');
      }
    }

    logger.info({ chatId }, 'Archive record deleted');
    return true;
  }
}
