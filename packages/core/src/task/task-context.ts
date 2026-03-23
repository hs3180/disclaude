/**
 * TaskContext - Shared progress state for task execution.
 *
 * Provides a file-based progress tracking mechanism that allows
 * independent agents (like Progress Reporter) to read task status
 * without interfering with the main execution flow.
 *
 * The progress state is stored as `progress.json` in the task directory:
 *
 * tasks/{task_id}/
 *   ├── task.md
 *   ├── progress.json  ← TaskContext writes here
 *   ├── running.lock
 *   └── iterations/
 *
 * Design Principles:
 * - File-based: Uses JSON file for cross-process communication
 * - Independent: Reporter Agent reads progress without blocking main task
 * - Lightweight: Minimal overhead, only updated at phase transitions
 * - Human-readable: JSON format for easy debugging
 *
 * @module task/task-context
 * @see https://github.com/hs3180/disclaude/issues/857
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskContext');

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Execution phase of a deep task.
 */
export type TaskPhase = 'idle' | 'evaluating' | 'executing' | 'reporting';

/**
 * Overall task progress status.
 *
 * Note: Named `TaskProgressStatus` to avoid collision with
 * `TaskStatus` from the queue module (`@disclaude/core/queue`).
 */
export type TaskProgressStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * Progress state for a task, stored as progress.json.
 *
 * This is the shared state that both the main task flow (writer)
 * and the Progress Reporter Agent (reader) use to communicate.
 */
export interface TaskProgress {
  /** Task identifier (typically messageId) */
  taskId: string;
  /** Overall task status */
  status: TaskProgressStatus;
  /** Current execution phase */
  currentPhase: TaskPhase;
  /** Current iteration number (1-indexed) */
  currentIteration: number;
  /** Total completed iterations */
  completedIterations: number;
  /** Maximum iterations allowed (from task.md frontmatter) */
  maxIterations: number;
  /** Human-readable description of current activity */
  currentStep: string;
  /** Last evaluation status (COMPLETE or NEED_EXECUTE) */
  lastEvaluationStatus?: 'COMPLETE' | 'NEED_EXECUTE';
  /** List of files modified during execution */
  filesModified: string[];
  /** ISO timestamp of when the task started */
  startedAt: string;
  /** ISO timestamp of last progress update */
  lastUpdatedAt: string;
  /** ISO timestamp of task completion (if applicable) */
  completedAt?: string;
  /** Error message (if failed) */
  error?: string;
}

// ============================================================================
// TaskContext Implementation
// ============================================================================

/**
 * Manages task progress state via file-based storage.
 *
 * The main task flow (deep-task schedule) writes progress updates,
 * while the Progress Reporter Agent reads them independently.
 *
 * @example
 * ```typescript
 * const ctx = new TaskContext({ workspaceDir: '/workspace' });
 *
 * // Writer: update progress during execution
 * await ctx.updateProgress('task-123', {
 *   status: 'running',
 *   currentPhase: 'executing',
 *   currentIteration: 2,
 *   currentStep: 'Implementing auth module',
 * });
 *
 * // Reader: get current progress
 * const progress = await ctx.readProgress('task-123');
 * console.log(`Phase: ${progress.currentPhase}, Step: ${progress.currentStep}`);
 * ```
 */
export class TaskContext {
  private readonly tasksBaseDir: string;

  /**
   * Create a TaskContext instance.
   *
   * @param workspaceDir - Workspace directory containing tasks/
   */
  constructor(workspaceDir: string) {
    this.tasksBaseDir = path.join(workspaceDir, 'tasks');
  }

