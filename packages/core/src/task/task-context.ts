/**
 * Task Context Reader - Reads and aggregates task state into a structured context.
 *
 * This module provides a unified view of task progress by reading from multiple
 * task files (task.md, evaluation.md, execution.md, final_result.md) and
 * aggregating them into a single TaskContext object.
 *
 * Used by:
 * - Task Progress Reporter skill (for progress reporting)
 * - Dialogue orchestrator (for state awareness)
 * - Any component that needs to read task state
 *
 * Directory structure:
 * tasks/{task_id}/
 *   ├── task.md
 *   ├── final_result.md (optional, when complete)
 *   └── iterations/
 *       ├── iter-1/
 *       │   ├── evaluation.md
 *       │   └── execution.md
 *       └── ...
 *
 * @module task/task-context
 */

import * as fs from 'fs/promises';
import { TaskFileManager } from './task-files.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskContextReader');

/**
 * Evaluation status extracted from evaluation.md.
 */
export type EvaluationStatus = 'NEED_EXECUTE' | 'COMPLETE' | 'UNKNOWN';

/**
 * Structured task context aggregating state from multiple files.
 *
 * This is the primary data structure for the Task Progress Reporter
 * to read and analyze task progress.
 */
export interface TaskContext {
  /** Task identifier (typically messageId) */
  taskId: string;
  /** Task title extracted from task.md */
  title: string;
  /** Task description / original request */
  description: string;
  /** Chat ID from task.md */
  chatId: string;
  /** Task creation timestamp */
  createdAt: string;
  /** User ID from task.md */
  userId: string;

  // Progress information
  /** Current iteration number (0 if no iterations yet) */
  currentIteration: number;
  /** Total number of iterations completed */
  totalIterations: number;
  /** Latest evaluation status */
  latestEvaluationStatus: EvaluationStatus;
  /** Latest evaluation assessment text */
  latestAssessment: string | null;
  /** Latest execution summary text */
  latestExecutionSummary: string | null;
  /** Files modified in the latest execution */
  latestFilesModified: string[];
  /** Next actions from latest evaluation */
  latestNextActions: string[];

  // State
  /** Whether the task is complete (final_result.md exists or evaluation is COMPLETE) */
  isComplete: boolean;
  /** Whether final_result.md exists */
  hasFinalResult: boolean;

  // File paths for direct access
  /** Absolute path to task directory */
  taskDir: string;
  /** Absolute path to task.md */
  taskSpecPath: string;
  /** Absolute path to latest evaluation.md (if any) */
  latestEvaluationPath: string | null;
  /** Absolute path to latest execution.md (if any) */
  latestExecutionPath: string | null;
}

/**
 * Configuration for TaskContextReader.
 */
export interface TaskContextReaderConfig {
  /** Workspace directory for task files */
  workspaceDir: string;
  /** Optional subdirectory for task files */
  subdirectory?: string;
}

/**
 * Reads and aggregates task state from multiple files.
 *
 * Usage:
 * ```typescript
 * const reader = new TaskContextReader({ workspaceDir: '/path/to/workspace' });
 * const ctx = await reader.readTaskContext('om_abc123');
 * console.log(`Task "${ctx.title}" is at iteration ${ctx.currentIteration}/${ctx.totalIterations}`);
 * ```
 */
export class TaskContextReader {
  private readonly fileManager: TaskFileManager;

  constructor(config: TaskContextReaderConfig) {
    this.fileManager = new TaskFileManager(config);
  }

