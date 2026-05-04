/**
 * TaskContext - Reads current task status from the file system.
 *
 * Provides a structured view of a task's current state, including:
 * - Task status (pending, running, completed, failed)
 * - Iteration progress (completed iterations, current phase)
 * - Elapsed time since task creation
 * - Task specification summary
 *
 * This module serves as the foundation for the progress reporting system.
 * The independent Reporter Agent can use TaskContext to read task status
 * and decide when/how to report progress to the user.
 *
 * Directory structure (managed by TaskFileManager):
 * ```
 * {task_id}/
 *   ├── task.md                    → Task specification
 *   ├── final_result.md            → Created when task is COMPLETE
 *   └── iterations/
 *       ├── iter-1/
 *       │   ├── evaluation.md      → Evaluator output
 *       │   └── execution.md       → Executor output
 *       ├── iter-2/
 *       │   ├── evaluation.md
 *       │   └── execution.md
 *       └── final-summary.md       → Final summary
 * ```
 *
 * @module task/task-context
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskContext');

/**
 * Current status of a task.
 */
export type TaskContextStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * Current phase within an iteration.
 */
export type IterationPhase = 'evaluation' | 'execution';

/**
 * Structured task context information.
 * Returned by TaskContext.getTaskContext().
 */
export interface TaskContextInfo {
  /** Task identifier */
  taskId: string;
  /** Current status of the task */
  status: TaskContextStatus;
  /** Task title (extracted from task.md) */
  title: string;
  /** ISO 8601 timestamp when the task was created */
  createdAt: string | null;
  /** Number of completed iterations */
  iterationsCompleted: number;
  /** Current iteration phase (if running) */
  currentPhase: IterationPhase | null;
  /** Elapsed time in milliseconds since task creation */
  elapsedMs: number | null;
  /** Original request text (from task.md) */
  originalRequest: string | null;
}

/**
 * Summary of all tasks in the workspace.
 */
export interface TaskSummary {
  /** Total number of tasks */
  total: number;
  /** Number of pending tasks */
  pending: number;
  /** Number of running tasks */
  running: number;
  /** Number of completed tasks */
  completed: number;
  /** Number of failed tasks */
  failed: number;
  /** List of running task IDs */
  runningTaskIds: string[];
}

/**
 * TaskContext - Reads current task status from the file system.
 *
 * This class provides read-only access to task state information.
 * It does not modify any files and can be safely used concurrently.
 *
 * @example
 * ```typescript
 * const taskContext = new TaskContext({ workspaceDir: '/path/to/workspace' });
 *
 * // Get status of a specific task
 * const info = await taskContext.getTaskContext('my-task-id');
 * console.log(info.status);        // 'running'
 * console.log(info.iterationsCompleted); // 2
 * console.log(info.currentPhase);  // 'evaluation'
 *
 * // Get summary of all tasks
 * const summary = await taskContext.getTaskSummary();
 * console.log(summary.running); // 3
 * ```
 */
export class TaskContext {
  private readonly tasksDir: string;

  /**
   * Create a TaskContext instance.
   *
   * @param config - Configuration
   * @param config.workspaceDir - Path to the workspace directory
   * @param config.subdirectory - Optional subdirectory within tasks/
   */
  constructor(config: { workspaceDir: string; subdirectory?: string }) {
    this.tasksDir = config.subdirectory
      ? path.join(config.workspaceDir, 'tasks', config.subdirectory)
      : path.join(config.workspaceDir, 'tasks');
  }

  /**
   * Get the full context information for a specific task.
   *
   * @param taskId - Task identifier
   * @returns Task context information, or null if task not found
   */
  async getTaskContext(taskId: string): Promise<TaskContextInfo | null> {
    const taskDir = this.getTaskDir(taskId);

    // Check if task directory exists
    try {
      await fs.access(taskDir);
    } catch {
      logger.debug({ taskId }, 'Task directory not found');
      return null;
    }

    const taskSpecPath = path.join(taskDir, 'task.md');

    // Read task spec
    let title: string = taskId;
    let createdAt: string | null = null;
    let originalRequest: string | null = null;

    try {
      const specContent = await fs.readFile(taskSpecPath, 'utf-8');
      const { title: parsedTitle, createdAt: parsedCreatedAt, originalRequest: parsedRequest } = this.parseTaskSpec(specContent);
      title = parsedTitle;
      createdAt = parsedCreatedAt;
      originalRequest = parsedRequest;
    } catch {
      logger.debug({ taskId }, 'Could not read task spec');
    }

    // Determine status
    const status = await this.determineStatus(taskId);

    // Count iterations and determine current phase
    const iterationsCompleted = await this.countCompletedIterations(taskId);
    const currentPhase = await this.determineCurrentPhase(taskId);

    // Calculate elapsed time
    let elapsedMs: number | null = null;
    if (createdAt) {
      elapsedMs = Date.now() - new Date(createdAt).getTime();
    }

    return {
      taskId,
      status,
      title,
      createdAt,
      iterationsCompleted,
      currentPhase,
      elapsedMs,
      originalRequest,
    };
  }

