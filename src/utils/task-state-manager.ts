/**
 * Task State Manager - Manages task execution state.
 *
 * This module provides state management for deep tasks, supporting:
 * - Task status tracking (running, paused, completed, cancelled)
 * - Task persistence to workspace/tasks-state/
 * - Task history listing
 *
 * Issue #468: 任务控制指令 - deep task 执行管理
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config/index.js';
import { createLogger } from './logger.js';

const logger = createLogger('TaskStateManager', {});

/**
 * Task status enum.
 */
export type TaskStatus = 'running' | 'paused' | 'completed' | 'cancelled' | 'error';

/**
 * Task state interface.
 */
export interface TaskState {
  /** Unique task identifier */
  id: string;

  /** Original prompt that started the task */
  prompt: string;

  /** Current status */
  status: TaskStatus;

  /** Progress percentage (0-100) */
  progress: number;

  /** Chat ID where task was started */
  chatId: string;

  /** User ID who started the task */
  userId?: string;

  /** Creation timestamp (ISO string) */
  createdAt: string;

  /** Last update timestamp (ISO string) */
  updatedAt: string;

  /** Error message if status is 'error' */
  error?: string;

  /** Current step description */
  currentStep?: string;
}

/**
 * Task state manager for managing deep task execution.
 */
export class TaskStateManager {
  private readonly stateDir: string;
  private readonly currentStateFile: string;
  private currentTask: TaskState | null = null;

  constructor(baseDir?: string) {
    const workspaceDir = baseDir || Config.getWorkspaceDir();
    this.stateDir = path.join(workspaceDir, 'tasks-state');
    this.currentStateFile = path.join(this.stateDir, 'current-task.json');
  }

  /**
   * Ensure state directory exists.
   */
  private async ensureStateDir(): Promise<void> {
    try {
      await fs.mkdir(this.stateDir, { recursive: true });
    } catch (error) {
      logger.error({ err: error }, 'Failed to create state directory');
    }
  }

  /**
   * Load current task from disk.
   */
  private async loadCurrentTask(): Promise<void> {
    try {
      const content = await fs.readFile(this.currentStateFile, 'utf-8');
      this.currentTask = JSON.parse(content);
    } catch {
      // File doesn't exist or is invalid
      this.currentTask = null;
    }
  }

  /**
   * Save current task to disk.
   */
  private async saveCurrentTask(): Promise<void> {
    await this.ensureStateDir();

    if (this.currentTask) {
      await fs.writeFile(
        this.currentStateFile,
        JSON.stringify(this.currentTask, null, 2),
        'utf-8'
      );
    } else {
      // Remove file if no current task
      try {
        await fs.unlink(this.currentStateFile);
      } catch {
        // Ignore if file doesn't exist
      }
    }
  }

  /**
   * Archive completed/cancelled task to history.
   */
  private async archiveTask(task: TaskState): Promise<void> {
    await this.ensureStateDir();

    const historyFile = path.join(this.stateDir, `task-${task.id}.json`);
    await fs.writeFile(historyFile, JSON.stringify(task, null, 2), 'utf-8');
  }

  /**
   * Start a new task.
   *
   * @param prompt - Task prompt
   * @param chatId - Chat ID
   * @param userId - User ID (optional)
   * @returns New task state
   */
  async startTask(prompt: string, chatId: string, userId?: string): Promise<TaskState> {
    // Load current task first
    await this.loadCurrentTask();

    // Check if there's already a running task
    if (this.currentTask && this.currentTask.status === 'running') {
      throw new Error(`已有任务正在执行中: ${this.currentTask.id}`);
    }

    // Create new task
    const now = new Date().toISOString();
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    this.currentTask = {
      id: taskId,
      prompt,
      status: 'running',
      progress: 0,
      chatId,
      userId,
      createdAt: now,
      updatedAt: now,
    };

    await this.saveCurrentTask();
    logger.info({ taskId, prompt }, 'Task started');

    return this.currentTask;
  }

  /**
   * Get current task status.
   *
   * @returns Current task state or null
   */
  async getCurrentTask(): Promise<TaskState | null> {
    await this.loadCurrentTask();
    return this.currentTask;
  }

  /**
   * Update task progress.
   *
   * @param progress - Progress percentage (0-100)
   * @param currentStep - Current step description (optional)
   */
  async updateProgress(progress: number, currentStep?: string): Promise<void> {
    await this.loadCurrentTask();

    if (!this.currentTask) {
      logger.warn('No current task to update');
      return;
    }

    this.currentTask.progress = Math.min(100, Math.max(0, progress));
    this.currentTask.updatedAt = new Date().toISOString();

    if (currentStep) {
      this.currentTask.currentStep = currentStep;
    }

    await this.saveCurrentTask();
  }

