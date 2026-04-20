/**
 * TaskContextReader - Reads and summarizes task state for progress reporting.
 *
 * This module provides a read-only view of a task's current state by reading
 * existing task files (task.md, evaluation.md, execution.md, final_result.md).
 * It does NOT modify any files — it only reads and parses them.
 *
 * The resulting TaskContext snapshot is used by the Reporter Agent to make
 * intelligent decisions about when and what to report to the user.
 *
 * @see Issue #857 - Independent Reporter Agent design
 * @module task/task-context-reader
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { TaskContext, IterationSnapshot, IterationStatus, TaskStatus } from './types.js';

const logger = createLogger('TaskContextReader');

/**
 * Maximum number of characters to extract as a summary from evaluation/execution files.
 */
const SUMMARY_MAX_LENGTH = 200;

/**
 * Regex to extract evaluation status (COMPLETE or NEED_EXECUTE) from evaluation.md.
 */
const EVAL_STATUS_REGEX = /^##\s*Status\s*\n+(COMPLETE|NEED_EXECUTE)/mi;

/**
 * Regex to extract the primary goal from task.md Task Objectives section.
 * Captures from ### header to the next ### or ## header, or end of content.
 * Uses greedy match then splits on the first header boundary.
 */
const PRIMARY_GOAL_REGEX = /^###\s*Primary\s*Goal\s*\n([\s\S]*)/mi;

/**
 * Regex to extract deliverables from task.md.
 * Same approach: greedy match to end, then split on next header.
 */
const DELIVERABLES_REGEX = /^###\s*Required\s*Deliverables\s*\n([\s\S]*)/mi;

/**
 * Regex to extract success criteria from task.md.
 */
const SUCCESS_CRITERIA_REGEX = /^###\s*Success\s*Criteria\s*\n([\s\S]*)/mi;

/**
 * Reads and summarizes the current state of a task.
 *
 * Usage:
 * ```typescript
 * const reader = new TaskContextReader('/path/to/workspace');
 * const context = await reader.readTaskContext('msg_abc123');
 * if (context) {
 *   console.log(`Task "${context.title}" is ${context.status}`);
 *   console.log(`Iterations: ${context.totalIterations}`);
 * }
 * ```
 */
export class TaskContextReader {
  private readonly tasksDir: string;

  /**
   * Create a TaskContextReader.
   *
   * @param workspaceDir - Workspace directory containing tasks/ subdirectory
   */
  constructor(workspaceDir: string) {
    this.tasksDir = path.join(workspaceDir, 'tasks');
  }

  /**
   * Read the full context of a task.
   *
   * @param taskId - Task identifier (message ID)
   * @returns TaskContext snapshot, or null if task doesn't exist
   */
  async readTaskContext(taskId: string): Promise<TaskContext | null> {
    const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const taskDir = path.join(this.tasksDir, sanitized);

    // Check if task directory exists
    try {
      await fs.access(taskDir);
    } catch {
      logger.debug({ taskId }, 'Task directory does not exist');
      return null;
    }

    // Read task.md
    const taskMdPath = path.join(taskDir, 'task.md');
    let taskMdContent = '';
    try {
      taskMdContent = await fs.readFile(taskMdPath, 'utf-8');
    } catch {
      logger.debug({ taskId }, 'task.md not found');
      return null;
    }

    // Parse task.md
    const title = this.extractTitle(taskMdContent, taskId);
    const originalRequest = this.extractOriginalRequest(taskMdContent);
    const createdAt = this.extractCreatedAt(taskMdContent);
    const chatId = this.extractChatId(taskMdContent);
    const primaryGoal = this.extractPrimaryGoal(taskMdContent);
    const deliverables = this.extractDeliverables(taskMdContent);
    const successCriteriaCount = this.extractSuccessCriteria(taskMdContent).length;

    // Check for final result / summary
    const hasFinalResult = await this.fileExists(path.join(taskDir, 'final_result.md'));
    const hasFinalSummary = await this.fileExists(path.join(taskDir, 'iterations', 'final-summary.md'));

    // Determine overall status
    const status = this.determineTaskStatus(hasFinalResult, hasFinalSummary);

    // Read iterations
    const iterations = await this.readIterations(sanitized);

    // Calculate elapsed time
    const elapsed = this.calculateElapsed(createdAt);

    return {
      taskId,
      status,
      title,
      originalRequest,
      createdAt,
      chatId,
      totalIterations: iterations.length,
      iterations,
      hasFinalResult,
      hasFinalSummary,
      elapsed,
      primaryGoal,
      deliverables,
      successCriteriaCount,
    };
  }

