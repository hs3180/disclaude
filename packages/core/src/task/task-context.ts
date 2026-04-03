/**
 * TaskContext - Real-time task progress tracking with file-based persistence.
 *
 * Provides a shared state mechanism between the main task execution and
 * the independent Reporter Agent. Task status is persisted to
 * `tasks/{taskId}/status.json` for inter-process communication.
 *
 * Architecture:
 *   Deep Task (主任务) → TaskContext.updateProgress() → status.json
 *   Reporter Agent    → TaskContext.getStatus()      → status.json
 *
 * @module task/task-context
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskContext');

/**
 * Represents a single step in task execution.
 */
export interface TaskStep {
  /** Step description */
  description: string;
  /** Step status */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** Timestamp when step started */
  startedAt?: string;
  /** Timestamp when step completed */
  completedAt?: string;
  /** Error message if step failed */
  error?: string;
}

/**
 * Task progress information for status reporting.
 */
export interface TaskProgress {
  /** Unique task identifier (typically messageId) */
  taskId: string;
  /** Human-readable task title */
  title: string;
  /** Current task status */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** Brief description of current activity */
  currentStep: string;
  /** Total number of planned steps */
  totalSteps: number;
  /** Number of completed steps */
  completedSteps: number;
  /** Task creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
  /** Task start timestamp (ISO 8601), set when status becomes 'running' */
  startedAt?: string;
  /** Completion timestamp (ISO 8601), set when status is terminal */
  completedAt?: string;
  /** Error message if task failed */
  error?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * TaskContext - Manages real-time task progress with file-based persistence.
 *
 * Designed for inter-process communication between:
 * - The main task execution (writes progress)
 * - The independent Reporter Agent (reads progress)
 *
 * Usage:
 * ```typescript
 * // In task execution:
 * const ctx = new TaskContext(workspaceDir);
 * await ctx.initTask('msg_123', 'Fix auth bug');
 * await ctx.startTask('msg_123');
 * await ctx.updateProgress('msg_123', { currentStep: 'Reading auth.service.ts', completedSteps: 1 });
 * await ctx.completeTask('msg_123');
 *
 * // In Reporter Agent:
 * const ctx = new TaskContext(workspaceDir);
 * const progress = await ctx.getStatus('msg_123');
 * ```
 */
export class TaskContext {
  private readonly tasksDir: string;

  constructor(workspaceDir: string) {
    this.tasksDir = path.join(workspaceDir, 'tasks');
  }

  /**
   * Get the status.json file path for a task.
   */
  getStatusPath(taskId: string): string {
    const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.tasksDir, sanitized, 'status.json');
  }

