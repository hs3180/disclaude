/**
 * TaskContext - Shared task state management for Reporter Agent.
 *
 * Provides a mechanism for the main task execution to write status updates
 * and for an independent Reporter Agent to read them. This enables the
 * "independent Reporter Agent" approach described in Issue #857.
 *
 * Architecture:
 * ```
 * Deep Task (writes) → TaskContext (shared state) → Reporter Agent (reads)
 * ```
 *
 * Task context is stored as a JSON file alongside the task directory:
 * ```
 * tasks/{task_id}/
 *   ├── task.md
 *   ├── context.json    ← TaskContext
 *   ├── iterations/
 *   └── final_result.md
 * ```
 *
 * @module task/task-context
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskContext');

/**
 * Task status enum.
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * A single step in the task execution.
 */
export interface TaskStep {
  /** Step description */
  description: string;
  /** Step status */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  /** Timestamp when the step started */
  startedAt?: string;
  /** Timestamp when the step completed */
  completedAt?: string;
}

/**
 * Task context data structure.
 * Shared between the main task executor and the Reporter Agent.
 */
export interface TaskContextData {
  /** Task ID (typically messageId) */
  taskId: string;
  /** Current overall task status */
  status: TaskStatus;
  /** Task description (from task.md) */
  description: string;
  /** Chat ID for message delivery */
  chatId: string;
  /** Task creation timestamp */
  createdAt: string;
  /** Timestamp when task started running */
  startedAt?: string;
  /** Timestamp when task completed */
  completedAt?: string;
  /** Current step being executed */
  currentStep?: string;
  /** List of completed steps */
  completedSteps: string[];
  /** Total number of expected steps (if known) */
  totalSteps?: number;
  /** Current iteration number */
  currentIteration?: number;
  /** Total iterations so far */
  totalIterations?: number;
  /** Error message if task failed */
  error?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * TaskContext - Manages shared task state for the Reporter Agent.
 *
 * This class provides methods to:
 * - Initialize task context when a task is created
 * - Update task status during execution
 * - Read task context for reporting
 *
 * Usage by main task executor:
 * ```typescript
 * const ctx = new TaskContext(workspaceDir);
 * await ctx.initContext('task-123', { chatId: 'oc_xxx', description: 'Fix bug' });
 * await ctx.updateStatus('task-123', 'running');
 * await ctx.addCompletedStep('task-123', 'Read source files');
 * await ctx.updateStatus('task-123', 'completed');
 * ```
 *
 * Usage by Reporter Agent (via MCP tool):
 * ```typescript
 * const ctx = new TaskContext(workspaceDir);
 * const data = await ctx.readContext('task-123');
 * ```
 */
export class TaskContext {
  private readonly tasksDir: string;

  constructor(workspaceDir: string) {
    this.tasksDir = path.join(workspaceDir, 'tasks');
  }

  /**
   * Get the path to the context JSON file for a task.
   */
  private getContextPath(taskId: string): string {
    const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.tasksDir, sanitized, 'context.json');
  }

  /**
   * Initialize task context when a task is created.
   *
   * @param taskId - Task identifier (typically messageId)
   * @param options - Initial context options
   */
  async initContext(
    taskId: string,
    options: {
      chatId: string;
      description: string;
      totalSteps?: number;
      metadata?: Record<string, unknown>;
    }
  ): Promise<TaskContextData> {
    const contextPath = this.getContextPath(taskId);

    // Ensure directory exists
    await fs.mkdir(path.dirname(contextPath), { recursive: true });

    const data: TaskContextData = {
      taskId,
      status: 'pending',
      description: options.description,
      chatId: options.chatId,
      createdAt: new Date().toISOString(),
      completedSteps: [],
      totalSteps: options.totalSteps,
      metadata: options.metadata,
    };

    try {
      await fs.writeFile(contextPath, JSON.stringify(data, null, 2), 'utf-8');
      logger.debug({ taskId }, 'Task context initialized');
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to initialize task context');
      throw error;
    }

    return data;
  }

  /**
   * Read task context.
   *
   * Used by the Reporter Agent to understand current task state.
   *
   * @param taskId - Task identifier
   * @returns Task context data, or null if not found
   */
  async readContext(taskId: string): Promise<TaskContextData | null> {
    const contextPath = this.getContextPath(taskId);

    try {
      const content = await fs.readFile(contextPath, 'utf-8');
      return JSON.parse(content) as TaskContextData;
    } catch (error) {
      logger.debug({ err: error, taskId }, 'Task context not found');
      return null;
    }
  }

