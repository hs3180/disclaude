/**
 * TaskFileManager - Unified task file management system.
 *
 * This module provides a centralized interface for managing all task-related markdown files.
 * It implements the unified directory structure:
 *
 * {task_id}/
 *   ├── task.md
 *   ├── status.md (tracks task execution status)
 *   ├── error.md (created when task fails)
 *   ├── final_result.md (created by Evaluator when task is COMPLETE)
 *   └── iterations/
 *       ├── iter-1/
 *       │   ├── evaluation.md (created by Evaluator)
 *       │   └── execution.md (created by Executor)
 *       ├── iter-2/
 *       │   ├── evaluation.md
 *       │   └── execution.md
 *       └── final-summary.md
 *
 * Design Principles:
 * - Markdown as Data: Use markdown files to pass key results between agents
 * - Human-Readable: All intermediate results are readable by both humans and machines
 * - Traceable: Complete execution history preserved in markdown
 * - Unified: Single file structure for all task modes
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

/**
 * Task execution status.
 */
export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'timeout';

/**
 * Task status information.
 */
export interface TaskStatusInfo {
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  error?: string;
  retryCount?: number;
}

const logger = createLogger('TaskFileManager', {});

/**
 * Task file manager for unified markdown file operations.
 */
export class TaskFileManager {
  private readonly workspaceDir: string;
  private readonly tasksBaseDir: string;

  constructor(workspaceDir?: string, private readonly subdirectory?: string, tasksBaseDir?: string) {
    // If tasksBaseDir is provided directly, use it; otherwise derive from workspaceDir
    if (tasksBaseDir) {
      this.tasksBaseDir = tasksBaseDir;
      this.workspaceDir = workspaceDir || path.dirname(tasksBaseDir);
    } else {
      this.workspaceDir = workspaceDir || Config.getWorkspaceDir();
      this.tasksBaseDir = this.subdirectory
        ? path.join(this.workspaceDir, 'tasks', this.subdirectory)
        : path.join(this.workspaceDir, 'tasks');
    }
  }

  /**
   * Ensure the base tasks directory exists.
   */
  private async ensureBaseDir(): Promise<void> {
    try {
      await fs.mkdir(this.tasksBaseDir, { recursive: true });
    } catch (error) {
      logger.error({ err: error }, 'Failed to create base tasks directory');
      throw error;
    }
  }

