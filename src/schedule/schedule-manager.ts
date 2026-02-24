/**
 * Schedule Manager - CRUD operations for scheduled tasks.
 *
 * Manages scheduled tasks that are triggered by cron expressions.
 * Tasks are persisted to JSON file and can be dynamically managed.
 *
 * Features:
 * - CRUD operations for scheduled tasks
 * - JSON file persistence
 * - Scope by chatId (each chat has its own tasks)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

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
 * Schedule storage structure.
 */
interface ScheduleStorage {
  version: string;
  schedules: ScheduledTask[];
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
 * ScheduleManager - Manages CRUD operations for scheduled tasks.
 *
 * Usage:
 * ```typescript
 * const manager = new ScheduleManager('./workspace/schedules.json');
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
  private filePath: string;
  private cache: ScheduleStorage | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
    logger.info({ filePath }, 'ScheduleManager initialized');
  }

  /**
   * Load schedules from JSON file.
   * Uses cache if available.
   */
  private async load(): Promise<ScheduleStorage> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      this.cache = JSON.parse(content) as ScheduleStorage;
      logger.debug({ count: this.cache.schedules.length }, 'Loaded schedules from file');
      return this.cache;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist, create empty storage
        this.cache = { version: '1.0.0', schedules: [] };
        await this.save();
        logger.info('Created new schedule storage file');
        return this.cache;
      }
      throw error;
    }
  }

  /**
   * Save schedules to JSON file.
   */
  private async save(): Promise<void> {
    if (!this.cache) {
      return;
    }

    // Ensure directory exists
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8');
    logger.debug({ count: this.cache.schedules.length }, 'Saved schedules to file');
  }

  /**
   * Invalidate cache (force reload on next operation).
   */
  invalidateCache(): void {
    this.cache = null;
  }

  /**
   * Create a new scheduled task.
   *
   * @param options - Task creation options
   * @returns The created task
   */
  async create(options: CreateScheduleOptions): Promise<ScheduledTask> {
    const storage = await this.load();

    const task: ScheduledTask = {
      id: `schedule-${uuidv4().slice(0, 8)}`,
      name: options.name,
      cron: options.cron,
      prompt: options.prompt,
      chatId: options.chatId,
      createdBy: options.createdBy,
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    storage.schedules.push(task);
    await this.save();

    logger.info({ taskId: task.id, name: task.name, chatId: task.chatId }, 'Created scheduled task');
    return task;
  }

  /**
   * Get a task by ID.
   *
   * @param id - Task ID
   * @returns The task or undefined if not found
   */
  async get(id: string): Promise<ScheduledTask | undefined> {
    const storage = await this.load();
    return storage.schedules.find(t => t.id === id);
  }

  /**
   * List all tasks for a specific chat.
   *
   * @param chatId - Chat ID to filter by
   * @returns Array of tasks for the chat
   */
  async listByChatId(chatId: string): Promise<ScheduledTask[]> {
    const storage = await this.load();
    return storage.schedules.filter(t => t.chatId === chatId);
  }

  /**
   * List all enabled tasks (for scheduler).
   *
   * @returns Array of all enabled tasks
   */
  async listEnabled(): Promise<ScheduledTask[]> {
    const storage = await this.load();
    return storage.schedules.filter(t => t.enabled);
  }

  /**
   * List all tasks.
   *
   * @returns Array of all tasks
   */
  async listAll(): Promise<ScheduledTask[]> {
    const storage = await this.load();
    return storage.schedules;
  }

  /**
   * Update a task.
   *
   * @param id - Task ID
   * @param updates - Fields to update
   * @returns The updated task or undefined if not found
   */
  async update(id: string, updates: Partial<Omit<ScheduledTask, 'id' | 'createdAt'>>): Promise<ScheduledTask | undefined> {
    const storage = await this.load();
    const index = storage.schedules.findIndex(t => t.id === id);

    if (index === -1) {
      return undefined;
    }

    storage.schedules[index] = {
      ...storage.schedules[index],
      ...updates,
    };

    await this.save();
    logger.info({ taskId: id, updates }, 'Updated scheduled task');
    return storage.schedules[index];
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
    const storage = await this.load();
    const index = storage.schedules.findIndex(t => t.id === id);

    if (index === -1) {
      return false;
    }

    storage.schedules.splice(index, 1);
    await this.save();

    logger.info({ taskId: id }, 'Deleted scheduled task');
    return true;
  }
}