  /**
   * Update task status.
   *
   * @param taskId - Task identifier
   * @param status - New status
   * @param additionalData - Optional additional data to merge
   */
  async updateStatus(
    taskId: string,
    status: TaskStatus,
    additionalData?: Partial<TaskContextData>
  ): Promise<void> {
    const contextPath = this.getContextPath(taskId);

    try {
      let data = await this.readContext(taskId);

      if (!data) {
        logger.warn({ taskId, status }, 'Task context not found, creating new');
        data = {
          taskId,
          status,
          description: '',
          chatId: '',
          createdAt: new Date().toISOString(),
          completedSteps: [],
        };
      }

      // Update timestamps based on status change
      const now = new Date().toISOString();
      if (status === 'running' && !data.startedAt) {
        data.startedAt = now;
      }
      if (status === 'completed' || status === 'failed') {
        data.completedAt = now;
      }

      data.status = status;

      // Merge additional data
      if (additionalData) {
        Object.assign(data, additionalData);
      }

      // Ensure directory exists before writing (context may be new)
      await fs.mkdir(path.dirname(contextPath), { recursive: true });
      await fs.writeFile(contextPath, JSON.stringify(data, null, 2), 'utf-8');
      logger.debug({ taskId, status }, 'Task context updated');
    } catch (error) {
      logger.error({ err: error, taskId, status }, 'Failed to update task context');
      throw error;
    }
  }

  /**
   * Set the current step being executed.
   *
   * @param taskId - Task identifier
   * @param stepDescription - Description of the current step
   */
  async setCurrentStep(taskId: string, stepDescription: string): Promise<void> {
    await this.updateStatus(taskId, 'running', { currentStep: stepDescription });
  }

  /**
   * Add a completed step to the task context.
   *
   * @param taskId - Task identifier
   * @param stepDescription - Description of the completed step
   */
  async addCompletedStep(taskId: string, stepDescription: string): Promise<void> {
    const data = await this.readContext(taskId);
    if (!data) {
      logger.warn({ taskId }, 'Task context not found when adding completed step');
      return;
    }

    data.completedSteps.push(stepDescription);
    data.currentStep = undefined;

    await this.updateStatus(taskId, data.status, {
      completedSteps: data.completedSteps,
      currentStep: undefined,
    });
  }

  /**
   * Set the current iteration number.
   *
   * @param taskId - Task identifier
   * @param iteration - Current iteration number
   */
  async setIteration(taskId: string, iteration: number): Promise<void> {
    await this.updateStatus(taskId, 'running', {
      currentIteration: iteration,
      totalIterations: iteration,
    });
  }

  /**
   * Record an error in the task context.
   *
   * @param taskId - Task identifier
   * @param error - Error message
   */
  async recordError(taskId: string, error: string): Promise<void> {
    await this.updateStatus(taskId, 'failed', { error });
  }

  /**
   * Check if a task context exists.
   *
   * @param taskId - Task identifier
   * @returns True if context file exists
   */
  async hasContext(taskId: string): Promise<boolean> {
    const contextPath = this.getContextPath(taskId);
    try {
      await fs.access(contextPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all active tasks (pending or running).
   *
   * @returns Array of task IDs that are active
   */
  async listActiveTasks(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.tasksDir, { withFileTypes: true });
      const activeTasks: string[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) {continue;}

        const contextPath = path.join(this.tasksDir, entry.name, 'context.json');
        try {
          const content = await fs.readFile(contextPath, 'utf-8');
          const data = JSON.parse(content) as TaskContextData;
          if (data.status === 'pending' || data.status === 'running') {
            activeTasks.push(data.taskId);
          }
        } catch {
          // No context.json or parse error, skip
        }
      }

      return activeTasks;
    } catch (error) {
      logger.error({ err: error }, 'Failed to list active tasks');
      return [];
    }
  }

  /**
   * Get a summary of the task context suitable for display.
   *
   * @param taskId - Task identifier
   * @returns Human-readable summary, or null if not found
   */
  async getSummary(taskId: string): Promise<string | null> {
    const data = await this.readContext(taskId);
    if (!data) {return null;}

    const elapsed = data.startedAt
      ? Math.round((Date.now() - new Date(data.startedAt).getTime()) / 1000)
      : 0;

    const statusEmoji: Record<TaskStatus, string> = {
      pending: '⏳',
      running: '🔄',
      completed: '✅',
      failed: '❌',
    };

    const lines = [
      `${statusEmoji[data.status]} **Task**: ${data.description}`,
      `**Status**: ${data.status}`,
    ];

    if (data.startedAt) {
      lines.push(`**Elapsed**: ${elapsed}s`);
    }

    if (data.currentStep) {
      lines.push(`**Current**: ${data.currentStep}`);
    }

    if (data.completedSteps.length > 0) {
      const totalStr = data.totalSteps ? `/${data.totalSteps}` : '';
      lines.push(`**Progress**: ${data.completedSteps.length}${totalStr} steps completed`);
    }

    if (data.currentIteration) {
      lines.push(`**Iteration**: ${data.currentIteration}`);
    }

    if (data.error) {
      lines.push(`**Error**: ${data.error}`);
    }

    return lines.join('\n');
  }
}
