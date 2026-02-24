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
 */

import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import { ScheduleFileScanner, type ScheduleFileTask } from './schedule-file-scanner.js';

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
  private cache: Map<string, ScheduledTask> = new Map();

  constructor(options: ScheduleManagerOptions) {
    this.fileScanner = new ScheduleFileScanner({ schedulesDir: options.schedulesDir });
    logger.info({ schedulesDir: options.schedulesDir }, 'ScheduleManager initialized');
  }

  /**
   * Load schedules from files.
   * Uses cache if available.
   */
  private async load(): Promise<void> {
    if (this.cache.size > 0) {
      return;
    }
    await this.reload();
  }

  /**
   * Force reload from files.
   */
  async reload(): Promise<void> {
    this.cache.clear();
    const tasks = await this.fileScanner.scanAll();
    for (const task of tasks) {
      this.cache.set(task.id, task);
    }
    logger.debug({ count: this.cache.size }, 'Reloaded schedules from files');
  }

  /**
   * Invalidate cache (force reload on next operation).
   */
  invalidateCache(): void {
    this.cache.clear();
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
    await this.load();

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

    // Update cache
    this.cache.set(task.id, task);

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
    await this.load();
    return this.cache.get(id);
  }

  /**
   * List all tasks for a specific chat.
   *
   * @param chatId - Chat ID to filter by
   * @returns Array of tasks for the chat
   */
  async listByChatId(chatId: string): Promise<ScheduledTask[]> {
    await this.load();
    return Array.from(this.cache.values()).filter(t => t.chatId === chatId);
  }

  /**
   * List all enabled tasks (for scheduler).
   *
   * @returns Array of all enabled tasks
   */
  async listEnabled(): Promise<ScheduledTask[]> {
    await this.load();
    return Array.from(this.cache.values()).filter(t => t.enabled);
  }

  /**
   * List all tasks.
   *
   * @returns Array of all tasks
   */
  async listAll(): Promise<ScheduledTask[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  /**
   * Update a task.
   *
   * @param id - Task ID
   * @param updates - Fields to update
   * @returns The updated task or undefined if not found
   */
  async update(id: string, updates: Partial<Omit<ScheduledTask, 'id' | 'createdAt'>>): Promise<ScheduledTask | undefined> {
    await this.load();

    const task = this.cache.get(id);
    if (!task) {
      return undefined;
    }

    const updatedTask: ScheduledTask = {
      ...task,
      ...updates,
    };

    // Write to file
    await this.fileScanner.writeTask(updatedTask);

    // Update cache
    this.cache.set(id, updatedTask);

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
    await this.load();

    const task = this.cache.get(id);
    if (!task) {
      return false;
    }

    // Delete file
    const deleted = await this.fileScanner.deleteTask(id);
    if (!deleted) {
      return false;
    }

    // Remove from cache
    this.cache.delete(id);

    logger.info({ taskId: id }, 'Deleted scheduled task');
    return true;
  }
}