  /**
   * Get the path to progress.json for a task.
   *
   * @param taskId - Task identifier
   * @returns Absolute path to progress.json
   */
  getProgressPath(taskId: string): string {
    const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.tasksBaseDir, sanitized, 'progress.json');
  }

  /**
   * Check if progress.json exists for a task.
   *
   * @param taskId - Task identifier
   * @returns True if progress.json exists
   */
  async hasProgress(taskId: string): Promise<boolean> {
    try {
      await fs.access(this.getProgressPath(taskId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read current progress for a task.
   *
   * @param taskId - Task identifier
   * @returns Current progress state
   * @throws Error if progress.json doesn't exist
   */
  async readProgress(taskId: string): Promise<TaskProgress> {
    const progressPath = this.getProgressPath(taskId);

    try {
      const content = await fs.readFile(progressPath, 'utf-8');
      return JSON.parse(content) as TaskProgress;
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to read progress');
      throw new Error(`Progress not found for task ${taskId}`);
    }
  }

  /**
   * Initialize progress for a new task.
   *
   * Creates progress.json with initial state when a task begins execution.
   *
   * @param taskId - Task identifier
   * @param maxIterations - Maximum iterations allowed (default: 10)
   */
  async initializeProgress(taskId: string, maxIterations: number = 10): Promise<void> {
    const progress: TaskProgress = {
      taskId,
      status: 'running',
      currentPhase: 'idle',
      currentIteration: 0,
      completedIterations: 0,
      maxIterations,
      currentStep: 'Task initialized, waiting for evaluation',
      filesModified: [],
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    };

    await this.writeProgress(taskId, progress);
    logger.info({ taskId }, 'Progress initialized');
  }

  /**
   * Write/update progress for a task.
   *
   * @param taskId - Task identifier
   * @param updates - Partial progress update (merged with existing)
   */
  async updateProgress(taskId: string, updates: Partial<TaskProgress>): Promise<void> {
    let progress: TaskProgress;

    try {
      progress = await this.readProgress(taskId);
    } catch {
      // If no existing progress, initialize with defaults
      progress = {
        taskId,
        status: 'pending',
        currentPhase: 'idle',
        currentIteration: 0,
        completedIterations: 0,
        maxIterations: 10,
        currentStep: '',
        filesModified: [],
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
      };
    }

    // Merge updates
    const updated: TaskProgress = {
      ...progress,
      ...updates,
      lastUpdatedAt: new Date().toISOString(),
    };

    await this.writeProgress(taskId, updated);
    logger.debug(
      { taskId, phase: updated.currentPhase, step: updated.currentStep },
      'Progress updated'
    );
  }

  /**
   * Update the current phase of task execution.
   *
   * Convenience method for phase transitions.
   *
   * @param taskId - Task identifier
   * @param phase - New execution phase
   * @param step - Human-readable description
   */
  async setPhase(taskId: string, phase: TaskPhase, step: string): Promise<void> {
    await this.updateProgress(taskId, { currentPhase: phase, currentStep: step });
  }

  /**
   * Mark the current iteration as completed and advance.
   *
   * @param taskId - Task identifier
   * @param evaluationStatus - Result of the evaluation (COMPLETE or NEED_EXECUTE)
   */
  async completeIteration(
    taskId: string,
    evaluationStatus: 'COMPLETE' | 'NEED_EXECUTE'
  ): Promise<void> {
    const progress = await this.readProgress(taskId);

    await this.updateProgress(taskId, {
      completedIterations: progress.completedIterations + 1,
      lastEvaluationStatus: evaluationStatus,
    });
  }

  /**
   * Start a new iteration.
   *
   * @param taskId - Task identifier
   * @param iteration - Iteration number (1-indexed)
   */
  async startIteration(taskId: string, iteration: number): Promise<void> {
    await this.updateProgress(taskId, {
      currentIteration: iteration,
      currentStep: `Starting iteration ${iteration}`,
    });
  }

  /**
   * Add modified files to the progress tracking.
   *
   * @param taskId - Task identifier
   * @param files - List of modified file paths
   */
  async addModifiedFiles(taskId: string, files: string[]): Promise<void> {
    const progress = await this.readProgress(taskId);
    const existing = new Set(progress.filesModified);
    for (const file of files) {
      existing.add(file);
    }
    await this.updateProgress(taskId, {
      filesModified: Array.from(existing),
    });
  }

  /**
   * Mark task as completed.
   *
   * @param taskId - Task identifier
   * @param summary - Optional completion summary
   */
  async completeTask(taskId: string, summary?: string): Promise<void> {
    await this.updateProgress(taskId, {
      status: 'completed',
      currentPhase: 'reporting',
      currentStep: summary || 'Task completed successfully',
      completedAt: new Date().toISOString(),
    });
  }

  /**
   * Mark task as failed.
   *
   * @param taskId - Task identifier
   * @param error - Error message
   */
  async failTask(taskId: string, error: string): Promise<void> {
    await this.updateProgress(taskId, {
      status: 'failed',
      currentStep: `Failed: ${error}`,
      error,
      completedAt: new Date().toISOString(),
    });
  }

  /**
   * Get a human-readable summary of task progress.
   *
   * Useful for the Progress Reporter Agent to format user-facing messages.
   *
   * @param taskId - Task identifier
   * @returns Formatted progress summary
   */
  async getProgressSummary(taskId: string): Promise<string> {
    const progress = await this.readProgress(taskId);
    const elapsed = this.formatDuration(
      Date.now() - new Date(progress.startedAt).getTime()
    );

    const lines = [
      `**Status**: ${this.formatStatus(progress.status)}`,
      `**Phase**: ${this.formatPhase(progress.currentPhase)}`,
      `**Iteration**: ${progress.currentIteration} (completed ${progress.completedIterations}/${progress.maxIterations})`,
      `**Current Step**: ${progress.currentStep}`,
      `**Elapsed**: ${elapsed}`,
    ];

    if (progress.filesModified.length > 0) {
      lines.push(`**Files Modified**: ${progress.filesModified.length}`);
    }

    if (progress.lastEvaluationStatus) {
      lines.push(`**Last Evaluation**: ${progress.lastEvaluationStatus}`);
    }

    if (progress.error) {
      lines.push(`**Error**: ${progress.error}`);
    }

    return lines.join('\n');
  }

  /**
   * List all tasks that have progress tracking.
   *
   * @returns Array of task IDs with progress files
   */
  async listTrackedTasks(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.tasksBaseDir, { withFileTypes: true });
      const tracked: string[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const progressPath = path.join(this.tasksBaseDir, entry.name, 'progress.json');
          try {
            await fs.access(progressPath);
            tracked.push(entry.name);
          } catch {
            // No progress file, skip
          }
        }
      }

      return tracked;
    } catch {
      return [];
    }
  }

  /**
   * Get progress for all currently running tasks.
   *
   * @returns Array of progress states for running tasks
   */
  async getRunningTasksProgress(): Promise<TaskProgress[]> {
    const taskIds = await this.listTrackedTasks();
    const running: TaskProgress[] = [];

    for (const taskId of taskIds) {
      try {
        const progress = await this.readProgress(taskId);
        if (progress.status === 'running') {
          running.push(progress);
        }
      } catch {
        // Skip if progress can't be read
      }
    }

    return running;
  }

  /**
   * Remove progress file for a task.
   *
   * @param taskId - Task identifier
   */
  async removeProgress(taskId: string): Promise<void> {
    try {
      await fs.unlink(this.getProgressPath(taskId));
      logger.debug({ taskId }, 'Progress removed');
    } catch {
      // File may not exist, ignore
    }
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Write progress state to file.
   */
  private async writeProgress(taskId: string, progress: TaskProgress): Promise<void> {
    const progressPath = this.getProgressPath(taskId);

    try {
      // Ensure the task directory exists before writing
      await fs.mkdir(path.dirname(progressPath), { recursive: true });
      await fs.writeFile(progressPath, JSON.stringify(progress, null, 2), 'utf-8');
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to write progress');
      throw error;
    }
  }

  /**
   * Format a status enum to a display string.
   */
  private formatStatus(status: TaskProgressStatus): string {
    const map: Record<TaskProgressStatus, string> = {
      pending: '⏳ Pending',
      running: '🔄 Running',
      completed: '✅ Completed',
      failed: '❌ Failed',
    };
    return map[status] || status;
  }

  /**
   * Format a phase enum to a display string.
   */
  private formatPhase(phase: TaskPhase): string {
    const map: Record<TaskPhase, string> = {
      idle: '💤 Idle',
      evaluating: '🔍 Evaluating',
      executing: '⚡ Executing',
      reporting: '📊 Reporting',
    };
    return map[phase] || phase;
  }

  /**
   * Format milliseconds to a human-readable duration.
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
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
}
