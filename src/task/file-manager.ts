/**
 * TaskFileManager - Unified task file management system.
 *
 * This module provides a centralized interface for managing all task-related markdown files.
 * It implements the unified directory structure:
 *
 * {task_id}/
 *   ├── task.md
 *   └── iterations/
 *       ├── iter-1/
 *       │   ├── evaluation.md
 *       │   └── steps/
 *       │       ├── step-1.md
 *       │       └── step-2.md
 *       ├── iter-2/
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

const logger = createLogger('TaskFileManager', {});

/**
 * Parsed Task.md metadata.
 */
export interface TaskMetadata {
  /** Task ID (messageId) */
  messageId: string;
  /** Chat ID */
  chatId: string;
  /** User ID (optional) */
  userId?: string;
  /** User's original request */
  userRequest: string;
}

/**
 * Task file manager for unified markdown file operations.
 */
export class TaskFileManager {
  private readonly workspaceDir: string;
  private readonly tasksBaseDir: string;

  constructor(workspaceDir?: string, private readonly subdirectory?: string) {
    this.workspaceDir = workspaceDir || Config.getWorkspaceDir();
    this.tasksBaseDir = this.subdirectory
      ? path.join(this.workspaceDir, 'tasks', this.subdirectory)
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
   * This file is created by the Executor when it successfully completes a task.
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
}

/**
 * Parse Task.md content to extract metadata.
 *
 * Extracts:
 * - Task ID (messageId)
 * - Chat ID
 * - User ID (optional)
 * - User's original request (from "## Original Request" section)
 *
 * @param taskMdContent - Full Task.md content
 * @returns Parsed task metadata
 */
export function parseTaskMd(taskMdContent: string): TaskMetadata {
  // Extract Task ID (messageId) from "**Task ID**: ..." or "**Task ID**: ..." line
  const taskIdMatch = taskMdContent.match(/\*?\*?Task ID\*?\*?:\s*([^\n]+)/i);
  const messageId = taskIdMatch ? taskIdMatch[1].trim() : '';

  // Extract Chat ID from "**Chat ID**: ..." line
  const chatIdMatch = taskMdContent.match(/\*?\*?Chat ID\*?\*?:\s*([^\n]+)/i);
  const chatId = chatIdMatch ? chatIdMatch[1].trim() : '';

  // Extract User ID from "**User ID**: ..." line (optional)
  const userIdMatch = taskMdContent.match(/\*?\*?User ID\*?\*?:\s*([^\n]+)/i);
  const userId = userIdMatch ? userIdMatch[1].trim() : undefined;

  // Extract Original Request from "## Original Request" section
  // The request is in a code block after this section
  const originalRequestSectionMatch = taskMdContent.match(/##\s*Original\s*Request\s*\n([\s\S]*?)(?=##|\Z)/);
  let userRequest = '';

  if (originalRequestSectionMatch && originalRequestSectionMatch[1]) {
    // Extract content from code block (``` or ~~~)
    const codeBlockMatch = originalRequestSectionMatch[1].match(/```[\s\S]*?\n([\s\S]*?)```|~~~[\s\S]*?\n([\s\S]*?)~~~/);
    if (codeBlockMatch) {
      userRequest = (codeBlockMatch[1] || codeBlockMatch[2] || '').trim();
    } else {
      // Fallback: use the entire section content without leading/trailing whitespace
      userRequest = originalRequestSectionMatch[1].trim();
    }
  }

  return {
    messageId,
    chatId,
    userId,
    userRequest,
  };
}
