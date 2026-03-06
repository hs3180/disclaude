/**
 * Cooldown Manager - Manages cooldown periods for scheduled tasks.
 *
 * Issue #869: 定时任务增加冷静期设计
 *
 * Prevents task execution within a configurable cooldown period
 * after the last execution to avoid duplicate task runs.
 *
 * Features:
 * - File-based persistence (survives restarts)
 * - In-memory cache for fast checks
 * - Automatic cleanup of expired entries
 * - Support for manual cooldown clearing (debug)
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('CooldownManager');

/**
 * Cooldown record for a single task.
 */
interface CooldownRecord {
  /** Task ID */
  taskId: string;
  /** Last execution timestamp (ISO string) */
  lastExecutionTime: string;
  /** Cooldown period in milliseconds */
  cooldownPeriod: number;
}

/**
 * CooldownManager options.
 */
export interface CooldownManagerOptions {
  /** Directory for cooldown state files */
  cooldownDir: string;
}

/**
 * Cooldown check result.
 */
export interface CooldownStatus {
  /** Whether the task is in cooldown */
  inCooldown: boolean;
  /** Task ID */
  taskId: string;
  /** Last execution time (ISO string) */
  lastExecutionTime?: string;
  /** Cooldown period in milliseconds */
  cooldownPeriod: number;
  /** Remaining cooldown time in milliseconds (0 if not in cooldown) */
  remainingMs: number;
  /** When the cooldown ends (ISO string, undefined if not in cooldown) */
  cooldownEndsAt?: string;
}

/**
 * CooldownManager - Manages cooldown periods for scheduled tasks.
 *
 * Uses file-based persistence to survive service restarts.
 * Memory cache provides fast lookup for frequent checks.
 *
 * Usage:
 * ```typescript
 * const manager = new CooldownManager({ cooldownDir: './workspace/schedules/.cooldown' });
 *
 * // Check if task is in cooldown
 * const status = manager.checkCooldown('task-123', 300000); // 5 min cooldown
 * if (status.inCooldown) {
 *   console.log(`Task in cooldown for ${status.remainingMs}ms more`);
 * }
 *
 * // Record task execution
 * manager.recordExecution('task-123', 300000);
 *
 * // Clear cooldown (for debugging)
 * manager.clearCooldown('task-123');
 * ```
 */
export class CooldownManager {
  private cooldownDir: string;
  /** In-memory cache for fast cooldown checks */
  private cache: Map<string, CooldownRecord> = new Map();
  /** Whether the manager has been initialized */
  private initialized = false;

  constructor(options: CooldownManagerOptions) {
    this.cooldownDir = options.cooldownDir;
    logger.info({ cooldownDir: this.cooldownDir }, 'CooldownManager created');
  }

