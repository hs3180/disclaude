/**
 * OccurrenceStore - Persists scheduled-occurrence records and the scheduler's
 * lifecycle boundaries (Issue #5763).
 *
 * Sibling of {@link TaskFailureStore} (same memory + file pattern, same
 * directory family) so the ledger survives restarts — which is the whole
 * point: the startup reconciliation in `schedule-occurrence.ts` needs to know
 * what previous lifetimes recorded and when the last one stopped.
 *
 * Storage: `{dir}/<safeTaskId>.json` (one file per task) and `{dir}/lifecycle.json`.
 *
 * Retention: records older than `retentionMs` (by scheduled instant) and
 * beyond `maxPerTask` newest per task are pruned on load and on write.
 *
 * Persistence failures are logged and reported (`put` → false), never thrown:
 * the ledger must not take down task execution, and a restart with an
 * unwritable store simply finds no stop evidence → `unknown`, reported as a gap.
 *
 * @module @disclaude/core/scheduling
 */

import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { occurrenceKey, type OccurrenceRecord } from './schedule-occurrence.js';

const logger = createLogger('OccurrenceStore');

/** Default retention: 90 days covers ~3 monthly cycles of a periodic task. */
export const DEFAULT_OCCURRENCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Default per-task cap; bounds file size for dense (every-minute) schedules. */
export const DEFAULT_OCCURRENCES_PER_TASK = 500;

export interface OccurrenceStoreOptions {
  /** Directory for record files. */
  dir: string;
  retentionMs?: number;
  maxPerTask?: number;
  /** Injectable clock (tests); defaults to wall clock. */
  now?: () => Date;
}

/** Lifecycle boundaries shared by all tasks. */
export interface LifecycleState {
  /** Last clean scheduler stop; absent after a crash/kill. */
  stoppedAt?: string;
  /** Last scheduler start. */
  startedAt?: string;
}

interface TaskFile {
  version: 1;
  taskId: string;
  records: OccurrenceRecord[];
}

export class OccurrenceStore {
  private readonly dir: string;
  private readonly retentionMs: number;
  private readonly maxPerTask: number;
  private readonly now: () => Date;
  private readonly records = new Map<string, OccurrenceRecord>();
  private lifecycle: LifecycleState = {};
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  /** True after a load or write failed; the store keeps serving from memory. */
  degraded = false;

  constructor(options: OccurrenceStoreOptions) {
    this.dir = options.dir;
    this.retentionMs = options.retentionMs ?? DEFAULT_OCCURRENCE_RETENTION_MS;
    this.maxPerTask = options.maxPerTask ?? DEFAULT_OCCURRENCES_PER_TASK;
    this.now = options.now ?? (() => new Date());
  }

  private ensureInitialized(): Promise<void> {
    if (this.initialized) { return Promise.resolve(); }
    this.initPromise ??= this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    try {
      await fsPromises.mkdir(this.dir, { recursive: true });
      this.lifecycle = await this.readLifecycle();
      await this.loadAllRecords();
    } catch (error) {
      this.degraded = true;
      logger.error({ err: error, dir: this.dir }, 'Failed to initialize OccurrenceStore (continuing memory-only)');
    }
    this.initialized = true;
  }