  /**
   * Read and aggregate task context for a given task ID.
   *
   * @param taskId - Task identifier (typically messageId)
   * @returns Structured TaskContext, or null if task doesn't exist
   */
  async readTaskContext(taskId: string): Promise<TaskContext | null> {
    // Check if task exists
    const exists = await this.fileManager.taskExists(taskId);
    if (!exists) {
      logger.debug({ taskId }, 'Task does not exist');
      return null;
    }

    // Read task spec
    let taskSpecContent = '';
    try {
      taskSpecContent = await this.fileManager.readTaskSpec(taskId);
    } catch {
      logger.debug({ taskId }, 'Failed to read task spec');
    }

    // Parse task spec
    const { title, description, chatId, createdAt, userId } = parseTaskSpec(taskSpecContent);

    // Get iterations
    const iterations = await this.fileManager.listIterations(taskId);
    const totalIterations = iterations.length;
    const currentIteration = totalIterations > 0 ? iterations[iterations.length - 1] : 0;

    // Read latest evaluation and execution
    let latestEvaluationStatus: EvaluationStatus = 'UNKNOWN';
    let latestAssessment: string | null = null;
    let latestNextActions: string[] = [];
    let latestEvaluationPath: string | null = null;
    let latestExecutionSummary: string | null = null;
    let latestFilesModified: string[] = [];
    let latestExecutionPath: string | null = null;

    if (currentIteration > 0) {
      // Read evaluation
      const hasEval = await this.fileManager.hasEvaluation(taskId, currentIteration);
      if (hasEval) {
        latestEvaluationPath = this.fileManager.getEvaluationPath(taskId, currentIteration);
        try {
          const evalContent = await this.fileManager.readEvaluation(taskId, currentIteration);
          const parsed = parseEvaluation(evalContent);
          latestEvaluationStatus = parsed.status;
          latestAssessment = parsed.assessment;
          latestNextActions = parsed.nextActions;
        } catch {
          logger.debug({ taskId, iteration: currentIteration }, 'Failed to read evaluation');
        }
      }

      // Read execution
      const hasExec = await this.fileManager.hasExecution(taskId, currentIteration);
      if (hasExec) {
        latestExecutionPath = this.fileManager.getExecutionPath(taskId, currentIteration);
        try {
          const execContent = await this.fileManager.readExecution(taskId, currentIteration);
          const parsed = parseExecution(execContent);
          latestExecutionSummary = parsed.summary;
          latestFilesModified = parsed.filesModified;
        } catch {
          logger.debug({ taskId, iteration: currentIteration }, 'Failed to read execution');
        }
      }
    }

    // Check completion
    const hasFinalResult = await this.fileManager.hasFinalResult(taskId);
    const isComplete = hasFinalResult || latestEvaluationStatus === 'COMPLETE';

    return {
      taskId,
      title,
      description,
      chatId,
      createdAt,
      userId,
      currentIteration,
      totalIterations,
      latestEvaluationStatus,
      latestAssessment,
      latestExecutionSummary,
      latestFilesModified,
      latestNextActions,
      isComplete,
      hasFinalResult,
      taskDir: this.fileManager.getTaskDir(taskId),
      taskSpecPath: this.fileManager.getTaskSpecPath(taskId),
      latestEvaluationPath,
      latestExecutionPath,
    };
  }

  /**
   * Get a brief progress summary suitable for quick status checks.
   *
   * @param taskId - Task identifier
   * @returns Human-readable progress string, or null if task doesn't exist
   */
  async getProgressSummary(taskId: string): Promise<string | null> {
    const ctx = await this.readTaskContext(taskId);
    if (!ctx) {return null;}

    if (ctx.isComplete) {
      return `✅ "${ctx.title}" - 已完成 (${ctx.totalIterations} 次迭代)`;
    }

    if (ctx.currentIteration === 0) {
      return `⏳ "${ctx.title}" - 等待执行`;
    }

    const statusText = ctx.latestEvaluationStatus === 'NEED_EXECUTE'
      ? '执行中'
      : ctx.latestEvaluationStatus === 'COMPLETE'
        ? '评估完成'
        : '评估中';

    return `🔄 "${ctx.title}" - ${statusText} (迭代 ${ctx.currentIteration}/${ctx.totalIterations})`;
  }

  /**
   * List all active (non-complete) task IDs.
   *
   * @returns Array of task IDs that are still running
   */
  async listActiveTasks(): Promise<string[]> {
    const workspaceDir = this.fileManager.getTaskSpecPath('__probe__').replace(/tasks\/__probe__\/task\.md$/, 'tasks');

    try {
      const entries = await fs.readdir(workspaceDir, { withFileTypes: true });
      const activeTasks: string[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) {continue;}

        const taskId = entry.name;
        const ctx = await this.readTaskContext(taskId);
        if (ctx && !ctx.isComplete) {
          activeTasks.push(taskId);
        }
      }

      return activeTasks;
    } catch {
      logger.debug('Failed to list tasks directory');
      return [];
    }
  }
}

