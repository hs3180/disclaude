/**
 * Schedule Manager - CRUD operations for scheduled tasks.
 *
 * Manages scheduled tasks that are triggered by cron expressions.
 * Tasks are persisted as markdown files in the schedules/ directory.
 *
 * Features:
 * - CRUD operations for scheduled tasks
 * - File-based persistence (markdown with YAML frontmatter)
 * - Scope by chatId (each chat has its own tasks)
 * - No cache: always reads from file system for consistency
 */

import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import { ScheduleFileScanner } from './schedule-file-scanner.js';

const logger = createLogger('ScheduleManager');

/**
 * Scheduled task definition.
 */
export interface ScheduledTask {
  /** Unique task ID */
  id: string;
  /** Human-readable task name */
  name: string;
  /** Cron expression (e.g., "0 9 * * *" for daily at 9am) */
  cron: string;
  /** Prompt to execute when task triggers */
  prompt: string;
  /** Chat ID where task was created (scope) */
  chatId: string;
  /** User ID who created the task */
  createdBy?: string;
  /** Whether task is enabled */
  enabled: boolean;
  /** Creation timestamp */
  createdAt: string;
  /** Last execution timestamp */
  lastExecutedAt?: string;
}

/**
 * Options for creating a new scheduled task.
 */
export interface CreateScheduleOptions {
  name: string;
  cron: string;
  prompt: string;
  chatId: string;
  createdBy?: string;
}

/**
 * ScheduleManager options.
 */
export interface ScheduleManagerOptions {
  /** Directory for schedule files */
  schedulesDir: string;
}

/**
 * ScheduleManager - Manages CRUD operations for scheduled tasks.
 *
 * No cache: all operations read directly from file system.
 * This ensures perfect consistency - file system is the single source of truth.
 *
 * Usage:
 * ```typescript
 * const manager = new ScheduleManager({ schedulesDir: './workspace/schedules' });
 *
 * // Create a task
 * const task = await manager.create({
 *   name: 'Daily Reminder',
 *   cron: '0 9 * * *',
 *   prompt: 'Remind me to check emails',
 *   chatId: 'oc_xxx',
 * });
 *
 * // List tasks for a chat
 * const tasks = await manager.listByChatId('oc_xxx');
 *
 * // Toggle task
 * await manager.toggle(task.id, false);
 *
 * // Delete task
 * await manager.delete(task.id);
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
   * Create a new scheduled task.
   *
   * @param options - Task creation options
   * @returns The created task
   */
  async create(options: CreateScheduleOptions): Promise<ScheduledTask> {
    const slug = this.generateSlug(options.name);
    const task: ScheduledTask = {
      id: `schedule-${slug}`,
      name: options.name,
      cron: options.cron,
      prompt: options.prompt,
      chatId: options.chatId,
      createdBy: options.createdBy,
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    // Write to file
    await this.fileScanner.writeTask(task);

    logger.info({ taskId: task.id, name: task.name, chatId: task.chatId }, 'Created scheduled task');
    return task;
  }

  /**
   * Generate a slug from task name.
   */
  private generateSlug(name: string): string {
    const baseSlug = name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '');

    // Add short UUID to ensure uniqueness
    const shortId = uuidv4().slice(0, 8);
    return `${baseSlug}-${shortId}`;
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

  /**
   * Update a task.
   *
   * @param id - Task ID
   * @param updates - Fields to update
   * @returns The updated task or undefined if not found
   */
  async update(id: string, updates: Partial<Omit<ScheduledTask, 'id' | 'createdAt'>>): Promise<ScheduledTask | undefined> {
    const tasks = await this.loadAll();
    const task = tasks.get(id);
    if (!task) {
      return undefined;
    }

    const updatedTask: ScheduledTask = {
      ...task,
      ...updates,
    };

    // Write to file
    await this.fileScanner.writeTask(updatedTask);

    logger.info({ taskId: id, updates }, 'Updated scheduled task');
    return updatedTask;
  }

  /**
   * Toggle task enabled status.
   *
   * @param id - Task ID
   * @param enabled - New enabled status
   * @returns The updated task or undefined if not found
   */
  async toggle(id: string, enabled: boolean): Promise<ScheduledTask | undefined> {
    return this.update(id, { enabled });
  }

  /**
   * Update last execution time.
   *
   * @param id - Task ID
   */
  async markExecuted(id: string): Promise<void> {
    await this.update(id, { lastExecutedAt: new Date().toISOString() });
  }

  /**
   * Delete a task.
   *
   * @param id - Task ID
   * @returns true if deleted, false if not found
   */
  async delete(id: string): Promise<boolean> {
    // Delete file
    const deleted = await this.fileScanner.deleteTask(id);
    if (!deleted) {
      return false;
    }

    logger.info({ taskId: id }, 'Deleted scheduled task');
    return true;
  }
}