  /**
   * Get a summary of all tasks in the workspace.
   *
   * @returns Task summary with counts by status
   */
  async getTaskSummary(): Promise<TaskSummary> {
    const summary: TaskSummary = {
      total: 0,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      runningTaskIds: [],
    };

    let entries;
    try {
      entries = await fs.readdir(this.tasksDir, { withFileTypes: true });
    } catch {
      logger.debug('Tasks directory not found or empty');
      return summary;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {continue;}
      // Reconstruct task ID from directory name (may contain sanitized characters)
      const taskId = entry.name;
      summary.total++;

      const status = await this.determineStatus(taskId);
      switch (status) {
        case 'pending':
          summary.pending++;
          break;
        case 'running':
          summary.running++;
          summary.runningTaskIds.push(taskId);
          break;
        case 'completed':
          summary.completed++;
          break;
        case 'failed':
          summary.failed++;
          break;
      }
    }

    return summary;
  }

  /**
   * List all task IDs in the workspace.
   *
   * @param options - Filter options
   * @returns Array of task IDs matching the filter
   */
  async listTasks(options?: { status?: TaskContextStatus }): Promise<string[]> {
    let entries;
    try {
      entries = await fs.readdir(this.tasksDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const taskIds: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {continue;}

      if (options?.status) {
        const status = await this.determineStatus(entry.name);
        if (status === options.status) {
          taskIds.push(entry.name);
        }
      } else {
        taskIds.push(entry.name);
      }
    }

    return taskIds;
  }

  /**
   * Check if a specific task is currently running.
   *
   * @param taskId - Task identifier
   * @returns True if the task is running
   */
  async isRunning(taskId: string): Promise<boolean> {
    const status = await this.determineStatus(taskId);
    return status === 'running';
  }

  /**
   * Get the sanitized task directory path.
   */
  private getTaskDir(taskId: string): string {
    const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.tasksDir, sanitized);
  }

  /**
   * Determine the status of a task based on file presence.
   *
   * Status logic:
   * - If final_result.md exists → 'completed'
   * - If any iteration has content → 'running'
   * - Otherwise → 'pending'
   *
   * Note: 'failed' status is detected by checking if iterations
   * exist but the task appears stalled (no final_result.md and
   * no recent file modifications).
   *
   * @param taskId - Task identifier
   * @returns Task status
   */
  private async determineStatus(taskId: string): Promise<TaskContextStatus> {
    const taskDir = this.getTaskDir(taskId);

    // Check for final_result.md (completed)
    const finalResultPath = path.join(taskDir, 'final_result.md');
    try {
      await fs.access(finalResultPath);
      return 'completed';
    } catch {
      // final_result.md doesn't exist
    }

    // Check for any iterations (running)
    const iterationsDir = path.join(taskDir, 'iterations');
    try {
      const iterEntries = await fs.readdir(iterationsDir, { withFileTypes: true });
      const hasIterationDirs = iterEntries.some(
        e => e.isDirectory() && e.name.startsWith('iter-')
      );
      if (hasIterationDirs) {
        // Check if the task appears to be stalled (failed)
        const isStalled = await this.isTaskStalled(taskId);
        return isStalled ? 'failed' : 'running';
      }
    } catch {
      // iterations dir doesn't exist
    }

    // Check if task.md exists (pending)
    const taskSpecPath = path.join(taskDir, 'task.md');
    try {
      await fs.access(taskSpecPath);
      return 'pending';
    } catch {
      // No task.md means the directory is not a valid task
      return 'pending';
    }
  }