// ===== Parsing Functions =====

/**
 * Parse task.md content to extract structured fields.
 */
function parseTaskSpec(content: string): {
  title: string;
  description: string;
  chatId: string;
  createdAt: string;
  userId: string;
} {
  let title = 'Untitled Task';
  let description = '';
  let chatId = '';
  let createdAt = '';
  let userId = '';

  // Extract title from first heading
  const titleMatch = content.match(/^#\s+Task:\s*(.+)$/m);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }

  // Extract metadata fields (format: **Label**: value)
  const chatIdMatch = content.match(/\*\*Chat\s*ID\*\*:\s*(\S+)/);
  if (chatIdMatch) {
    [, chatId] = chatIdMatch;
  }

  const createdMatch = content.match(/\*\*Created\*\*:\s*(.+)/);
  if (createdMatch) {
    createdAt = createdMatch[1].trim();
  }

  const userMatch = content.match(/\*\*User\s*ID\*\*:\s*(\S+)/);
  if (userMatch) {
    [, userId] = userMatch;
  }

  // Extract description (content between "## Description" and next "##" heading)
  const descMatch = content.match(/##\s+(?:Original Request|Description)\s*\n([\s\S]*?)(?=\n##\s|$)/);
  if (descMatch) {
    description = descMatch[1].trim();
    // Remove code fences if description is wrapped in them
    description = description.replace(/^```\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }

  return { title, description, chatId, createdAt, userId };
}

/**
 * Parse evaluation.md content to extract status and assessment.
 */
function parseEvaluation(content: string): {
  status: EvaluationStatus;
  assessment: string | null;
  nextActions: string[];
} {
  let status: EvaluationStatus = 'UNKNOWN';
  let assessment: string | null = null;
  const nextActions: string[] = [];

  // Extract status
  const statusMatch = content.match(/##\s+Status\s*\n\s*(NEED_EXECUTE|COMPLETE)/i);
  if (statusMatch) {
    const raw = statusMatch[1].toUpperCase();
    status = raw === 'NEED_EXECUTE' || raw === 'COMPLETE' ? raw : 'UNKNOWN';
  }

  // Extract assessment
  const assessMatch = content.match(/##\s+Assessment\s*\n([\s\S]*?)(?=\n##\s|$)/);
  if (assessMatch) {
    assessment = assessMatch[1].trim();
  }

  // Extract next actions
  const actionsMatch = content.match(/##\s+Next Actions?\s*\n([\s\S]*?)(?=\n##\s|$)/);
  if (actionsMatch) {
    const actionsText = actionsMatch[1].trim();
    const actionItems = actionsText.match(/^[-*]\s+(.+)$/gm);
    if (actionItems) {
      nextActions.push(...actionItems.map(item => item.replace(/^[-*]\s+/, '').trim()));
    }
  }

  return { status, assessment, nextActions };
}

/**
 * Parse execution.md content to extract summary and files modified.
 */
function parseExecution(content: string): {
  summary: string | null;
  filesModified: string[];
} {
  let summary: string | null = null;
  const filesModified: string[] = [];

  // Extract summary
  const summaryMatch = content.match(/##\s+Summary\s*\n([\s\S]*?)(?=\n##\s|$)/);
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
  }

  // Extract files modified
  const filesMatch = content.match(/##\s+Files Modified\s*\n([\s\S]*?)(?=\n##\s|$)/);
  if (filesMatch) {
    const filesText = filesMatch[1].trim();
    const fileItems = filesText.match(/^[-*]\s+(.+)$/gm);
    if (fileItems) {
      filesModified.push(...fileItems.map(item => item.replace(/^[-*]\s+/, '').trim()));
    }
  }

  return { summary, filesModified };
}