  /**
   * Ensure the cooldown directory exists and load existing records.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await fsPromises.mkdir(this.cooldownDir, { recursive: true });
    await this.loadAllRecords();
    this.initialized = true;
  }

  /**
   * Load all cooldown records from disk into memory.
   */
  private async loadAllRecords(): Promise<void> {
    try {
      const files = await fsPromises.readdir(this.cooldownDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));

      for (const file of jsonFiles) {
        try {
          const filePath = path.join(this.cooldownDir, file);
          const content = await fsPromises.readFile(filePath, 'utf-8');
          const record = JSON.parse(content) as CooldownRecord;
          this.cache.set(record.taskId, record);
        } catch (err) {
          logger.warn({ file }, 'Failed to load cooldown record');
        }
      }

      logger.info({ count: this.cache.size }, 'Loaded cooldown records');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err }, 'Error loading cooldown records');
      }
    }
  }

  /**
   * Get the file path for a task's cooldown record.
   */
  private getFilePath(taskId: string): string {
    return path.join(this.cooldownDir, `${taskId}.json`);
  }

  /**
   * Save a cooldown record to disk.
   */
  private async saveRecord(record: CooldownRecord): Promise<void> {
    const filePath = this.getFilePath(record.taskId);
    await fsPromises.writeFile(filePath, JSON.stringify(record, null, 2), 'utf-8');
    logger.debug({ taskId: record.taskId }, 'Saved cooldown record');
  }

  /**
   * Delete a cooldown record from disk.
   */
  private async deleteRecord(taskId: string): Promise<void> {
    const filePath = this.getFilePath(taskId);
    try {
      await fsPromises.unlink(filePath);
      logger.debug({ taskId }, 'Deleted cooldown record');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  /**
   * Check if a task is currently in cooldown.
   *
   * @param taskId - Task ID to check
   * @param cooldownPeriod - Cooldown period in milliseconds (0 = no cooldown)
   * @returns Cooldown status
   */
  async checkCooldown(taskId: string, cooldownPeriod: number): Promise<CooldownStatus> {
    await this.ensureInitialized();

    // No cooldown period means always allow execution
    if (!cooldownPeriod || cooldownPeriod <= 0) {
      return {
        inCooldown: false,
        taskId,
        cooldownPeriod: 0,
        remainingMs: 0,
      };
    }

    const record = this.cache.get(taskId);

    // No previous execution record
    if (!record) {
      return {
        inCooldown: false,
        taskId,
        cooldownPeriod,
        remainingMs: 0,
      };
    }

    const lastExecution = new Date(record.lastExecutionTime).getTime();
    const now = Date.now();
    const elapsed = now - lastExecution;
    const remainingMs = record.cooldownPeriod - elapsed;

    // Cooldown has expired
    if (remainingMs <= 0) {
      return {
        inCooldown: false,
        taskId,
        cooldownPeriod,
        remainingMs: 0,
      };
    }

    // Task is in cooldown
    const cooldownEndsAt = new Date(lastExecution + record.cooldownPeriod).toISOString();
    logger.info(
      { taskId, remainingMs, cooldownEndsAt },
      'Task is in cooldown'
    );

    return {
      inCooldown: true,
      taskId,
      lastExecutionTime: record.lastExecutionTime,
      cooldownPeriod: record.cooldownPeriod,
      remainingMs,
      cooldownEndsAt,
    };
  }

  /**
   * Record a task execution, starting the cooldown period.
   *
   * @param taskId - Task ID that was executed
   * @param cooldownPeriod - Cooldown period in milliseconds
   */
  async recordExecution(taskId: string, cooldownPeriod: number): Promise<void> {
    await this.ensureInitialized();

    // Don't record if no cooldown period
    if (!cooldownPeriod || cooldownPeriod <= 0) {
      return;
    }

    const record: CooldownRecord = {
      taskId,
      lastExecutionTime: new Date().toISOString(),
      cooldownPeriod,
    };

    this.cache.set(taskId, record);
    await this.saveRecord(record);

    logger.info(
      { taskId, cooldownPeriod, lastExecutionTime: record.lastExecutionTime },
      'Recorded task execution, cooldown started'
    );
  }

  /**
   * Clear the cooldown for a task.
   * Useful for debugging or manual intervention.
   *
   * @param taskId - Task ID to clear cooldown for
   * @returns true if cooldown was cleared, false if there was no cooldown
   */
  async clearCooldown(taskId: string): Promise<boolean> {
    await this.ensureInitialized();

    const hadRecord = this.cache.has(taskId);

    if (hadRecord) {
      this.cache.delete(taskId);
      await this.deleteRecord(taskId);
      logger.info({ taskId }, 'Cleared cooldown');
    }

    return hadRecord;
  }

  /**
   * Get cooldown status for all tasks.
   * Useful for debugging and status display.
   *
   * @returns Map of task IDs to their cooldown status
   */
  async getAllCooldownStatus(): Promise<Map<string, CooldownStatus>> {
    await this.ensureInitialized();

    const result = new Map<string, CooldownStatus>();

    for (const [taskId, record] of this.cache) {
      const status = await this.checkCooldown(taskId, record.cooldownPeriod);
      result.set(taskId, status);
    }

    return result;
  }

  /**
   * Clean up expired cooldown records.
   * Can be called periodically to free disk space.
   *
   * @returns Number of records cleaned up
   */
  async cleanupExpired(): Promise<number> {
    await this.ensureInitialized();

    let cleaned = 0;
    const now = Date.now();

    for (const [taskId, record] of this.cache) {
      const lastExecution = new Date(record.lastExecutionTime).getTime();
      const expiredAt = lastExecution + record.cooldownPeriod;

      // If cooldown expired more than 24 hours ago, clean up
      if (now - expiredAt > 24 * 60 * 60 * 1000) {
        this.cache.delete(taskId);
        await this.deleteRecord(taskId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up expired cooldown records');
    }

    return cleaned;
  }
}