  /**
   * Read all tasks in the workspace and return their contexts.
   *
   * @returns Array of TaskContext for all existing tasks
   */
  async readAllTaskContexts(): Promise<TaskContext[]> {
    try {
      const entries = await fs.readdir(this.tasksDir, { withFileTypes: true });
      const contexts: TaskContext[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const context = await this.readTaskContext(entry.name);
          if (context) {
            contexts.push(context);
          }
        }
      }

      return contexts;
    } catch {
      logger.debug('Tasks directory does not exist or is not readable');
      return [];
    }
  }

  /**
   * Read contexts for tasks belonging to a specific chat.
   *
   * @param chatId - Chat ID to filter by
   * @returns Array of TaskContext for tasks in this chat
   */
  async readTaskContextsByChat(chatId: string): Promise<TaskContext[]> {
    const all = await this.readAllTaskContexts();
    return all.filter(ctx => ctx.chatId === chatId);
  }

  /**
   * Check if a task is currently in progress (has iterations but no final result).
   *
   * @param taskId - Task identifier
   * @returns true if task is in progress
   */
  async isTaskInProgress(taskId: string): Promise<boolean> {
    const context = await this.readTaskContext(taskId);
    return context?.status === 'in_progress';
  }

  // ===== Private helpers =====

  /**
   * Extract title from task.md content.
   * Looks for "# Task: ..." pattern.
   */
  private extractTitle(content: string, fallbackTaskId: string): string {
    const match = content.match(/^#\s*Task:\s*(.+)$/m);
    if (match) {
      return match[1].trim();
    }
    return `Task ${fallbackTaskId}`;
  }

  /**
   * Extract original request from the ``` code block in task.md.
   */
  private extractOriginalRequest(content: string): string {
    const match = content.match(/##\s*Original\s*Request\s*\n+```\n?([\s\S]*?)```/m);
    if (match) {
      return match[1].trim();
    }
    return '';
  }

  /**
   * Extract creation timestamp from task.md.
   */
  private extractCreatedAt(content: string): string | null {
    const match = content.match(/\*\*Created\*\*:\s*(.+)/);
    if (match) {
      return match[1].trim();
    }
    return null;
  }

  /**
   * Extract chat ID from task.md.
   */
  private extractChatId(content: string): string | null {
    const match = content.match(/\*\*Chat\s*(?:ID)?\*\*:\s*(.+)/);
    if (match) {
      return match[1].trim();
    }
    return null;
  }

  /**
   * Extract primary goal from task.md Task Objectives section.
   */
  private extractPrimaryGoal(content: string): string | null {
    const match = content.match(PRIMARY_GOAL_REGEX);
    if (match) {
      const sectionContent = this.trimAtNextHeader(match[1]);
      return sectionContent.trim().substring(0, SUMMARY_MAX_LENGTH);
    }
    return null;
  }

  /**
   * Extract deliverables list from task.md.
   */
  private extractDeliverables(content: string): string[] {
    const match = content.match(DELIVERABLES_REGEX);
    if (!match) {return [];}

    const sectionContent = this.trimAtNextHeader(match[1]);
    return this.extractListItems(sectionContent);
  }

  /**
   * Extract success criteria list from task.md.
   */
  private extractSuccessCriteria(content: string): string[] {
    const match = content.match(SUCCESS_CRITERIA_REGEX);
    if (!match) {return [];}

    const sectionContent = this.trimAtNextHeader(match[1]);
    return this.extractListItems(sectionContent);
  }

  /**
   * Trim content at the next markdown header (### or ##).
   */
  private trimAtNextHeader(content: string): string {
    const headerIndex = content.search(/\n(?=##)/);
    if (headerIndex > 0) {
      return content.substring(0, headerIndex);
    }
    return content;
  }

  /**
   * Extract markdown list items ("- item") from content.
   */
  private extractListItems(content: string): string[] {
    return content
      .split('\n')
      .map(line => line.replace(/^-\s*/, '').trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
  }

  /**
   * Determine overall task status based on file presence.
   */
  private determineTaskStatus(hasFinalResult: boolean, hasFinalSummary: boolean): TaskStatus {
    if (hasFinalResult) {return 'completed';}
    if (hasFinalSummary) {return 'completed';}
    return 'in_progress';
  }

  /**
   * Read all iterations for a task.
   */
  private async readIterations(sanitizedTaskId: string): Promise<IterationSnapshot[]> {
    const iterationsDir = path.join(this.tasksDir, sanitizedTaskId, 'iterations');

    try {
      const entries = await fs.readdir(iterationsDir, { withFileTypes: true });
      const iterations: IterationSnapshot[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('iter-')) {continue;}

        const match = entry.name.match(/^iter-(\d+)$/);
        if (!match) {continue;}

        const iterationNum = parseInt(match[1], 10);
        const snapshot = await this.readIteration(sanitizedTaskId, iterationNum);
        iterations.push(snapshot);
      }

      return iterations.sort((a, b) => a.number - b.number);
    } catch {
      return [];
    }
  }

  /**
   * Read a single iteration's state.
   */
  private async readIteration(sanitizedTaskId: string, iteration: number): Promise<IterationSnapshot> {
    const iterDir = path.join(this.tasksDir, sanitizedTaskId, 'iterations', `iter-${iteration}`);

    const evaluationPath = path.join(iterDir, 'evaluation.md');
    const executionPath = path.join(iterDir, 'execution.md');

    const hasEvaluation = await this.fileExists(evaluationPath);
    const hasExecution = await this.fileExists(executionPath);

    let status: IterationStatus = 'pending';
    let evaluationSummary: string | null = null;
    let evaluationVerdict: string | null = null;
    let executionSummary: string | null = null;
    let stepCount = 0;

    if (hasEvaluation) {
      status = 'evaluating';
      try {
        const evalContent = await fs.readFile(evaluationPath, 'utf-8');

        // Extract status verdict
        const verdictMatch = evalContent.match(EVAL_STATUS_REGEX);
        if (verdictMatch) {
          [, evaluationVerdict] = verdictMatch;
        }

        // Extract summary (from Assessment section)
        const summaryMatch = evalContent.match(/##\s*Assessment\s*\n+([\s\S]*?)(?=\n##|\n#|$)/mi);
        if (summaryMatch) {
          evaluationSummary = summaryMatch[1].trim().substring(0, SUMMARY_MAX_LENGTH);
        }
      } catch {
        logger.debug({ iteration }, 'Failed to read evaluation.md');
      }
    }

    if (hasExecution) {
      status = 'executing';
      try {
        const execContent = await fs.readFile(executionPath, 'utf-8');

        // Extract summary (from Summary section)
        const summaryMatch = execContent.match(/##\s*Summary\s*\n+([\s\S]*?)(?=\n##|\n#|$)/mi);
        if (summaryMatch) {
          executionSummary = summaryMatch[1].trim().substring(0, SUMMARY_MAX_LENGTH);
        }

        // If both evaluation and execution exist, mark as completed
        if (hasEvaluation) {
          status = 'completed';
        }
      } catch {
        logger.debug({ iteration }, 'Failed to read execution.md');
      }
    }

    // Count step files
    const stepsDir = path.join(iterDir, 'steps');
    try {
      const stepFiles = await fs.readdir(stepsDir);
      stepCount = stepFiles.filter(f => f.startsWith('step-') && f.endsWith('.md')).length;
    } catch {
      // steps directory doesn't exist
    }

    return {
      number: iteration,
      status,
      evaluationSummary,
      evaluationVerdict,
      executionSummary,
      stepCount,
    };
  }

  /**
   * Calculate elapsed time since task creation.
   */
  private calculateElapsed(createdAt: string | null): string | null {
    if (!createdAt) {return null;}

    try {
      const created = new Date(createdAt);
      if (isNaN(created.getTime())) {return null;}

      const now = new Date();
      const diffMs = now.getTime() - created.getTime();

      const minutes = Math.floor(diffMs / 60000);
      const hours = Math.floor(minutes / 60);

      if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
      }
      return `${minutes}m`;
    } catch {
      return null;
    }
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