  /**
   * Initialize a new task with default progress values.
   * Creates the task directory and writes initial status.json.
   *
   * @param taskId - Unique task identifier
   * @param title - Human-readable task title
   * @param options - Optional metadata
   */
  async initTask(
    taskId: string,
    title: string,
    options?: {
      totalSteps?: number;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    const statusPath = this.getStatusPath(taskId);
    const dir = path.dirname(statusPath);

    await fs.mkdir(dir, { recursive: true });

    const progress: TaskProgress = {
      taskId,
      title,
      status: 'pending',
      currentStep: 'Task created, waiting to start...',
      totalSteps: options?.totalSteps ?? 0,
      completedSteps: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: options?.metadata,
    };

    await fs.writeFile(statusPath, JSON.stringify(progress, null, 2), 'utf-8');
    logger.info({ taskId, title }, 'Task context initialized');
  }

  /**
   * Mark a task as running.
   *
   * @param taskId - Unique task identifier
   * @param currentStep - Description of the first step
   */
  async startTask(taskId: string, currentStep?: string): Promise<void> {
    const statusPath = this.getStatusPath(taskId);

    let progress: TaskProgress;
    try {
      const content = await fs.readFile(statusPath, 'utf-8');
      progress = JSON.parse(content) as TaskProgress;
    } catch {
      logger.warn({ taskId }, 'Cannot start task: status.json not found, initializing');
      await this.initTask(taskId, 'Unknown Task');
      const content = await fs.readFile(statusPath, 'utf-8');
      progress = JSON.parse(content) as TaskProgress;
    }

    progress.status = 'running';
    progress.currentStep = currentStep ?? 'Task execution started...';
    if (!progress.startedAt) {
      progress.startedAt = new Date().toISOString();
    }
    progress.updatedAt = new Date().toISOString();

    await fs.writeFile(statusPath, JSON.stringify(progress, null, 2), 'utf-8');
    logger.info({ taskId }, 'Task context: started');
  }

  /**
   * Update task progress information.
   * Only updates the fields that are provided.
   *
   * @param taskId - Unique task identifier
   * @param updates - Partial progress update
   */
  async updateProgress(
    taskId: string,
    updates: Partial<Pick<TaskProgress, 'status' | 'currentStep' | 'totalSteps' | 'completedSteps' | 'error'>>
  ): Promise<void> {
    const statusPath = this.getStatusPath(taskId);

    let progress: TaskProgress;
    try {
      const content = await fs.readFile(statusPath, 'utf-8');
      progress = JSON.parse(content) as TaskProgress;
    } catch {
      logger.warn({ taskId }, 'Cannot update progress: status.json not found, initializing');
      await this.initTask(taskId, 'Unknown Task');
      const content = await fs.readFile(statusPath, 'utf-8');
      progress = JSON.parse(content) as TaskProgress;
    }

    // Apply updates
    if (updates.status !== undefined) {
      progress.status = updates.status;
    }
    if (updates.currentStep !== undefined) {
      progress.currentStep = updates.currentStep;
    }
    if (updates.totalSteps !== undefined) {
      progress.totalSteps = updates.totalSteps;
    }
    if (updates.completedSteps !== undefined) {
      progress.completedSteps = updates.completedSteps;
    }
    if (updates.error !== undefined) {
      progress.error = updates.error;
    }

    // Auto-set timestamps for terminal states
    if (updates.status === 'running' && !progress.startedAt) {
      progress.startedAt = new Date().toISOString();
    }
    if (updates.status === 'completed' || updates.status === 'failed') {
      progress.completedAt = new Date().toISOString();
    }

    progress.updatedAt = new Date().toISOString();

    await fs.writeFile(statusPath, JSON.stringify(progress, null, 2), 'utf-8');
    logger.debug(
      { taskId, status: progress.status, step: progress.currentStep },
      'Task progress updated'
    );
  }

  /**
   * Mark a task as completed.
   *
   * @param taskId - Unique task identifier
   * @param summary - Optional completion summary
   */
  async completeTask(taskId: string, summary?: string): Promise<void> {
    await this.updateProgress(taskId, {
      status: 'completed',
      currentStep: summary ?? 'Task completed successfully',
    });
    logger.info({ taskId }, 'Task context: completed');
  }

  /**
   * Mark a task as failed.
   *
   * @param taskId - Unique task identifier
   * @param error - Error description
   */
  async failTask(taskId: string, error: string): Promise<void> {
    await this.updateProgress(taskId, {
      status: 'failed',
      currentStep: `Task failed: ${error}`,
      error,
    });
    logger.error({ taskId, error }, 'Task context: failed');
  }

  /**
   * Read the current task progress.
   * Returns null if the task does not exist.
   *
   * @param taskId - Unique task identifier
   * @returns Current task progress, or null if not found
   */
  async getStatus(taskId: string): Promise<TaskProgress | null> {
    const statusPath = this.getStatusPath(taskId);

    try {
      const content = await fs.readFile(statusPath, 'utf-8');
      return JSON.parse(content) as TaskProgress;
    } catch {
      logger.debug({ taskId }, 'Task status not found');
      return null;
    }
  }

  /**
   * List all tasks that have a status.json file.
   *
   * @returns Array of task progress objects
   */
  async listAllStatus(): Promise<TaskProgress[]> {
    try {
      const entries = await fs.readdir(this.tasksDir, { withFileTypes: true });
      const results: TaskProgress[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const statusPath = path.join(this.tasksDir, entry.name, 'status.json');
          try {
            const content = await fs.readFile(statusPath, 'utf-8');
            results.push(JSON.parse(content) as TaskProgress);
          } catch {
            // No status.json in this directory, skip
          }
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  /**
   * Get running tasks (tasks with status 'running').
   *
   * @returns Array of running task progress objects
   */
  async getRunningTasks(): Promise<TaskProgress[]> {
    const all = await this.listAllStatus();
    return all.filter((t) => t.status === 'running');
  }

  /**
   * Calculate the elapsed time for a task in human-readable format.
   *
   * @param progress - Task progress object
   * @returns Human-readable elapsed time string (e.g., "2m 30s")
   */
  static formatElapsedTime(progress: TaskProgress): string {
    const start = progress.startedAt
      ? new Date(progress.startedAt).getTime()
      : new Date(progress.createdAt).getTime();
    const end =
      progress.status === 'completed' || progress.status === 'failed'
        ? new Date(progress.completedAt ?? progress.updatedAt).getTime()
        : Date.now();

    const elapsedMs = end - start;
    const seconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }

  /**
   * Format a progress summary as markdown for display.
   *
   * @param progress - Task progress object
   * @returns Markdown formatted progress summary
   */
  static formatProgressMarkdown(progress: TaskProgress): string {
    const elapsed = TaskContext.formatElapsedTime(progress);
    const statusEmoji =
      progress.status === 'completed'
        ? '✅'
        : progress.status === 'failed'
          ? '❌'
          : progress.status === 'running'
            ? '🔄'
            : '⏳';

    const lines: string[] = [
      `${statusEmoji} **${progress.title}**`,
      `**Status**: ${progress.status}`,
      `**Current**: ${progress.currentStep}`,
    ];

    if (progress.totalSteps > 0) {
      lines.push(`**Progress**: ${progress.completedSteps}/${progress.totalSteps} steps`);
    }

    lines.push(`**Elapsed**: ${elapsed}`);

    if (progress.error) {
      lines.push(`**Error**: ${progress.error}`);
    }

    return lines.join('\n');
  }
}
