/**
 * TaskFailureStore - Persists per-task consecutive-failure streaks.
 *
 * Issue #4648 review residual ⑥: the Scheduler's consecutive-failure counter
 * lived purely in memory, so every process restart zeroed it — a schedule
 * failing on every tick under frequent restarts (crash loop, redeploys) never
 * reached the CONSECUTIVE_FAILURE_ALERT_THRESHOLD and the chronic-failure
 * alert could never fire. This store mirrors CooldownManager's memory + file
 * dual-storage pattern so a streak survives restarts.
 *
 * Storage location: workspace/schedules/.failures/{task-id}.json
 *
 * Deliberate simplifications (documented tradeoffs, not oversights):
 * - A streak goes stale after STALE_STREAK_MS: on load, stale files are
 *   dropped (and unlinked); a stale in-memory entry restarts at 1 on the next
 *   failure. Without this, a streak could be resurrected months later across
 *   a delete-and-recreate of a schedule with the same slug.
 * - Deleting a schedule does NOT proactively clear its streak file. The
 *   Scheduler's addTask() calls removeTask() on every reload, so hooking
 *   removal would wipe legitimate streaks on any schedule edit; stale-entry
 *   expiry bounds the leftover files instead.
 *
 * @module @disclaude/core/scheduling
 */

import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskFailureStore');

/**
 * A streak older than this is considered broken by time, not continued.
 * 30 days is the longest common cron interval (monthly tasks), so every
 * legitimately-scheduled consecutive failure stays countable while anything
 * sparser is treated as an isolated incident.
 */
const STALE_STREAK_MS = 30 * 24 * 60 * 60 * 1000;

/** Persisted failure record for one task. */
interface TaskFailureRecord {
  /** Task ID */
  taskId: string;
  /** Current consecutive-failure count */
  consecutiveFailures: number;
  /** Timestamp of the most recent failure (ISO string) */
  lastFailureAt: string;
}

/** TaskFailureStore options. */
export interface TaskFailureStoreOptions {
  /** Directory for failure streak files */
  dir: string;
}

/**
 * TaskFailureStore - File-backed consecutive-failure streaks.
 *
 * Usage (see Scheduler's `failureStore` option for the production wiring):
 * ```typescript
 * const store = new TaskFailureStore({ dir: './workspace/schedules/.failures' });
 *
 * const streak = await store.recordFailure('task-id'); // 1, 2, 3... persists
 * await store.recordSuccess('task-id');                 // clears memory + file
 * ```
 *
 * Persistence failures are logged, never thrown: streak tracking must not
 * take down task execution.
 */
export class TaskFailureStore {
  private readonly dir: string;
  /** In-memory cache, source of truth after lazy initialization */
  private cache: Map<string, TaskFailureRecord> = new Map();
  /** Whether records have been loaded from disk */
  private initialized = false;
  /**
   * In-flight init promise so concurrent first uses share ONE load.
   * Without this, `recordFailure` racing a `getStreak` poll (exactly the
   * scheduler-catch + test-waitFor shape) ran `loadAllRecords` twice, and
   * the slower load clobbered the faster call's cache update with the
   * pre-write disk state — a fresh streak could read back as its old value.
   */
  private initPromise: Promise<void> | null = null;

  constructor(options: TaskFailureStoreOptions) {
    this.dir = options.dir;
    logger.info({ dir: this.dir }, 'TaskFailureStore initialized');
  }

  /**
   * Ensure the store directory exists and records are loaded from disk.
   * Mirrors CooldownManager: on init failure, degrades to memory-only
   * (still better than the pre-⑥ behavior — the current process's streaks
   * are tracked, they just don't survive the next restart).
   */
  private ensureInitialized(): Promise<void> {
    if (this.initialized) { return Promise.resolve(); }
    this.initPromise ??= this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    try {
      await fsPromises.mkdir(this.dir, { recursive: true });
      await this.loadAllRecords();
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize TaskFailureStore (continuing memory-only)');
    }
    this.initialized = true;
  }

  /**
   * Load all failure records from disk into memory.
   * Stale records are unlinked so the directory self-cleans on startup.
   */
  private async loadAllRecords(): Promise<void> {
    let files: string[];
    try {
      files = await fsPromises.readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: error }, 'Error reading TaskFailureStore directory');
      }
      return;
    }

    for (const file of files.filter((f) => f.endsWith('.json'))) {
      const filePath = path.join(this.dir, file);
      try {
        const content = await fsPromises.readFile(filePath, 'utf-8');
        const record = JSON.parse(content) as TaskFailureRecord;

        if (typeof record.taskId !== 'string' || typeof record.consecutiveFailures !== 'number') {
          throw new Error('malformed record');
        }

        if (this.isStale(record)) {
          await fsPromises.unlink(filePath).catch(() => {});
          continue;
        }
        this.cache.set(record.taskId, record);
      } catch {
        // Corrupted file: drop it so one bad write can't wedge the store.
        await fsPromises.unlink(filePath).catch(() => {});
        logger.warn({ file }, 'Dropped unreadable task failure record');
      }
    }

    if (this.cache.size > 0) {
      logger.info({ count: this.cache.size }, 'Restored failure streaks from disk');
    }
  }

  /** Whether a record's last failure is older than STALE_STREAK_MS. */
  private isStale(record: TaskFailureRecord): boolean {
    const lastFailureAt = new Date(record.lastFailureAt).getTime();
    if (Number.isNaN(lastFailureAt)) { return true; }
    return Date.now() - lastFailureAt > STALE_STREAK_MS;
  }

  /** Sanitized file path for a task's record (same scheme as CooldownManager). */
  private getFilePath(taskId: string): string {
    const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dir, `${safeId}.json`);
  }

  /**
   * Record a failure and return the new streak length.
   * A stale previous entry restarts the streak at 1 (see class doc).
   */
  async recordFailure(taskId: string): Promise<number> {
    await this.ensureInitialized();

    const prev = this.cache.get(taskId);
    const continues = prev !== undefined && !this.isStale(prev);
    const record: TaskFailureRecord = {
      taskId,
      consecutiveFailures: continues ? prev.consecutiveFailures + 1 : 1,
      lastFailureAt: new Date().toISOString(),
    };

    this.cache.set(taskId, record);

    try {
      await fsPromises.writeFile(this.getFilePath(taskId), JSON.stringify(record, null, 2), 'utf-8');
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to persist failure streak');
    }

    return record.consecutiveFailures;
  }

  /**
   * Record a success: the streak is broken, so clear memory and file.
   * Deleting a non-existent record is a no-op.
   */
  async recordSuccess(taskId: string): Promise<void> {
    await this.ensureInitialized();

    this.cache.delete(taskId);

    try {
      await fsPromises.unlink(this.getFilePath(taskId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: error, taskId }, 'Failed to clear failure streak file');
      }
    }
  }

  /**
   * Current streak for a task (0 when it has none).
   * Loads from disk on first use, so a fresh instance reports persisted state.
   */
  async getStreak(taskId: string): Promise<number> {
    await this.ensureInitialized();
    const record = this.cache.get(taskId);
    if (!record || this.isStale(record)) { return 0; }
    return record.consecutiveFailures;
  }
}