  /**
   * Check if a running task appears to be stalled (failed).
   *
   * A task is considered stalled if its most recent file modification
   * was more than STALL_THRESHOLD_MS ago.
   *
   * @param taskId - Task identifier
   * @returns True if the task appears stalled
   */
  private async isTaskStalled(taskId: string): Promise<boolean> {
    const STALL_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

    const taskDir = this.getTaskDir(taskId);
    const latestMtime = await this.getLatestModificationTime(taskDir);

    if (latestMtime === null) {
      return false;
    }

    const elapsed = Date.now() - latestMtime.getTime();
    return elapsed > STALL_THRESHOLD_MS;
  }

  /**
   * Get the latest file modification time in a directory (recursive).
   *
   * @param dirPath - Directory to scan
   * @returns Latest modification time, or null if directory is empty
   */
  private async getLatestModificationTime(dirPath: string): Promise<Date | null> {
    let latest: Date | null = null;

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          const subLatest = await this.getLatestModificationTime(fullPath);
          if (subLatest && (!latest || subLatest > latest)) {
            latest = subLatest;
          }
        } else {
          try {
            const stat = await fs.stat(fullPath);
            if (!latest || stat.mtime > latest) {
              latest = stat.mtime;
            }
          } catch {
            // Skip files that can't be stat'd
          }
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }

    return latest;
  }

  /**
   * Count the number of completed iterations for a task.
   *
   * An iteration is considered "completed" if it has both
   * evaluation.md and execution.md files.
   *
   * @param taskId - Task identifier
   * @returns Number of completed iterations
   */
  private async countCompletedIterations(taskId: string): Promise<number> {
    const iterationsDir = path.join(this.getTaskDir(taskId), 'iterations');

    try {
      const entries = await fs.readdir(iterationsDir, { withFileTypes: true });
      let count = 0;

      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('iter-')) {continue;}

        const iterDir = path.join(iterationsDir, entry.name);
        const hasEvaluation = await this.fileExists(path.join(iterDir, 'evaluation.md'));
        const hasExecution = await this.fileExists(path.join(iterDir, 'execution.md'));

        if (hasEvaluation && hasExecution) {
          count++;
        }
      }

      return count;
    } catch {
      return 0;
    }
  }

  /**
   * Determine the current phase of the active iteration.
   *
   * @param taskId - Task identifier
   * @returns Current phase, or null if not in an active iteration
   */
  private async determineCurrentPhase(taskId: string): Promise<IterationPhase | null> {
    const iterationsDir = path.join(this.getTaskDir(taskId), 'iterations');

    try {
      const entries = await fs.readdir(iterationsDir, { withFileTypes: true });

      // Find the highest iteration number
      let maxIter = 0;
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('iter-')) {continue;}
        const match = entry.name.match(/^iter-(\d+)$/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxIter) {maxIter = num;}
        }
      }

      if (maxIter === 0) {return null;}

      // Check the latest iteration's phase
      const iterDir = path.join(iterationsDir, `iter-${maxIter}`);
      const hasEvaluation = await this.fileExists(path.join(iterDir, 'evaluation.md'));
      const hasExecution = await this.fileExists(path.join(iterDir, 'execution.md'));

      if (hasEvaluation && !hasExecution) {
        return 'execution'; // Evaluation done, execution in progress
      } else if (!hasEvaluation) {
        return 'evaluation'; // Evaluation in progress
      }

      // Both files exist - iteration complete, no active phase
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Parse task.md to extract metadata.
   *
   * @param content - Content of task.md
   * @returns Parsed metadata
   */
  private parseTaskSpec(content: string): {
    title: string;
    createdAt: string | null;
    originalRequest: string | null;
  } {
    let title = 'Unknown Task';
    let createdAt: string | null = null;
    let originalRequest: string | null = null;

    // Extract title from first heading
    const titleMatch = content.match(/^#\s+Task:\s+(.+)$/m);
    if (titleMatch) {
      title = titleMatch[1].trim();
    }

    // Extract created timestamp
    const createdMatch = content.match(/\*\*Created\*\*:\s*(.+)$/m);
    if (createdMatch) {
      createdAt = createdMatch[1].trim();
    }

    // Extract original request
    const requestMatch = content.match(/## Original Request\s*\n\s*```\s*\n([\s\S]*?)\n```/);
    if (requestMatch) {
      originalRequest = requestMatch[1].trim();
    }

    return { title, createdAt, originalRequest };
  }

  /**
   * Check if a file exists.
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