  private async readLifecycle(): Promise<LifecycleState> {
    try {
      const content = await fsPromises.readFile(path.join(this.dir, 'lifecycle.json'), 'utf-8');
      const parsed = JSON.parse(content) as LifecycleState;
      return {
        ...(typeof parsed.stoppedAt === 'string' ? { stoppedAt: parsed.stoppedAt } : {}),
        ...(typeof parsed.startedAt === 'string' ? { startedAt: parsed.startedAt } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err: error }, 'Lifecycle record unreadable; no stop evidence available');
      }
      return {};
    }
  }

  private async loadAllRecords(): Promise<void> {
    const files = (await fsPromises.readdir(this.dir)).filter((f) => f.endsWith('.json') && f !== 'lifecycle.json');
    for (const file of files) {
      const filePath = path.join(this.dir, file);
      try {
        const parsed = JSON.parse(await fsPromises.readFile(filePath, 'utf-8')) as TaskFile;
        if (parsed.version !== 1 || typeof parsed.taskId !== 'string' || !Array.isArray(parsed.records)) {
          throw new Error('malformed occurrence file');
        }
        for (const record of this.prune(parsed.records)) {
          this.records.set(occurrenceKey(record.taskId, record.scheduledFor), record);
        }
      } catch (error) {
        // Corrupted file: drop it (rename aside) so one bad write cannot wedge the
        // store — the occurrences it held become `unknown`, which is the truth.
        await fsPromises.rename(filePath, `${filePath}.corrupt`).catch(() => {});
        logger.warn({ err: error, file }, 'Dropped unreadable occurrence file');
      }
    }
    if (this.records.size > 0) {
      logger.info({ count: this.records.size }, 'Restored occurrence records from disk');
    }
  }

  /** Apply retention and per-task cap; newest (by scheduled instant) win. */
  private prune(records: OccurrenceRecord[]): OccurrenceRecord[] {
    const cutoff = this.now().getTime() - this.retentionMs;
    const kept = records
      .filter((r) => typeof r.taskId === 'string' && typeof r.scheduledFor === 'string' && typeof r.status === 'string')
      .filter((r) => { const t = Date.parse(r.scheduledFor); return !Number.isNaN(t) && t >= cutoff; })
      .sort((a, b) => Date.parse(b.scheduledFor) - Date.parse(a.scheduledFor))
      .slice(0, this.maxPerTask);
    return kept.reverse();
  }

  private safeId(taskId: string): string {
    return taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  private taskRecords(taskId: string): OccurrenceRecord[] {
    return [...this.records.values()].filter((r) => r.taskId === taskId);
  }

  private async persistTask(taskId: string): Promise<void> {
    const filePath = path.join(this.dir, `${this.safeId(taskId)}.json`);
    const tmp = `${filePath}.${process.pid}.tmp`;
    const file: TaskFile = { version: 1, taskId, records: this.prune(this.taskRecords(taskId)) };
    await fsPromises.writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8');
    await fsPromises.rename(tmp, filePath);
  }

  private async persistLifecycle(): Promise<void> {
    const filePath = path.join(this.dir, 'lifecycle.json');
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fsPromises.writeFile(tmp, JSON.stringify(this.lifecycle, null, 2), 'utf-8');
    await fsPromises.rename(tmp, filePath);
  }

  /**
   * Record (or overwrite by identity) one occurrence. Returns false when the
   * write failed — the in-memory ledger is updated regardless.
   */
  async put(record: OccurrenceRecord): Promise<boolean> {
    await this.ensureInitialized();
    this.records.set(occurrenceKey(record.taskId, record.scheduledFor), record);
    try {
      await this.persistTask(record.taskId);
      return true;
    } catch (error) {
      this.degraded = true;
      logger.error({ err: error, taskId: record.taskId }, 'Failed to persist occurrence record');
      return false;
    }
  }

  /** Bulk variant of {@link put}; one write per task. */
  async putAll(records: OccurrenceRecord[]): Promise<boolean> {
    await this.ensureInitialized();
    const taskIds = new Set<string>();
    for (const record of records) {
      this.records.set(occurrenceKey(record.taskId, record.scheduledFor), record);
      taskIds.add(record.taskId);
    }
    let ok = true;
    for (const taskId of taskIds) {
      try {
        await this.persistTask(taskId);
      } catch (error) {
        ok = false;
        this.degraded = true;
        logger.error({ err: error, taskId }, 'Failed to persist occurrence records');
      }
    }
    return ok;
  }

  async get(taskId: string, scheduledFor: string): Promise<OccurrenceRecord | undefined> {
    await this.ensureInitialized();
    return this.records.get(occurrenceKey(taskId, scheduledFor));
  }

  /** All records keyed by {@link occurrenceKey} (the shape reconciliation consumes). */
  async all(): Promise<Map<string, OccurrenceRecord>> {
    await this.ensureInitialized();
    return new Map(this.records);
  }

  async getLifecycle(): Promise<LifecycleState> {
    await this.ensureInitialized();
    return { ...this.lifecycle };
  }

  /** Persist a scheduler start; a failure leaves the previous state intact and returns false. */
  async recordStarted(startedAt: string): Promise<boolean> {
    await this.ensureInitialized();
    const previous = this.lifecycle;
    this.lifecycle = { ...this.lifecycle, startedAt };
    try {
      await this.persistLifecycle();
      return true;
    } catch (error) {
      this.lifecycle = previous;
      this.degraded = true;
      logger.error({ err: error }, 'Failed to persist scheduler start');
      return false;
    }
  }

  /**
   * Persist a clean stop. This is the ONLY source of stop evidence; when it
   * fails the next start cannot prove anything about the gap (→ unknown).
   */
  async recordStopped(stoppedAt: string): Promise<boolean> {
    await this.ensureInitialized();
    const previous = this.lifecycle;
    this.lifecycle = { ...this.lifecycle, stoppedAt };
    try {
      await this.persistLifecycle();
      return true;
    } catch (error) {
      this.lifecycle = previous;
      this.degraded = true;
      logger.error({ err: error }, 'Failed to persist scheduler stop (next start will have no stop evidence)');
      return false;
    }
  }
}
