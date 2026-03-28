/**
 * TaskFileManager - Unified task file management system.
 *
 * This module provides a centralized interface for managing all task-related markdown files.
 * It implements the unified directory structure:
 *
 * {task_id}/
 *   ├── task.md
 *   ├── final_result.md (created by Pilot when task is COMPLETE)
 *   └── iterations/
 *       ├── iter-1/
 *       │   ├── evaluation.md (created by Pilot)
 *       │   └── execution.md (created by Pilot)
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
import type { TaskStatus, TaskStatusInfo } from './types.js';

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

  /**
   * Get comprehensive task status information.
   * Issue #857: Provides task state for Reporter Agent to make intelligent progress decisions.
   *
   * Status is determined by file existence:
   * - completed: final_result.md exists
   * - failed: failed.md exists
   * - running: running.lock exists
   * - pending: task.md exists but none of the above
   * - not_found: task directory doesn't exist
   *
   * @param taskId - Task identifier
   * @returns Task status information
   */
  async getTaskStatus(taskId: string): Promise<TaskStatusInfo> {
    const taskDir = this.getTaskDir(taskId);

    // Check if task directory exists
    const dirExists = await this.taskExists(taskId);
    if (!dirExists) {
      return {
        taskId,
        status: 'not_found',
        title: null,
        description: null,
        totalIterations: 0,
        latestIteration: 0,
        hasFinalResult: false,
        hasFinalSummary: false,
        createdAt: null,
        lastModified: null,
        elapsedSeconds: null,
        isRunning: false,
        taskDir,
      };
    }

    // Check status markers
    const finalResultPath = path.join(taskDir, 'final_result.md');
    const failedPath = path.join(taskDir, 'failed.md');
    const runningLockPath = path.join(taskDir, 'running.lock');
    const taskSpecPath = path.join(taskDir, 'task.md');

    let status: TaskStatus = 'pending';
    let hasFinalResult = false;
    let hasFailed = false;
    let isRunning = false;

    try {
      await fs.access(finalResultPath);
      hasFinalResult = true;
      status = 'completed';
    } catch {
      // final_result.md doesn't exist
    }

    if (!hasFinalResult) {
      try {
        await fs.access(failedPath);
        hasFailed = true;
        status = 'failed';
      } catch {
        // failed.md doesn't exist
      }
    }

    if (!hasFinalResult && !hasFailed) {
      try {
        await fs.access(runningLockPath);
        isRunning = true;
        status = 'running';
      } catch {
        // running.lock doesn't exist
      }
    }

    // Get task spec info
    let title: string | null = null;
    let description: string | null = null;
    let createdAt: string | null = null;

    try {
      const specContent = await fs.readFile(taskSpecPath, 'utf-8');
      // Extract title from first heading (# Title)
      const titleMatch = specContent.match(/^#\s+(.+)$/m);
      if (titleMatch) {
        title = titleMatch[1].trim();
      }
      // Extract description from first section after title
      const descMatch = specContent.match(/^##\s+Description\s*\n([\s\S]*?)(?=\n##\s|\n---|$)/im);
      if (descMatch) {
        description = descMatch[1].trim().substring(0, 500); // Limit description length
      }
      // Extract createdAt from frontmatter
      const createdMatch = specContent.match(/\*\*Created\*\*:\s*(.+)/);
      if (createdMatch) {
        createdAt = createdMatch[1].trim();
      }
    } catch {
      // task.md doesn't exist or can't be read
    }

    // Get file stats for timing
    let lastModified: string | null = null;
    let elapsedSeconds: number | null = null;
    try {
      const stats = await fs.stat(taskDir);
      lastModified = stats.mtime.toISOString();
      if (createdAt) {
        const createdTime = new Date(createdAt).getTime();
        const now = Date.now();
        if (!isNaN(createdTime)) {
          elapsedSeconds = Math.floor((now - createdTime) / 1000);
        }
      } else {
        // Fall back to directory creation time
        elapsedSeconds = Math.floor((Date.now() - stats.birthtime.getTime()) / 1000);
      }
    } catch {
      // Can't get stats
    }

    // Get iteration info
    const iterations = await this.listIterations(taskId);
    const stats = await this.getTaskStats(taskId);

    return {
      taskId,
      status,
      title,
      description,
      totalIterations: iterations.length,
      latestIteration: iterations.length > 0 ? iterations[iterations.length - 1] : 0,
      hasFinalResult,
      hasFinalSummary: stats.hasFinalSummary,
      createdAt,
      lastModified,
      elapsedSeconds,
      isRunning,
      taskDir,
    };
  }

  /**
   * List all task IDs in the tasks directory.
   * Issue #857: Used by Reporter Agent to discover active tasks.
   *
   * @returns Array of task IDs
   */
  async listAllTasks(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.tasksBaseDir, { withFileTypes: true });
      const taskIds: string[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Check if task.md exists
          const taskSpecPath = path.join(this.tasksBaseDir, entry.name, 'task.md');
          try {
            await fs.access(taskSpecPath);
            taskIds.push(entry.name);
          } catch {
            // No task.md, skip
          }
        }
      }

      return taskIds;
    } catch (error) {
      logger.error({ err: error }, 'Failed to list all tasks');
      return [];
    }
  }
}
