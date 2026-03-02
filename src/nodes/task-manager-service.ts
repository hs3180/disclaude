/**
 * TaskManagerService - Manages deep task execution state and lifecycle.
 *
 * Implements Issue #468 - Task control commands for deep task execution management.
 *
 * Features:
 * - Task state management (running, paused, completed, cancelled)
 * - Task persistence to workspace/tasks.json
 * - Task history tracking
 * - Progress tracking
 *
 * Control Commands:
 * - /task <prompt> - Start a new task
 * - /task status - View current task status
 * - /task list - List task history
 * - /task cancel - Cancel current task
 * - /task pause - Pause current task
 * - /task resume - Resume paused task
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';

const logger = createLogger('TaskManagerService');

/**
 * Task status type.
 */
export type TaskStatus = 'running' | 'paused' | 'completed' | 'cancelled';

/**
 * Task state interface.
 */
export interface TaskState {
  /** Unique task identifier */
  id: string;
  /** Task prompt/description */
  prompt: string;
  /** Current status */
  status: TaskStatus;
  /** Progress percentage (0-100) */
  progress: number;
  /** Chat ID where task was started */
  chatId: string;
  /** Creation timestamp (ISO string) */
  createdAt: string;
  /** Last update timestamp (ISO string) */
  updatedAt: string;
  /** Optional error message */
  error?: string;
  /** Optional result summary */
  result?: string;
}

/**
 * Task manager configuration.
 */
export interface TaskManagerConfig {
  /** Base directory for task storage (defaults to workspace/tasks) */
  baseDir?: string;
  /** Maximum number of tasks to keep in history */
  maxHistorySize?: number;
}

/**
 * Persisted tasks file structure.
 */
interface TasksFile {
  /** Current active task (if any) */
  currentTask?: TaskState;
  /** Task history (most recent first) */
  history: TaskState[];
  /** Last updated timestamp */
  updatedAt: string;
}

/**
 * Generate a unique task ID.
 */
function generateTaskId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `task_${timestamp}_${random}`;
}

/**
 * TaskManagerService - Manages task execution state.
 */
export class TaskManagerService {
  private readonly tasksDir: string;
  private readonly tasksFile: string;
  private readonly maxHistorySize: number;
  private currentTask: TaskState | null = null;
  private history: TaskState[] = [];
  private loaded = false;

  constructor(config: TaskManagerConfig = {}) {
    const workspaceDir = config.baseDir || Config.getWorkspaceDir();
    this.tasksDir = path.join(workspaceDir, 'tasks');
    this.tasksFile = path.join(this.tasksDir, 'tasks.json');
    this.maxHistorySize = config.maxHistorySize || 100;
  }