  /**
   * Get the task directory path for a given task ID.
   *
   * @param taskId - Task identifier (typically messageId)
   * @returns Absolute path to task directory
   */
  getTaskDir(taskId: string): string {
    // Sanitize taskId to make it a valid directory name
    const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.tasksBaseDir, sanitized);
  }

  /**
   * Get task.md file path for a given task ID.
   *
   * @param taskId - Task identifier
   * @returns Absolute path to task.md file
   */
  getTaskSpecPath(taskId: string): string {
    return path.join(this.getTaskDir(taskId), 'task.md');
  }

  /**
   * Get the iterations directory path for a given task.
   *
   * @param taskId - Task identifier
   * @returns Absolute path to iterations directory
   */
  getIterationsDir(taskId: string): string {
    return path.join(this.getTaskDir(taskId), 'iterations');
  }

  /**
   * Get the iteration directory path for a specific iteration.
   *
   * @param taskId - Task identifier
   * @param iteration - Iteration number (1-indexed)
   * @returns Absolute path to iteration directory
   */
  getIterationDir(taskId: string, iteration: number): string {
    return path.join(this.getIterationsDir(taskId), `iter-${iteration}`);
  }

  /**
   * Get the steps directory path for a specific iteration.
   *
   * @param taskId - Task identifier
   * @param iteration - Iteration number
   * @returns Absolute path to steps directory
   */
  getStepsDir(taskId: string, iteration: number): string {
    return path.join(this.getIterationDir(taskId, iteration), 'steps');
  }

  /**
   * Initialize task directory structure.
   *
   * Creates:
   * - tasks/{task_id}/
   * - tasks/{task_id}/iterations/
   *
   * @param taskId - Task identifier
   */
  async initializeTask(taskId: string): Promise<void> {
    await this.ensureBaseDir();

    const taskDir = this.getTaskDir(taskId);
    const iterationsDir = this.getIterationsDir(taskId);

    try {
      await fs.mkdir(iterationsDir, { recursive: true });
      logger.debug({ taskId, taskDir }, 'Task directory initialized');
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to initialize task directory');
      throw error;
    }
  }

  /**
   * Write task.md (task specification file).
   *
   * @param taskId - Task identifier
   * @param content - Markdown content for task.md
   */
  async writeTaskSpec(taskId: string, content: string): Promise<void> {
    const taskDir = this.getTaskDir(taskId);
    const taskSpecPath = path.join(taskDir, 'task.md');

    try {
      await fs.writeFile(taskSpecPath, content, 'utf-8');
      logger.debug({ taskId, path: taskSpecPath }, 'Task spec written');
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to write task spec');
      throw error;
    }
  }

  /**
   * Read task.md content.
   *
   * @param taskId - Task identifier
   * @returns Content of task.md
   */
  async readTaskSpec(taskId: string): Promise<string> {
    const taskSpecPath = path.join(this.getTaskDir(taskId), 'task.md');

    try {
      const content = await fs.readFile(taskSpecPath, 'utf-8');
      return content;
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to read task spec');
      throw error;
    }
  }

  /**
   * Create iteration directory structure.
   *
   * Creates:
   * - tasks/{task_id}/iterations/iter-{N}/
   * - tasks/{task_id}/iterations/iter-{N}/steps/
   *
   * @param taskId - Task identifier
   * @param iteration - Iteration number (1-indexed)
   */
  async createIteration(taskId: string, iteration: number): Promise<void> {
    const iterationDir = this.getIterationDir(taskId, iteration);
    const stepsDir = this.getStepsDir(taskId, iteration);

    try {
      await fs.mkdir(stepsDir, { recursive: true });
      logger.debug({ taskId, iteration, iterationDir }, 'Iteration directory created');
    } catch (error) {
      logger.error({ err: error, taskId, iteration }, 'Failed to create iteration directory');
      throw error;
    }
  }

  /**
   * Write evaluation.md for an iteration.
   *
   * @param taskId - Task identifier
   * @param iteration - Iteration number
   * @param content - Markdown content for evaluation.md
   */
  async writeEvaluation(taskId: string, iteration: number, content: string): Promise<void> {
    const evaluationPath = path.join(this.getIterationDir(taskId, iteration), 'evaluation.md');

    try {
      await fs.writeFile(evaluationPath, content, 'utf-8');
      logger.debug({ taskId, iteration }, 'Evaluation written');
    } catch (error) {
      logger.error({ err: error, taskId, iteration }, 'Failed to write evaluation');
      throw error;
    }
  }

  /**
   * Read evaluation.md content.
   *
   * @param taskId - Task identifier
   * @param iteration - Iteration number
   * @returns Content of evaluation.md
   */
  async readEvaluation(taskId: string, iteration: number): Promise<string> {
    const evaluationPath = path.join(this.getIterationDir(taskId, iteration), 'evaluation.md');

    try {
      const content = await fs.readFile(evaluationPath, 'utf-8');
      return content;
    } catch (error) {
      logger.error({ err: error, taskId, iteration }, 'Failed to read evaluation');
      throw error;
    }
  }

  /**
   * Get evaluation.md file path for a given task and iteration.
   *
   * @param taskId - Task identifier
   * @param iteration - Iteration number
   * @returns Absolute path to evaluation.md file
   */
  getEvaluationPath(taskId: string, iteration: number): string {
    return path.join(this.getIterationDir(taskId, iteration), 'evaluation.md');
  }

  /**
   * Check if evaluation.md exists for an iteration.
   *
   * @param taskId - Task identifier
   * @param iteration - Iteration number
   * @returns True if evaluation.md exists
   */
  async hasEvaluation(taskId: string, iteration: number): Promise<boolean> {
    const evaluationPath = this.getEvaluationPath(taskId, iteration);

    try {
      await fs.access(evaluationPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write execution.md for an iteration.
   *
   * @param taskId - Task identifier
   * @param iteration - Iteration number
   * @param content - Markdown content for execution.md
   */
  async writeExecution(taskId: string, iteration: number, content: string): Promise<void> {
    const executionPath = this.getExecutionPath(taskId, iteration);

    try {
      await fs.writeFile(executionPath, content, 'utf-8');
      logger.debug({ taskId, iteration }, 'Execution written');
    } catch (error) {
      logger.error({ err: error, taskId, iteration }, 'Failed to write execution');
      throw error;
    }
  }

  /**
   * Read execution.md content.
   *
   * @param taskId - Task identifier
   * @param iteration - Iteration number
   * @returns Content of execution.md
   */
  async readExecution(taskId: string, iteration: number): Promise<string> {
    const executionPath = this.getExecutionPath(taskId, iteration);

    try {
      const content = await fs.readFile(executionPath, 'utf-8');
      return content;
    } catch (error) {
      logger.error({ err: error, taskId, iteration }, 'Failed to read execution');
      throw error;
    }
  }

  /**
   * Get execution.md file path for a given task and iteration.
   *
   * @param taskId - Task identifier
   * @param iteration - Iteration number
   * @returns Absolute path to execution.md file
   */
  getExecutionPath(taskId: string, iteration: number): string {
    return path.join(this.getIterationDir(taskId, iteration), 'execution.md');
  }

  /**
   * Check if execution.md exists for an iteration.
   *
   * @param taskId - Task identifier
   * @param iteration - Iteration number
   * @returns True if execution.md exists
   */
  async hasExecution(taskId: string, iteration: number): Promise<boolean> {
    const executionPath = this.getExecutionPath(taskId, iteration);

    try {
      await fs.access(executionPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write step result markdown file.
   *
   * Creates: tasks/{task_id}/iterations/iter-{N}/steps/step-{M}.md
   *
   * @param taskId - Task identifier
   * @param iteration - Iteration number
   * @param step - Step number (1-indexed)
   * @param content - Markdown content for step result
   */
  async writeStepResult(taskId: string, iteration: number, step: number, content: string): Promise<void> {
    const stepResultPath = path.join(this.getStepsDir(taskId, iteration), `step-${step}.md`);

    try {
      await fs.writeFile(stepResultPath, content, 'utf-8');
      logger.debug({ taskId, iteration, step }, 'Step result written');
    } catch (error) {
      logger.error({ err: error, taskId, iteration, step }, 'Failed to write step result');
      throw error;
    }
  }

  /**
   * Write final summary for the task.
   *
   * Creates: tasks/{task_id}/iterations/final-summary.md
   *
   * @param taskId - Task identifier
   * @param content - Markdown content for final summary
   */
  async writeFinalSummary(taskId: string, content: string): Promise<void> {
    const summaryPath = path.join(this.getIterationsDir(taskId), 'final-summary.md');

    try {
      await fs.writeFile(summaryPath, content, 'utf-8');
      logger.info({ taskId, summaryPath }, 'Final summary written');
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to write final summary');
      throw error;
    }
  }

  /**
   * Check if task directory exists.
   *
   * @param taskId - Task identifier
   * @returns True if task directory exists
   */
  async taskExists(taskId: string): Promise<boolean> {
    const taskDir = this.getTaskDir(taskId);

    try {
      await fs.access(taskDir);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all iterations for a task.
   *
   * @param taskId - Task identifier
   * @returns Array of iteration numbers
   */
  async listIterations(taskId: string): Promise<number[]> {
    const iterationsDir = this.getIterationsDir(taskId);

    try {
      const entries = await fs.readdir(iterationsDir, { withFileTypes: true });
      const iterations: number[] = [];

      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('iter-')) {
          const match = entry.name.match(/^iter-(\d+)$/);
          if (match) {
            iterations.push(parseInt(match[1], 10));
          }
        }
      }

      return iterations.sort((a, b) => a - b);
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to list iterations');
      return [];
    }
  }

  /**
   * Get task statistics.
   *
   * @param taskId - Task identifier
   * @returns Task statistics
   */
  async getTaskStats(taskId: string): Promise<{
    totalIterations: number;
    hasFinalSummary: boolean;
  }> {
    const iterations = await this.listIterations(taskId);
    const iterationsDir = this.getIterationsDir(taskId);

    let hasFinalSummary = false;
    try {
      await fs.access(path.join(iterationsDir, 'final-summary.md'));
      hasFinalSummary = true;
    } catch {
      // File doesn't exist
    }

    return {
      totalIterations: iterations.length,
      hasFinalSummary,
    };
  }

  /**
   * Clean up a task directory (use with caution).
   *
   * @param taskId - Task identifier
   */
  async cleanupTask(taskId: string): Promise<void> {
    const taskDir = this.getTaskDir(taskId);

    try {
      await fs.rm(taskDir, { recursive: true, force: true });
      logger.info({ taskId }, 'Task directory cleaned up');
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to cleanup task directory');
      throw error;
    }
  }

  /**
   * Check if final_result.md exists in the task directory.
   *
   * This file is created by the Evaluator when it determines the task is COMPLETE.
   * Its presence indicates that the task is complete.
   *
   * @param taskId - Task identifier
   * @returns True if final_result.md exists
   */
  async hasFinalResult(taskId: string): Promise<boolean> {
    const finalResultPath = path.join(this.getTaskDir(taskId), 'final_result.md');

    try {
      await fs.access(finalResultPath);
      logger.debug({ taskId, finalResultPath }, 'Final result detected');
      return true;
    } catch {
      logger.debug({ taskId }, 'Final result not detected');
      return false;
    }
  }

  /**
   * Get the path to final_result.md for a task.
   *
   * @param taskId - Task identifier
   * @returns Absolute path to final_result.md
   */
  getFinalResultPath(taskId: string): string {
    return path.join(this.getTaskDir(taskId), 'final_result.md');
  }

  // ===== Task Status Management =====

  /**
   * Get the path to status.md for a task.
   *
   * @param taskId - Task identifier
   * @returns Absolute path to status.md
   */
  getStatusPath(taskId: string): string {
    return path.join(this.getTaskDir(taskId), 'status.md');
  }

  /**
   * Get the path to error.md for a task.
   *
   * @param taskId - Task identifier
   * @returns Absolute path to error.md
   */
  getErrorPath(taskId: string): string {
    return path.join(this.getTaskDir(taskId), 'error.md');
  }

  /**
   * Initialize task status to 'pending'.
   *
   * @param taskId - Task identifier
   */
  async initializeStatus(taskId: string): Promise<void> {
    const statusPath = this.getStatusPath(taskId);
    const now = new Date().toISOString();

    const content = `# Task Status

**Task ID**: ${taskId}
**Status**: pending
**Created**: ${now}
**Updated**: ${now}
`;

    try {
      await fs.writeFile(statusPath, content, 'utf-8');
      logger.debug({ taskId, statusPath }, 'Task status initialized to pending');
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to initialize task status');
      throw error;
    }
  }

  /**
   * Update task status.
   *
   * @param taskId - Task identifier
   * @param status - New status
   * @param error - Optional error message (for failed status)
   */
  async updateStatus(taskId: string, status: TaskStatus, error?: string): Promise<void> {
    const statusPath = this.getStatusPath(taskId);

    try {
      // Read existing status or create new one
      let existingContent = '';
      try {
        existingContent = await fs.readFile(statusPath, 'utf-8');
      } catch {
        // File doesn't exist, will create new
      }

      const now = new Date().toISOString();
      const createdAt = this.extractField(existingContent, 'Created') || now;
      const startedAt = status === 'processing' ? now : this.extractField(existingContent, 'Started');
      const completedAt = ['completed', 'failed', 'timeout'].includes(status) ? now : undefined;
      const retryCount = this.extractField(existingContent, 'Retry Count');
      const retryNum = retryCount ? parseInt(retryCount, 10) : 0;

      const content = `# Task Status

**Task ID**: ${taskId}
**Status**: ${status}
**Created**: ${createdAt}
${startedAt ? `**Started**: ${startedAt}` : ''}
${completedAt ? `**Completed**: ${completedAt}` : ''}
**Updated**: ${now}
${retryNum > 0 ? `**Retry Count**: ${retryNum}` : ''}
${error ? `\n## Error\n\n\`\`\`\n${error}\n\`\`\`\n` : ''}
`;

      await fs.writeFile(statusPath, content, 'utf-8');
      logger.info({ taskId, status, error: !!error }, 'Task status updated');
    } catch (err) {
      logger.error({ err, taskId }, 'Failed to update task status');
      throw err;
    }
  }

  /**
   * Read task status.
   *
   * @param taskId - Task identifier
   * @returns Task status info or null if not found
   */
  async readStatus(taskId: string): Promise<TaskStatusInfo | null> {
    const statusPath = this.getStatusPath(taskId);

    try {
      const content = await fs.readFile(statusPath, 'utf-8');

      return {
        status: (this.extractField(content, 'Status') as TaskStatus) || 'pending',
        createdAt: this.extractField(content, 'Created') || '',
        startedAt: this.extractField(content, 'Started'),
        completedAt: this.extractField(content, 'Completed'),
        updatedAt: this.extractField(content, 'Updated') || '',
        error: this.extractErrorSection(content),
        retryCount: this.extractField(content, 'Retry Count')
          ? parseInt(this.extractField(content, 'Retry Count')!, 10)
          : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Check if task has status.md file.
   *
   * @param taskId - Task identifier
   * @returns True if status.md exists
   */
  async hasStatus(taskId: string): Promise<boolean> {
    const statusPath = this.getStatusPath(taskId);
    try {
      await fs.access(statusPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Increment retry count for a task.
   *
   * @param taskId - Task identifier
   * @returns New retry count
   */
  async incrementRetryCount(taskId: string): Promise<number> {
    const statusPath = this.getStatusPath(taskId);

    try {
      const content = await fs.readFile(statusPath, 'utf-8');
      const currentCount = this.extractField(content, 'Retry Count');
      const newCount = currentCount ? parseInt(currentCount, 10) + 1 : 1;

      // Update the retry count in the content
      let updatedContent = content;
      if (content.includes('**Retry Count**:')) {
        updatedContent = content.replace(
          /\*\*Retry Count\*\*: \d+/,
          `**Retry Count**: ${newCount}`
        );
      } else {
        // Add retry count after Updated line
        updatedContent = content.replace(
          /(\*\*Updated\*\*: [^\n]+)/,
          `$1\n**Retry Count**: ${newCount}`
        );
      }

      await fs.writeFile(statusPath, updatedContent, 'utf-8');
      logger.info({ taskId, retryCount: newCount }, 'Task retry count incremented');
      return newCount;
    } catch (err) {
      logger.error({ err, taskId }, 'Failed to increment retry count');
      throw err;
    }
  }

  /**
   * Write error.md file for a failed task.
   *
   * @param taskId - Task identifier
   * @param error - Error message
   * @param stack - Optional stack trace
   */
  async writeError(taskId: string, error: string, stack?: string): Promise<void> {
    const errorPath = this.getErrorPath(taskId);
    const now = new Date().toISOString();

    const content = `# Task Error

**Task ID**: ${taskId}
**Failed At**: ${now}

## Error Message

\`\`\`
${error}
\`\`\`
${stack ? `
## Stack Trace

\`\`\`
${stack}
\`\`\`
` : ''}
`;

    try {
      await fs.writeFile(errorPath, content, 'utf-8');
      logger.info({ taskId, errorPath }, 'Task error written');
    } catch (err) {
      logger.error({ err, taskId }, 'Failed to write task error');
      throw err;
    }
  }

  /**
   * Check if task has error.md file.
   *
   * @param taskId - Task identifier
   * @returns True if error.md exists
   */
  async hasError(taskId: string): Promise<boolean> {
    const errorPath = this.getErrorPath(taskId);
    try {
      await fs.access(errorPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Find tasks that have been stuck in 'processing' status for too long.
   *
   * @param timeoutMs - Timeout in milliseconds (default: 30 minutes)
   * @returns Array of stuck task IDs
   */
  async findStuckTasks(timeoutMs = 30 * 60 * 1000): Promise<string[]> {
    const stuckTasks: string[] = [];
    const now = Date.now();

    try {
      const entries = await fs.readdir(this.tasksBaseDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const taskId = entry.name;
        const status = await this.readStatus(taskId);

        if (status?.status === 'processing' && status.startedAt) {
          const startedTime = new Date(status.startedAt).getTime();
          if (now - startedTime > timeoutMs) {
            stuckTasks.push(taskId);
            logger.warn(
              { taskId, startedAt: status.startedAt, elapsedMs: now - startedTime },
              'Found stuck task'
            );
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Failed to find stuck tasks');
    }

    return stuckTasks;
  }

  /**
   * Find tasks with task.md but no status.md (uninitialized).
   *
   * @returns Array of uninitialized task IDs
   */
  async findUninitializedTasks(): Promise<string[]> {
    const uninitialized: string[] = [];

    try {
      const entries = await fs.readdir(this.tasksBaseDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const taskId = entry.name;
        const taskSpecPath = this.getTaskSpecPath(taskId);
        const hasStatus = await this.hasStatus(taskId);

        // Check if task.md exists but status.md doesn't
        try {
          await fs.access(taskSpecPath);
          if (!hasStatus) {
            uninitialized.push(taskId);
          }
        } catch {
          // task.md doesn't exist, skip
        }
      }
    } catch (err) {
      logger.error({ err }, 'Failed to find uninitialized tasks');
    }

    return uninitialized;
  }

  /**
   * Extract a field value from status.md content.
   */
  private extractField(content: string, fieldName: string): string | undefined {
    const match = content.match(new RegExp(`\\*\\*${fieldName}\\*\\*: ([^\\n]+)`));
    return match?.[1]?.trim();
  }

  /**
   * Extract error section from status.md content.
   */
  private extractErrorSection(content: string): string | undefined {
    const match = content.match(/## Error\s+```[\s\S]*?```/);
    if (match) {
      const codeBlock = match[0].match(/```[\s\S]*?```/);
      if (codeBlock) {
        return codeBlock[0].replace(/```\n?/g, '').trim();
      }
    }
    return undefined;
  }
}
