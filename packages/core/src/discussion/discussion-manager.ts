/**
 * Discussion Manager - manages offline discussion lifecycle (Issue #631).
 *
 * Tracks discussion records, handles persistence, and provides
 * query methods for active/completed discussions.
 *
 * This is a pure data management layer. The actual group creation
 * and agent spawning are handled by DiscussionService in primary-node.
 *
 * @module core/discussion/discussion-manager
 */

import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from '../utils/logger.js';
import type {
  DiscussionRecord,
  DiscussionStatus,
  CreateDiscussionOptions,
  ConcludeDiscussionOptions,
  DiscussionManagerConfig,
} from './types.js';

const logger = createLogger('DiscussionManager');

/** Default max discussion duration: 24 hours */
const DEFAULT_MAX_DURATION_MINUTES = 1440;

/**
 * Discussion Manager.
 *
 * Manages the lifecycle of offline discussions:
 * - Create discussion records
 * - Track status transitions
 * - Persist to disk
 * - Query active/completed discussions
 * - Auto-expire stale discussions
 */
export class DiscussionManager {
  private discussions = new Map<string, DiscussionRecord>();
  private readonly maxDurationMinutes: number;
  private readonly persistencePath?: string;
  private persistenceDirty = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: DiscussionManagerConfig = {}) {
    this.maxDurationMinutes = config.defaultMaxDurationMinutes ?? DEFAULT_MAX_DURATION_MINUTES;
    this.persistencePath = config.persistencePath;

    if (this.persistencePath) {
      this.load();
      // Periodic flush every 30 seconds
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, 30_000);
      if ('unref' in this.flushTimer) {
        this.flushTimer.unref();
      }
    }
  }

  /**
   * Create a new discussion record.
   *
   * @returns The newly created discussion record
   */
  createDiscussion(options: CreateDiscussionOptions): DiscussionRecord {
    const id = randomUUID();
    const now = Date.now();

    const record: DiscussionRecord = {
      id,
      chatId: '', // Will be set by DiscussionService when group is created
      sourceChatId: options.sourceChatId,
      creatorOpenId: options.creatorOpenId,
      topic: options.topic,
      status: 'creating',
      createdAt: now,
      updatedAt: now,
    };

    this.discussions.set(id, record);
    this.markDirty();

    logger.info({
      discussionId: id,
      topic: options.topic.title,
      sourceChatId: options.sourceChatId,
    }, 'Discussion record created');

    return record;
  }

  /**
   * Activate a discussion after the group has been created.
   *
   * @param discussionId - The discussion ID
   * @param chatId - The Feishu chat ID of the created group
   * @returns The updated record, or undefined if not found
   */
  activateDiscussion(discussionId: string, chatId: string): DiscussionRecord | undefined {
    const record = this.discussions.get(discussionId);
    if (!record) {
      logger.warn({ discussionId }, 'Cannot activate: discussion not found');
      return undefined;
    }

    if (record.status !== 'creating') {
      logger.warn({
        discussionId,
        currentStatus: record.status,
      }, 'Cannot activate: discussion not in creating status');
      return undefined;
    }

    record.chatId = chatId;
    record.status = 'active';
    record.updatedAt = Date.now();
    this.markDirty();

    logger.info({
      discussionId,
      chatId,
    }, 'Discussion activated');

    return record;
  }

  /**
   * Conclude a discussion with results.
   *
   * @returns The updated record, or undefined if not found
   */
  concludeDiscussion(options: ConcludeDiscussionOptions): DiscussionRecord | undefined {
    const record = this.findByChatId(options.chatId);
    if (!record) {
      logger.warn({ chatId: options.chatId }, 'Cannot conclude: discussion not found');
      return undefined;
    }

    if (record.status !== 'active') {
      logger.warn({
        chatId: options.chatId,
        currentStatus: record.status,
      }, 'Cannot conclude: discussion not active');
      return undefined;
    }

    record.status = 'concluded';
    record.result = options.result;
    record.concludedAt = Date.now();
    record.updatedAt = Date.now();
    this.markDirty();

    logger.info({
      discussionId: record.id,
      chatId: options.chatId,
      outcome: options.result.outcome,
    }, 'Discussion concluded');

    return record;
  }

  /**
   * Expire a discussion (timed out without conclusion).
   *
   * @returns The updated record, or undefined if not found
   */
  expireDiscussion(discussionId: string): DiscussionRecord | undefined {
    const record = this.discussions.get(discussionId);
    if (!record || record.status !== 'active') {
      return undefined;
    }

    record.status = 'expired';
    record.updatedAt = Date.now();
    this.markDirty();

    logger.info({ discussionId, chatId: record.chatId }, 'Discussion expired');
    return record;
  }

  /**
   * Find a discussion by its ID.
   */
  getDiscussion(discussionId: string): DiscussionRecord | undefined {
    return this.discussions.get(discussionId);
  }

  /**
   * Find a discussion by its chat ID.
   */
  findByChatId(chatId: string): DiscussionRecord | undefined {
    for (const record of this.discussions.values()) {
      if (record.chatId === chatId) {
        return record;
      }
    }
    return undefined;
  }

  /**
   * List discussions filtered by status.
   */
  listDiscussions(status?: DiscussionStatus): DiscussionRecord[] {
    const records = Array.from(this.discussions.values());
    if (status) {
      return records.filter(r => r.status === status);
    }
    return records;
  }

  /**
   * List all active discussions.
   */
  listActiveDiscussions(): DiscussionRecord[] {
    return this.listDiscussions('active');
  }

  /**
   * Check if a chat ID belongs to a discussion group.
   */
  isDiscussionChat(chatId: string): boolean {
    return this.findByChatId(chatId)?.status === 'active';
  }

  /**
   * Expire stale discussions that have exceeded max duration.
   *
   * @returns Number of discussions expired
   */
  expireStaleDiscussions(): number {
    const now = Date.now();
    const maxAge = this.maxDurationMinutes * 60 * 1000;
    let expired = 0;

    for (const record of this.discussions.values()) {
      if (record.status === 'active' && (now - record.createdAt) >= maxAge) {
        this.expireDiscussion(record.id);
        expired++;
      }
    }

    if (expired > 0) {
      logger.info({ count: expired }, 'Expired stale discussions');
    }

    return expired;
  }

  /**
   * Get count of discussions by status.
   */
  getStatusCounts(): Record<DiscussionStatus, number> {
    const counts: Record<DiscussionStatus, number> = {
      creating: 0,
      active: 0,
      concluded: 0,
      expired: 0,
    };

    for (const record of this.discussions.values()) {
      counts[record.status]++;
    }

    return counts;
  }

  /**
   * Remove a discussion record (for cleanup/testing).
   */
  removeDiscussion(discussionId: string): boolean {
    const removed = this.discussions.delete(discussionId);
    if (removed) {
      this.markDirty();
    }
    return removed;
  }

  /**
   * Dispose of the manager and clean up resources.
   */
  dispose(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    void this.flush();
    this.discussions.clear();
  }

  // ===========================================================================
  // Persistence
  // ===========================================================================

  private markDirty(): void {
    this.persistenceDirty = true;
  }

  /**
   * Load discussions from persistence file.
   */
  private load(): void {
    if (!this.persistencePath) return;

    if (!existsSync(this.persistencePath)) {
      return;
    }

    try {
      const data = readFileSync(this.persistencePath, 'utf-8');
      const records: DiscussionRecord[] = JSON.parse(data);

      for (const record of records) {
        this.discussions.set(record.id, record);
      }

      logger.info({ count: records.length, path: this.persistencePath }, 'Discussions loaded');
    } catch (error) {
      logger.error({ err: error, path: this.persistencePath }, 'Failed to load discussions');
    }
  }

  /**
   * Flush discussions to persistence file.
   */
  async flush(): Promise<void> {
    if (!this.persistencePath || !this.persistenceDirty) return;

    try {
      const dir = dirname(this.persistencePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const records = Array.from(this.discussions.values());
      writeFileSync(this.persistencePath, JSON.stringify(records, null, 2), 'utf-8');

      this.persistenceDirty = false;
      logger.debug({ count: records.length, path: this.persistencePath }, 'Discussions flushed');
    } catch (error) {
      logger.error({ err: error, path: this.persistencePath }, 'Failed to flush discussions');
    }
  }
}

// Singleton
let managerInstance: DiscussionManager | null = null;

/**
 * Get the global DiscussionManager instance.
 */
export function getDiscussionManager(config?: DiscussionManagerConfig): DiscussionManager {
  if (!managerInstance) {
    managerInstance = new DiscussionManager(config);
  }
  return managerInstance;
}

/**
 * Reset the global DiscussionManager (for testing).
 */
export function resetDiscussionManager(): void {
  if (managerInstance) {
    managerInstance.dispose();
    managerInstance = null;
  }
}
