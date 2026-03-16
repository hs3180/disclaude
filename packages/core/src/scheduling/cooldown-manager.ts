/**
 * CooldownManager - Manages cooldown periods for scheduled tasks.
 *
 * Issue #869: Prevents rapid re-execution of scheduled tasks.
 *
 * Features:
 * - File-based persistence (survives restarts)
 * - Memory + file dual storage for performance
 * - Automatic cleanup of expired entries
 *
 * Storage location: workspace/schedules/.cooldown/{task-id}.json
 *
 * @module @disclaude/core/scheduling
 */

import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('CooldownManager');

/**
 * Cooldown record stored per task.
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
 * CooldownManager - Manages cooldown periods for scheduled tasks.
 *
 * Usage:
 * ```typescript
 * const manager = new CooldownManager({ cooldownDir: './workspace/schedules/.cooldown' });
 *
 * // Check if task is in cooldown
 * if (manager.isInCooldown('task-id', 300000)) {
 *   console.log('Task is cooling down');
 * }
 *
 * // Record execution
 * manager.recordExecution('task-id', 300000);
 *
 * // Clear cooldown
 * manager.clearCooldown('task-id');
 * ```
 */
export class CooldownManager {
  private cooldownDir: string;
  /** In-memory cache for fast lookups */
  private cache: Map<string, CooldownRecord> = new Map();
  /** Whether the manager has been initialized */
  private initialized = false;

  constructor(options: CooldownManagerOptions) {
    this.cooldownDir = options.cooldownDir;
    logger.info({ cooldownDir: this.cooldownDir }, 'CooldownManager initialized');
  }

  /**
   * Ensure the cooldown directory exists and load existing records.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) { return; }

    try {
      await fsPromises.mkdir(this.cooldownDir, { recursive: true });
      await this.loadAllRecords();
      this.initialized = true;
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize CooldownManager');
      // Continue without persistence on error
      this.initialized = true;
    }
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

          // Only load if not expired
          if (!this.isRecordExpired(record)) {
            this.cache.set(record.taskId, record);
          } else {
            // Clean up expired file
            await fsPromises.unlink(filePath).catch(() => {});
          }
        } catch {
          // Ignore parse errors
        }
      }

      logger.debug({ count: this.cache.size }, 'Loaded cooldown records');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: error }, 'Error loading cooldown records');
      }
    }
  }

  /**
   * Check if a cooldown record has expired.
   */
  private isRecordExpired(record: CooldownRecord): boolean {
    const lastExecution = new Date(record.lastExecutionTime).getTime();
    const cooldownEnd = lastExecution + record.cooldownPeriod;
    return Date.now() > cooldownEnd;
  }

  /**
   * Get the file path for a task's cooldown record.
   */
  private getFilePath(taskId: string): string {
    // Sanitize task ID for filename
    const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.cooldownDir, `${safeId}.json`);
  }

  /**
   * Check if a task is currently in its cooldown period.
   *
   * @param taskId - Task ID to check
   * @param cooldownPeriod - Cooldown period in milliseconds (optional, uses stored value if not provided)
   * @returns true if the task is in cooldown, false otherwise
   */
  async isInCooldown(taskId: string, cooldownPeriod?: number): Promise<boolean> {
    await this.ensureInitialized();

    const record = this.cache.get(taskId);
    if (!record) { return false; }

    // Use provided cooldown period or stored one
    const effectiveCooldown = cooldownPeriod ?? record.cooldownPeriod;
    if (!effectiveCooldown) { return false; }

    const lastExecution = new Date(record.lastExecutionTime).getTime();
    const cooldownEnd = lastExecution + effectiveCooldown;
    const now = Date.now();

    return now < cooldownEnd;
  }

  /**
   * Get cooldown status for a task.
   *
   * @param taskId - Task ID to check
   * @param cooldownPeriod - Cooldown period in milliseconds
   * @returns Cooldown status info or null if not in cooldown
   */
  async getCooldownStatus(taskId: string, cooldownPeriod?: number): Promise<{
    isInCooldown: boolean;
    lastExecutionTime: Date | null;
    cooldownEndsAt: Date | null;
    remainingMs: number;
  }> {
    await this.ensureInitialized();

    const record = this.cache.get(taskId);

    if (!record) {
      return {
        isInCooldown: false,
        lastExecutionTime: null,
        cooldownEndsAt: null,
        remainingMs: 0,
      };
    }

    const effectiveCooldown = cooldownPeriod ?? record.cooldownPeriod;
    const lastExecution = new Date(record.lastExecutionTime);
    const cooldownEndsAt = effectiveCooldown
      ? new Date(lastExecution.getTime() + effectiveCooldown)
      : null;

    const remainingMs = cooldownEndsAt
      ? Math.max(0, cooldownEndsAt.getTime() - Date.now())
      : 0;

    return {
      isInCooldown: remainingMs > 0,
      lastExecutionTime: lastExecution,
      cooldownEndsAt,
      remainingMs,
    };
  }

  /**
   * Record a task execution, starting its cooldown period.
   *
   * @param taskId - Task ID
   * @param cooldownPeriod - Cooldown period in milliseconds
   */
  async recordExecution(taskId: string, cooldownPeriod: number): Promise<void> {
    await this.ensureInitialized();

    const record: CooldownRecord = {
      taskId,
      lastExecutionTime: new Date().toISOString(),
      cooldownPeriod,
    };

    // Update memory cache
    this.cache.set(taskId, record);

    // Persist to file
    try {
      const filePath = this.getFilePath(taskId);
      await fsPromises.writeFile(filePath, JSON.stringify(record, null, 2), 'utf-8');
      logger.debug({ taskId, cooldownPeriod }, 'Recorded task execution');
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to persist cooldown record');
    }
  }

  /**
   * Clear the cooldown for a task.
   *
   * @param taskId - Task ID to clear
   */
  async clearCooldown(taskId: string): Promise<boolean> {
    await this.ensureInitialized();

    // Remove from memory
    const existed = this.cache.delete(taskId);

    // Remove file
    try {
      const filePath = this.getFilePath(taskId);
      await fsPromises.unlink(filePath);
      logger.debug({ taskId }, 'Cleared cooldown');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: error, taskId }, 'Failed to clear cooldown file');
      }
    }

    return existed;
  }

  /**
   * Get all tasks currently in cooldown.
   */
  async getAllInCooldown(): Promise<Array<{
    taskId: string;
    lastExecutionTime: Date;
    cooldownEndsAt: Date;
    remainingMs: number;
  }>> {
    await this.ensureInitialized();

    const result: Array<{
      taskId: string;
      lastExecutionTime: Date;
      cooldownEndsAt: Date;
      remainingMs: number;
    }> = [];

    for (const [taskId, record] of this.cache) {
      const lastExecution = new Date(record.lastExecutionTime);
      const cooldownEndsAt = new Date(lastExecution.getTime() + record.cooldownPeriod);
      const remainingMs = Math.max(0, cooldownEndsAt.getTime() - Date.now());

      if (remainingMs > 0) {
        result.push({
          taskId,
          lastExecutionTime: lastExecution,
          cooldownEndsAt,
          remainingMs,
        });
      }
    }

    return result;
  }
}
