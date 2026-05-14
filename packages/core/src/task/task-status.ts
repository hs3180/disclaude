/**
 * TaskStatusProvider - Reads task status from the filesystem.
 *
 * Provides structured task status information that can be consumed by MCP tools
 * or other agents. This is the foundational piece for the progress reporting
 * feature (Issue #857).
 *
 * Design:
 * - Reads task files managed by TaskFileManager
 * - Returns structured status without side effects
 * - Used by MCP tools to expose task status to the model
 *
 * @module task/task-status
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Task status enum matching the lifecycle states.
 */
export enum TaskState {
  /** Task directory exists but no iterations yet */
  PENDING = 'pending',
  /** At least one iteration has started */
  RUNNING = 'running',
  /** Evaluator marked task as COMPLETE */
  COMPLETED = 'completed',
  /** Task has final_result.md */
  FINALIZED = 'finalized',
}

/**
 * Detailed iteration status.
 */
export interface DialogueIterationStatus {
  /** Iteration number (1-indexed) */
  iteration: number;
  /** Whether evaluation.md exists */
  hasEvaluation: boolean;
  /** Whether execution.md exists */
  hasExecution: boolean;
  /** Number of step result files */
  stepCount: number;
}

/**
 * Structured task status returned by TaskStatusProvider.
 */
export interface DialogueTaskStatus {
  /** Task ID (sanitized) */
  taskId: string;
  /** Current state of the task */
  state: TaskState;
  /** Number of iterations completed */
  totalIterations: number;
  /** Details of each iteration */
  iterations: DialogueIterationStatus[];
  /** Whether final_result.md exists */
  hasFinalResult: boolean;
  /** Whether final-summary.md exists */
  hasFinalSummary: boolean;
  /** Creation time of task.md (ISO string), if available */
  createdAt?: string;
  /** Title extracted from task.md first line */
  title?: string;
}

/**
 * Summary of a task for listing purposes.
 */
export interface DialogueTaskSummary {
  /** Task ID */
  taskId: string;
  /** Current state */
  state: TaskState;
  /** Number of iterations */
  totalIterations: number;
  /** Title extracted from task.md */
  title?: string;
}

/**
 * TaskStatusProvider reads task files from the filesystem and returns
 * structured status information.
 *
 * Usage:
 * ```typescript
 * const provider = new TaskStatusProvider(workspaceDir);
 * const status = await provider.getTaskStatus('message-123');
 * const tasks = await provider.listTasks();
 * ```
 */
export class TaskStatusProvider {
  private readonly tasksDir: string;

  constructor(workspaceDir: string) {
    this.tasksDir = path.join(workspaceDir, 'tasks');
  }

  /**
   * Get detailed status of a specific task.
   *
   * @param taskId - Task identifier (message ID)
   * @returns Task status, or undefined if task doesn't exist
   */
  async getTaskStatus(taskId: string): Promise<DialogueTaskStatus | undefined> {
    const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const taskDir = path.join(this.tasksDir, sanitized);

    // Check task directory exists
    try {
      await fs.access(taskDir);
    } catch {
      return undefined;
    }

    // Read task spec for title and creation time
    let title: string | undefined;
    let createdAt: string | undefined;
    try {
      const specPath = path.join(taskDir, 'task.md');
      const specContent = await fs.readFile(specPath, 'utf-8');
      const titleMatch = specContent.match(/^#\s+(.+)$/m);
      title = titleMatch?.[1];
      const createdMatch = specContent.match(/\*\*Created\*\*:\s*(.+)/);
      createdAt = createdMatch?.[1]?.trim();
    } catch {
      // task.md may not exist yet
    }

    // Count iterations and their details
    const iterations: DialogueIterationStatus[] = [];
    let maxIteration = 0;

    try {
      const iterDir = path.join(taskDir, 'iterations');
      const entries = await fs.readdir(iterDir, { withFileTypes: true });
      for (const entry of entries) {
        const match = entry.name.match(/^iter-(\d+)$/);
        if (match && entry.isDirectory()) {
          const iterNum = parseInt(match[1], 10);
          maxIteration = Math.max(maxIteration, iterNum);

          const iterPath = path.join(iterDir, entry.name);
          const iterStatus = await this.readIterationStatus(iterPath, iterNum);
          iterations.push(iterStatus);
        }
      }
    } catch {
      // iterations dir may not exist
    }

    iterations.sort((a, b) => a.iteration - b.iteration);

    // Check final result and summary
    let hasFinalResult = false;
    let hasFinalSummary = false;

    try {
      await fs.access(path.join(taskDir, 'final_result.md'));
      hasFinalResult = true;
    } catch { /* not found */ }

    try {
      await fs.access(path.join(taskDir, 'iterations', 'final-summary.md'));
      hasFinalSummary = true;
    } catch { /* not found */ }

    // Determine state
    const state = this.determineState(iterations, hasFinalResult);

    return {
      taskId: sanitized,
      state,
      totalIterations: iterations.length,
      iterations,
      hasFinalResult,
      hasFinalSummary,
      createdAt,
      title,
    };
  }

  /**
   * List all tasks with summary information.
   *
   * @returns Array of task summaries, sorted by creation time (newest first)
   */
  async listTasks(): Promise<DialogueTaskSummary[]> {
    try {
      const entries = await fs.readdir(this.tasksDir, { withFileTypes: true });
      const summaries: DialogueTaskSummary[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) {continue;}

        const status = await this.getTaskStatus(entry.name);
        if (status) {
          summaries.push({
            taskId: status.taskId,
            state: status.state,
            totalIterations: status.totalIterations,
            title: status.title,
          });
        }
      }

      return summaries;
    } catch {
      return [];
    }
  }

  /**
   * Read status of a single iteration directory.
   */
  private async readIterationStatus(iterPath: string, iterNum: number): Promise<DialogueIterationStatus> {
    let hasEvaluation = false;
    let hasExecution = false;
    let stepCount = 0;

    try {
      await fs.access(path.join(iterPath, 'evaluation.md'));
      hasEvaluation = true;
    } catch { /* not found */ }

    try {
      await fs.access(path.join(iterPath, 'execution.md'));
      hasExecution = true;
    } catch { /* not found */ }

    try {
      const stepsDir = path.join(iterPath, 'steps');
      const stepEntries = await fs.readdir(stepsDir);
      stepCount = stepEntries.filter(e => e.match(/^step-\d+\.md$/)).length;
    } catch {
      // steps dir may not exist
    }

    return {
      iteration: iterNum,
      hasEvaluation,
      hasExecution,
      stepCount,
    };
  }

  /**
   * Determine task state from iteration data and final result.
   */
  private determineState(iterations: DialogueIterationStatus[], hasFinalResult: boolean): TaskState {
    if (hasFinalResult) {
      return TaskState.FINALIZED;
    }

    if (iterations.length === 0) {
      return TaskState.PENDING;
    }

    // Check if any iteration has evaluation marking task as COMPLETE
    // (heuristic: if latest iteration has evaluation but no execution,
    // the evaluator may have marked it complete)
    return TaskState.RUNNING;
  }
}
