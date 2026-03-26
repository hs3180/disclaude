/**
 * Task Status Reader - Computes task status from existing task files.
 *
 * This module provides a read-only interface for determining the current
 * status of a task by analyzing its file structure. It does not modify
 * any files — it only reads and infers state from:
 *
 * - task.md: Title, description, chat ID, creation time
 * - iterations/: Iteration count and current iteration
 * - iterations/iter-{N}/evaluation.md: Latest evaluation summary
 * - iterations/iter-{N}/execution.md: Latest execution summary
 * - final_result.md: Task completion marker
 * - iterations/final-summary.md: Final summary marker
 *
 * Issue #857: This provides the task context that the Reporter Agent
 * (task-progress skill) uses to intelligently decide when and what
 * to report to the user.
 *
 * @module task/task-status
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { TaskFileManager } from './task-files.js';
import type { TaskStatusInfo, TaskExecutionStatus } from './types.js';

const logger = createLogger('TaskStatusReader');

/** Maximum characters to include in evaluation/execution summaries */
const SUMMARY_MAX_LENGTH = 500;

/**
 * Task Status Reader configuration.
 */
export interface TaskStatusReaderConfig {
  /** Workspace directory for task files */
  workspaceDir: string;
  /** Optional subdirectory for task files */
  subdirectory?: string;
}

/**
 * Reads and computes task status from existing task files.
 *
 * This class is stateless and read-only — it analyzes the file system
 * on each call to get the most up-to-date task state.
 *
 * @example
 * ```typescript
 * const reader = new TaskStatusReader({ workspaceDir: '/workspace' });
 * const status = await reader.getTaskStatus('msg_123');
 * console.log(status.status); // 'iterating'
 * console.log(status.currentIteration); // 2
 * ```
 */
export class TaskStatusReader {
  private readonly fileManager: TaskFileManager;

  constructor(config: TaskStatusReaderConfig) {
    this.fileManager = new TaskFileManager(config);
  }

  /**
   * Get the current status of a task.
   *
   * @param taskId - Task identifier (typically messageId)
   * @returns Structured task status information
   */
  async getTaskStatus(taskId: string): Promise<TaskStatusInfo> {
    const defaultStatus: TaskStatusInfo = {
      taskId,
      status: 'unknown',
      title: 'Unknown Task',
      description: '',
      chatId: '',
      currentIteration: 0,
      totalIterations: 0,
      hasFinalResult: false,
      hasFinalSummary: false,
      createdAt: '',
      updatedAt: '',
      latestEvaluationSummary: '',
      latestExecutionSummary: '',
    };

    try {
      // Check if task directory exists
      const taskExists = await this.fileManager.taskExists(taskId);
      if (!taskExists) {
        logger.debug({ taskId }, 'Task directory not found');
        return defaultStatus;
      }

      // Read task.md for metadata
      const taskSpec = await this.readTaskSpec(taskId);

      // Check for completion markers
      const hasFinalResult = await this.fileManager.hasFinalResult(taskId);
      const stats = await this.fileManager.getTaskStats(taskId);

      // List iterations
      const iterations = await this.fileManager.listIterations(taskId);
      const latestIteration = iterations.length > 0 ? iterations[iterations.length - 1] : 0;

      // Read latest evaluation and execution summaries
      const latestEvaluationSummary = latestIteration > 0
        ? await this.readLatestEvaluation(taskId, latestIteration)
        : '';
      const latestExecutionSummary = latestIteration > 0
        ? await this.readLatestExecution(taskId, latestIteration)
        : '';

      // Determine status
      const status = this.deriveStatus(hasFinalResult, latestEvaluationSummary, iterations.length);

      // Get directory modification time as updatedAt
      const updatedAt = await this.getDirectoryMtime(taskId);

      return {
        taskId,
        status,
        title: taskSpec.title,
        description: taskSpec.description,
        chatId: taskSpec.chatId,
        currentIteration: latestIteration,
        totalIterations: iterations.length,
        hasFinalResult,
        hasFinalSummary: stats.hasFinalSummary,
        createdAt: taskSpec.createdAt,
        updatedAt,
        latestEvaluationSummary,
        latestExecutionSummary,
      };
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to read task status');
      return defaultStatus;
    }
  }

