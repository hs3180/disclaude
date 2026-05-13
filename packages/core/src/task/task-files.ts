/**
 * TaskFileManager - Unified task file management system.
 *
 * This module provides a centralized interface for managing all task-related markdown files.
 * It implements the unified directory structure:
 *
 * {task_id}/
 *   ├── task.md
 *   ├── final_result.md (created by ChatAgent when task is COMPLETE)
 *   └── iterations/
 *       ├── iter-1/
 *       │   ├── evaluation.md (created by ChatAgent)
 *       │   └── execution.md (created by ChatAgent)
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
 *
 * @module task/task-files
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { TaskFileStatus, TaskProgressStatus } from './types.js';

const logger = createLogger('TaskFileManager');

/**
 * Task file manager configuration.
 */
export interface TaskFileManagerConfig {
  /** Workspace directory for task files */
  workspaceDir: string;
  /** Optional subdirectory for task files */
  subdirectory?: string;
}

/**
 * Task file manager for unified markdown file operations.
 */
export class TaskFileManager {
  private readonly workspaceDir: string;
  private readonly tasksBaseDir: string;

  /**
   * Create a TaskFileManager.
   *
   * @param config - Configuration with workspaceDir and optional subdirectory
   */
  constructor(config: TaskFileManagerConfig) {
    this.workspaceDir = config.workspaceDir;
    this.tasksBaseDir = config.subdirectory
      ? path.join(this.workspaceDir, 'tasks', config.subdirectory)
      : path.join(this.workspaceDir, 'tasks');
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

  // ===== Lock & Status File Management =====

  /**
   * Create running.lock to mark task as executing.
   *
   * @param taskId - Task identifier
   */
  async setRunning(taskId: string): Promise<void> {
    const lockPath = path.join(this.getTaskDir(taskId), 'running.lock');
    try {
      await fs.writeFile(lockPath, new Date().toISOString(), 'utf-8');
      logger.debug({ taskId }, 'Running lock set');
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to set running lock');
      throw error;
    }
  }

  /**
   * Remove running.lock to mark task as no longer executing.
   *
   * @param taskId - Task identifier
   */
  async clearRunning(taskId: string): Promise<void> {
    const lockPath = path.join(this.getTaskDir(taskId), 'running.lock');
    try {
      await fs.unlink(lockPath);
      logger.debug({ taskId }, 'Running lock cleared');
    } catch (error) {
      // File might not exist, that's OK
      logger.debug({ taskId }, 'Running lock already cleared or missing');
    }
  }

  /**
   * Check if running.lock exists.
   *
   * @param taskId - Task identifier
   * @returns True if task is currently running
   */
  async isRunning(taskId: string): Promise<boolean> {
    const lockPath = path.join(this.getTaskDir(taskId), 'running.lock');
    try {
      await fs.access(lockPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create failed.md to mark task as failed.
   *
   * @param taskId - Task identifier
   * @param reason - Failure reason
   */
  async setFailed(taskId: string, reason: string): Promise<void> {
    const failedPath = path.join(this.getTaskDir(taskId), 'failed.md');
    try {
      await fs.writeFile(failedPath, `# Task Failed\n\n**Reason**: ${reason}\n**Time**: ${new Date().toISOString()}\n`, 'utf-8');
      logger.info({ taskId }, 'Task marked as failed');
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to write failed.md');
      throw error;
    }
  }

  /**
   * Check if failed.md exists.
   *
   * @param taskId - Task identifier
   * @returns True if task has failed
   */
  async isFailed(taskId: string): Promise<boolean> {
    const failedPath = path.join(this.getTaskDir(taskId), 'failed.md');
    try {
      await fs.access(failedPath);
      return true;
    } catch {
      return false;
    }
  }

  // ===== Progress Status =====

  /**
   * Get the derived file-based status of a task.
   *
   * @param taskId - Task identifier
   * @returns Task file status
   */
  async getTaskFileStatus(taskId: string): Promise<TaskFileStatus> {
    const taskDir = this.getTaskDir(taskId);
    try {
      await fs.access(taskDir);
    } catch {
      return 'unknown';
    }

    // Check in priority order
    if (await this.hasFinalResult(taskId)) return 'completed';
    if (await this.isFailed(taskId)) return 'failed';
    if (await this.isRunning(taskId)) return 'running';

    // Check if task.md exists
    try {
      await fs.access(this.getTaskSpecPath(taskId));
      return 'pending';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Get full progress status for a task.
   *
   * Reads task.md, iterations, and status files to produce
   * a structured progress report.
   *
   * @param taskId - Task identifier
   * @returns Structured progress status
   */
  async getProgressStatus(taskId: string): Promise<TaskProgressStatus> {
    const status = await this.getTaskFileStatus(taskId);
    const iterations = await this.listIterations(taskId);
    const isRunning = status === 'running';

    // Extract title and chatId from task.md
    let title = taskId;
    let chatId: string | null = null;
    try {
      const spec = await this.readTaskSpec(taskId);
      // Extract title from "# Task: ..." line
      const titleMatch = spec.match(/^#\s+Task:\s+(.+)$/m);
      if (titleMatch) title = titleMatch[1].trim();
      // Extract chatId from "**Chat ID**: ..." or "**Chat**: ..." line
      const chatMatch = spec.match(/\*\*(?:Chat ID|Chat)\*\*:\s*(\S+)/);
      if (chatMatch) chatId = chatMatch[1].trim();
    } catch {
      // task.md might not exist
    }

    // Get latest execution summary
    let latestExecutionSummary: string | null = null;
    if (iterations.length > 0) {
      const lastIter = iterations[iterations.length - 1];
      try {
        const execution = await this.readExecution(taskId, lastIter);
        // Extract summary from execution.md
        const summaryMatch = execution.match(/^##\s+Summary\s*\n([\s\S]*?)(?=\n##|\Z)/m);
        if (summaryMatch) {
          latestExecutionSummary = summaryMatch[1].trim();
        } else {
          // Fallback: first non-heading line
          const lines = execution.split('\n').filter(l => l.trim() && !l.startsWith('#'));
          if (lines.length > 0) latestExecutionSummary = lines[0].trim();
        }
      } catch {
        // execution.md might not exist
      }
    }

    return {
      taskId,
      status,
      title,
      chatId,
      currentIteration: iterations.length,
      hasFinalResult: status === 'completed',
      isRunning,
      latestExecutionSummary,
    };
  }

  /**
   * List all task IDs that have a task.md file (active tasks).
   *
   * @returns Array of task IDs with task.md present
   */
  async listActiveTasks(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.tasksBaseDir, { withFileTypes: true });
      const taskIds: string[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const taskMdPath = path.join(this.tasksBaseDir, entry.name, 'task.md');
          try {
            await fs.access(taskMdPath);
            taskIds.push(entry.name);
          } catch {
            // No task.md, skip
          }
        }
      }

      return taskIds;
    } catch (error) {
      logger.error({ err: error }, 'Failed to list active tasks');
      return [];
    }
  }

  /**
   * List task IDs that are currently in a given status.
   *
   * @param status - Status to filter by
   * @returns Array of task IDs matching the status
   */
  async listTasksByStatus(status: TaskFileStatus): Promise<string[]> {
    const allTasks = await this.listActiveTasks();
    const result: string[] = [];

    for (const taskId of allTasks) {
      const taskStatus = await this.getTaskFileStatus(taskId);
      if (taskStatus === status) {
        result.push(taskId);
      }
    }

    return result;
  }
}
