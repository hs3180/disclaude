/**
 * Schedule Manager - Query operations for scheduled tasks.
 *
 * Manages scheduled tasks that are triggered by cron expressions.
 * Tasks are persisted as markdown files in the schedules/ directory.
 *
 * Features:
 * - Query operations for scheduled tasks (list, get)
 * - File-based persistence (markdown with YAML frontmatter)
 * - Scope by chatId (each chat has its own tasks)
 * - No cache: always reads from file system for consistency
 *
 * Note: CRUD operations (create/update/delete) are handled via file system directly.
 * Users create schedule files manually, and ScheduleFileWatcher auto-loads them.
 *
 * @module @disclaude/worker-node/schedule
 */

import { createLogger, ScheduleFileScanner, type ScheduledTask } from '@disclaude/core';

const logger = createLogger('ScheduleManager');

// Re-export ScheduledTask for backward compatibility (Issue #1395)
export type { ScheduledTask } from '@disclaude/core';

/**
 * ScheduleManager options.
 */
export interface ScheduleManagerOptions {
  /** Directory for schedule files */
  schedulesDir: string;
}

/**
 * ScheduleManager - Manages scheduled task queries.
 *
 * No cache: all operations read directly from file system.
 * This ensures perfect consistency - file system is the single source of truth.
 *
 * Usage:
 * ```typescript
 * const manager = new ScheduleManager({ schedulesDir: './workspace/schedules' });
 *
 * // List tasks for a chat
 * const tasks = await manager.listByChatId('oc_xxx');
 *
 * // List all enabled tasks (for scheduler)
 * const enabledTasks = await manager.listEnabled();
 * ```
 */
export class ScheduleManager {
  private fileScanner: ScheduleFileScanner;

  constructor(options: ScheduleManagerOptions) {
    this.fileScanner = new ScheduleFileScanner({ schedulesDir: options.schedulesDir });
    logger.info({ schedulesDir: options.schedulesDir }, 'ScheduleManager initialized (no cache)');
  }

  /**
   * Load all tasks from file system.
   * No caching - always reads fresh data.
   */
  private async loadAll(): Promise<Map<string, ScheduledTask>> {
    const tasks = await this.fileScanner.scanAll();
    const map = new Map<string, ScheduledTask>();
    for (const task of tasks) {
      map.set(task.id, task);
    }
    return map;
  }

  /**
   * Get the file scanner instance.
   */
  getFileScanner(): ScheduleFileScanner {
    return this.fileScanner;
  }

  /**
   * Get a task by ID.
   *
   * @param id - Task ID
   * @returns The task or undefined if not found
   */
  async get(id: string): Promise<ScheduledTask | undefined> {
    const tasks = await this.loadAll();
    return tasks.get(id);
  }

  /**
   * List all tasks for a specific chat.
   *
   * @param chatId - Chat ID to filter by
   * @returns Array of tasks for the chat
   */
  async listByChatId(chatId: string): Promise<ScheduledTask[]> {
    const tasks = await this.loadAll();
    return Array.from(tasks.values()).filter(t => t.chatId === chatId);
  }

  /**
   * List all enabled tasks (for scheduler).
   *
   * @returns Array of all enabled tasks
   */
  async listEnabled(): Promise<ScheduledTask[]> {
    const tasks = await this.loadAll();
    return Array.from(tasks.values()).filter(t => t.enabled);
  }

  /**
   * List all tasks.
   *
   * @returns Array of all tasks
   */
  async listAll(): Promise<ScheduledTask[]> {
    const tasks = await this.loadAll();
    return Array.from(tasks.values());
  }
}