  /**
   * List all task IDs in the workspace.
   *
   * @returns Array of task IDs
   */
  async listTaskIds(): Promise<string[]> {
    try {
      const tasksDir = path.join(
        this.fileManager['tasksBaseDir'] // Access private field for directory listing
      );
      const entries = await fs.readdir(tasksDir, { withFileTypes: true });
      return entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch (error) {
      logger.error({ err: error }, 'Failed to list task IDs');
      return [];
    }
  }

  /**
   * Read and parse task.md metadata.
   */
  private async readTaskSpec(taskId: string): Promise<{
    title: string;
    description: string;
    chatId: string;
    createdAt: string;
  }> {
    try {
      const content = await this.fileManager.readTaskSpec(taskId);
      return this.parseTaskSpec(content);
    } catch {
      logger.debug({ taskId }, 'task.md not found or unreadable');
      return { title: 'Untitled Task', description: '', chatId: '', createdAt: '' };
    }
  }

  /**
   * Parse task.md content to extract metadata.
   */
  private parseTaskSpec(content: string): {
    title: string;
    description: string;
    chatId: string;
    createdAt: string;
  } {
    let title = 'Untitled Task';
    let description = '';
    let chatId = '';
    let createdAt = '';

    // Extract title from first # heading
    const titleMatch = content.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      title = titleMatch[1].replace(/^Task:\s*/, '').trim();
    }

    // Extract metadata fields
    const taskIdMatch = content.match(/\*\*Task ID\*\*:\s*(.+)/);
    const chatIdMatch = content.match(/\*\*(?:Chat(?:\s*ID)?|Chat)\*\*:\s*(.+)/i);
    const createdMatch = content.match(/\*\*Created\*\*:\s*(.+)/);

    if (taskIdMatch) {
      // taskIdMatch is captured but not used (already have taskId from parameter)
    }
    if (chatIdMatch) {
      chatId = chatIdMatch[1].trim();
    }
    if (createdMatch) {
      createdAt = createdMatch[1].trim();
    }

    // Extract description (content between "## Description" or "## Original Request" and next ## or end of file)
    const descMatch = content.match(/##\s+(?:Description|Original Request)\s*\n([\s\S]*?)(?=\n##\s|\n---|\n\*\*|$)/);
    if (descMatch) {
      description = descMatch[1].trim().substring(0, SUMMARY_MAX_LENGTH);
    }

    return { title, description, chatId, createdAt };
  }

  /**
   * Read the latest evaluation summary.
   */
  private async readLatestEvaluation(taskId: string, iteration: number): Promise<string> {
    try {
      const content = await this.fileManager.readEvaluation(taskId, iteration);
      return this.summarizeContent(content);
    } catch {
      return '';
    }
  }

  /**
   * Read the latest execution summary.
   */
  private async readLatestExecution(taskId: string, iteration: number): Promise<string> {
    try {
      const content = await this.fileManager.readExecution(taskId, iteration);
      return this.summarizeContent(content);
    } catch {
      return '';
    }
  }

  /**
   * Summarize content by extracting key lines.
   * Takes the first few non-empty, non-heading lines.
   */
  private summarizeContent(content: string): string {
    const lines = content.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));

    if (lines.length === 0) return '';

    // Take up to 5 lines, truncated to SUMMARY_MAX_LENGTH total
    const summary = lines.slice(0, 5).join('\n');
    if (summary.length <= SUMMARY_MAX_LENGTH) return summary;
    return summary.substring(0, SUMMARY_MAX_LENGTH) + '...';
  }

  /**
   * Derive task status from file state.
   */
  private deriveStatus(
    hasFinalResult: boolean,
    latestEvaluationSummary: string,
    iterationCount: number
  ): TaskExecutionStatus {
    if (hasFinalResult) return 'completed';
    if (iterationCount === 0) return 'created';

    // Check if latest evaluation indicates an error
    const lowerEval = latestEvaluationSummary.toLowerCase();
    if (
      lowerEval.includes('error') ||
      lowerEval.includes('failed') ||
      lowerEval.includes('failure') ||
      lowerEval.includes('错误') ||
      lowerEval.includes('失败')
    ) {
      return 'error';
    }

    return 'iterating';
  }

  /**
   * Get the modification time of the task directory.
   */
  private async getDirectoryMtime(taskId: string): Promise<string> {
    try {
      const taskDir = this.fileManager.getTaskDir(taskId);
      const stat = await fs.stat(taskDir);
      return stat.mtime.toISOString();
    } catch {
      return '';
    }
  }
}