  /**
   * Pause current task.
   *
   * @returns Updated task state or null if no task
   */
  async pauseTask(): Promise<TaskState | null> {
    await this.loadCurrentTask();

    if (!this.currentTask) {
      return null;
    }

    if (this.currentTask.status !== 'running') {
      throw new Error(`当前任务状态为 ${this.currentTask.status}，无法暂停`);
    }

    this.currentTask.status = 'paused';
    this.currentTask.updatedAt = new Date().toISOString();

    await this.saveCurrentTask();
    logger.info({ taskId: this.currentTask.id }, 'Task paused');

    return this.currentTask;
  }

  /**
   * Resume paused task.
   *
   * @returns Updated task state or null if no task
   */
  async resumeTask(): Promise<TaskState | null> {
    await this.loadCurrentTask();

    if (!this.currentTask) {
      return null;
    }

    if (this.currentTask.status !== 'paused') {
      throw new Error(`当前任务状态为 ${this.currentTask.status}，无法恢复`);
    }

    this.currentTask.status = 'running';
    this.currentTask.updatedAt = new Date().toISOString();

    await this.saveCurrentTask();
    logger.info({ taskId: this.currentTask.id }, 'Task resumed');

    return this.currentTask;
  }

  /**
   * Cancel current task.
   *
   * @returns Cancelled task state or null if no task
   */
  async cancelTask(): Promise<TaskState | null> {
    await this.loadCurrentTask();

    if (!this.currentTask) {
      return null;
    }

    if (!['running', 'paused'].includes(this.currentTask.status)) {
      throw new Error(`当前任务状态为 ${this.currentTask.status}，无法取消`);
    }

    this.currentTask.status = 'cancelled';
    this.currentTask.updatedAt = new Date().toISOString();

    // Archive the task
    await this.archiveTask(this.currentTask);
    logger.info({ taskId: this.currentTask.id }, 'Task cancelled');

    // Clear current task
    const cancelledTask = this.currentTask;
    this.currentTask = null;
    await this.saveCurrentTask();

    return cancelledTask;
  }

  /**
   * Complete current task.
   *
   * @returns Completed task state or null if no task
   */
  async completeTask(): Promise<TaskState | null> {
    await this.loadCurrentTask();

    if (!this.currentTask) {
      return null;
    }

    this.currentTask.status = 'completed';
    this.currentTask.progress = 100;
    this.currentTask.updatedAt = new Date().toISOString();

    // Archive the task
    await this.archiveTask(this.currentTask);
    logger.info({ taskId: this.currentTask.id }, 'Task completed');

    // Clear current task
    const completedTask = this.currentTask;
    this.currentTask = null;
    await this.saveCurrentTask();

    return completedTask;
  }

  /**
   * Set task error.
   *
   * @param error - Error message
   * @returns Error task state or null if no task
   */
  async setTaskError(error: string): Promise<TaskState | null> {
    await this.loadCurrentTask();

    if (!this.currentTask) {
      return null;
    }

    this.currentTask.status = 'error';
    this.currentTask.error = error;
    this.currentTask.updatedAt = new Date().toISOString();

    // Archive the task
    await this.archiveTask(this.currentTask);
    logger.error({ taskId: this.currentTask.id, error }, 'Task error');

    // Clear current task
    const errorTask = this.currentTask;
    this.currentTask = null;
    await this.saveCurrentTask();

    return errorTask;
  }

  /**
   * List task history.
   *
   * @param limit - Maximum number of tasks to return
   * @returns Array of task states
   */
  async listTaskHistory(limit: number = 10): Promise<TaskState[]> {
    await this.ensureStateDir();

    try {
      const files = await fs.readdir(this.stateDir);
      const taskFiles = files.filter(f => f.startsWith('task-') && f.endsWith('.json'));

      // Read all task files
      const tasks: TaskState[] = [];
      for (const file of taskFiles) {
        try {
          const content = await fs.readFile(path.join(this.stateDir, file), 'utf-8');
          tasks.push(JSON.parse(content));
        } catch {
          // Skip invalid files
        }
      }

      // Sort by update date (newest first), use id as tiebreaker for stability
      // Issue #624: Use updatedAt for history order (most recently completed first)
      return tasks
        .sort((a, b) => {
          const timeDiff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
          if (timeDiff !== 0) {
            return timeDiff;
          }
          // Use id as tiebreaker (id contains timestamp: task_${Date.now()}_${random})
          return b.id.localeCompare(a.id);
        })
        .slice(0, limit);
    } catch {
      return [];
    }
  }
}

// Singleton instance
let taskStateManagerInstance: TaskStateManager | undefined;

/**
 * Get the global TaskStateManager instance.
 */
export function getTaskStateManager(): TaskStateManager {
  if (!taskStateManagerInstance) {
    taskStateManagerInstance = new TaskStateManager();
  }
  return taskStateManagerInstance;
}

/**
 * Reset the global TaskStateManager (for testing).
 */
export function resetTaskStateManager(): void {
  taskStateManagerInstance = undefined;
}