  /**
   * Load tasks from disk.
   */
  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    try {
      // Ensure directory exists
      await fs.promises.mkdir(this.tasksDir, { recursive: true });

      // Read tasks file if exists
      if (fs.existsSync(this.tasksFile)) {
        const content = await fs.promises.readFile(this.tasksFile, 'utf-8');
        const data: TasksFile = JSON.parse(content);

        this.history = data.history || [];

        // Only restore current task if it's still running or paused
        if (data.currentTask &&
            (data.currentTask.status === 'running' || data.currentTask.status === 'paused')) {
          this.currentTask = data.currentTask;
        }
      }

      this.loaded = true;
      logger.info({ taskCount: this.history.length, hasCurrentTask: !!this.currentTask }, 'Tasks loaded');
    } catch (error) {
      logger.error({ err: error }, 'Failed to load tasks');
      this.history = [];
      this.currentTask = null;
      this.loaded = true;
    }
  }

  /**
   * Persist tasks to disk.
   */
  private async save(): Promise<void> {
    try {
      await fs.promises.mkdir(this.tasksDir, { recursive: true });

      const data: TasksFile = {
        currentTask: this.currentTask || undefined,
        history: this.history.slice(0, this.maxHistorySize),
        updatedAt: new Date().toISOString(),
      };

      await fs.promises.writeFile(this.tasksFile, JSON.stringify(data, null, 2), 'utf-8');
      logger.debug('Tasks saved');
    } catch (error) {
      logger.error({ err: error }, 'Failed to save tasks');
    }
  }

  /**
   * Start a new task.
   */
  async startTask(prompt: string, chatId: string): Promise<TaskState> {
    await this.load();

    // Cancel current task if running
    if (this.currentTask && this.currentTask.status === 'running') {
      await this.cancelTask();
    }

    const task: TaskState = {
      id: generateTaskId(),
      prompt,
      status: 'running',
      progress: 0,
      chatId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.currentTask = task;
    await this.save();

    logger.info({ taskId: task.id, prompt }, 'Task started');
    return task;
  }

  /**
   * Get current task status.
   */
  async getStatus(): Promise<TaskState | null> {
    await this.load();
    return this.currentTask;
  }

  /**
   * List task history.
   */
  async listHistory(limit = 10): Promise<TaskState[]> {
    await this.load();
    return this.history.slice(0, limit);
  }

  /**
   * Cancel current task.
   */
  async cancelTask(): Promise<TaskState | null> {
    await this.load();

    if (!this.currentTask) {
      return null;
    }

    this.currentTask.status = 'cancelled';
    this.currentTask.updatedAt = new Date().toISOString();

    // Move to history
    this.history.unshift(this.currentTask);
    const cancelledTask = this.currentTask;
    this.currentTask = null;

    await this.save();

    logger.info({ taskId: cancelledTask.id }, 'Task cancelled');
    return cancelledTask;
  }

  /**
   * Pause current task.
   */
  async pauseTask(): Promise<TaskState | null> {
    await this.load();

    if (!this.currentTask || this.currentTask.status !== 'running') {
      return null;
    }

    this.currentTask.status = 'paused';
    this.currentTask.updatedAt = new Date().toISOString();
    await this.save();

    logger.info({ taskId: this.currentTask.id }, 'Task paused');
    return this.currentTask;
  }

  /**
   * Resume paused task.
   */
  async resumeTask(): Promise<TaskState | null> {
    await this.load();

    if (!this.currentTask || this.currentTask.status !== 'paused') {
      return null;
    }

    this.currentTask.status = 'running';
    this.currentTask.updatedAt = new Date().toISOString();
    await this.save();

    logger.info({ taskId: this.currentTask.id }, 'Task resumed');
    return this.currentTask;
  }

  /**
   * Update task progress.
   */
  async updateProgress(progress: number): Promise<void> {
    await this.load();

    if (!this.currentTask) {
      return;
    }

    this.currentTask.progress = Math.min(100, Math.max(0, progress));
    this.currentTask.updatedAt = new Date().toISOString();
    await this.save();
  }

  /**
   * Complete current task.
   */
  async completeTask(result?: string): Promise<TaskState | null> {
    await this.load();

    if (!this.currentTask) {
      return null;
    }

    this.currentTask.status = 'completed';
    this.currentTask.progress = 100;
    this.currentTask.result = result;
    this.currentTask.updatedAt = new Date().toISOString();

    // Move to history
    this.history.unshift(this.currentTask);
    const completedTask = this.currentTask;
    this.currentTask = null;

    await this.save();

    logger.info({ taskId: completedTask.id }, 'Task completed');
    return completedTask;
  }

  /**
   * Fail current task with error.
   */
  async failTask(error: string): Promise<TaskState | null> {
    await this.load();

    if (!this.currentTask) {
      return null;
    }

    this.currentTask.status = 'cancelled';
    this.currentTask.error = error;
    this.currentTask.updatedAt = new Date().toISOString();

    // Move to history
    this.history.unshift(this.currentTask);
    const failedTask = this.currentTask;
    this.currentTask = null;

    await this.save();

    logger.info({ taskId: failedTask.id, error }, 'Task failed');
    return failedTask;
  }

  /**
   * Get current task (sync, must call load first).
   */
  getCurrentTask(): TaskState | null {
    return this.currentTask;
  }
}
