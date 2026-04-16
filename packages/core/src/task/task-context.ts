/**
 * TaskContext - Shared task execution state for progress reporting.
 *
 * Issue #857: Provides a structured, persisted task state that can be read
 * by an independent Reporter Agent to provide progress updates to users.
 *
 * Architecture:
 * ```
 *   Deep Task (main task)
 *        │
 *        ▼
 *   TaskContext (shared state, persisted as context.json)
 *        │
 *        ▼
 *   Reporter Agent (reads context via get_task_status MCP tool)
 *        │
 *        ▼
 *   User notification (progress card)
 * ```
 *
 * The TaskContext is stored alongside task.md in the task directory:
 * ```
 * tasks/{taskId}/
 *   ├── task.md
 *   ├── context.json    ← TaskContext data
 *   ├── final_result.md
 *   └── iterations/
 * ```
 *
 * @module task/task-context
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskContext');

// ============================================================================
// Types
// ============================================================================

/**
 * Task execution status.
 *
 * Lifecycle: `pending` → `running` → `completed` | `failed`
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * A single step in the task execution.
 */
export interface TaskStep {
  /** Step name/description */
  name: string;
  /** Step status */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  /** ISO timestamp when the step started */
  startedAt?: string;
  /** ISO timestamp when the step completed */
  completedAt?: string;
  /** Optional error message (only when status is 'failed') */
  error?: string;
}

/**
 * TaskContext data structure.
 *
 * Stored as `context.json` in the task directory.
 * Designed to be read by an independent Reporter Agent.
 */
export interface TaskContextData {
  /** Task ID (typically messageId) */
  taskId: string;
  /** Task description (from the original user request) */
  description: string;
  /** Current overall status */
  status: TaskStatus;
  /** Chat ID for delivering progress updates */
  chatId: string;
  /** Current activity description (what the agent is doing right now) */
  currentActivity?: string;
  /** List of execution steps */
  steps: TaskStep[];
  /** ISO timestamp when the task was created */
  createdAt: string;
  /** ISO timestamp when the task started executing */
  startedAt?: string;
  /** ISO timestamp when the task completed */
  completedAt?: string;
  /** Error message (only when status is 'failed') */
  error?: string;
  /** Number of iterations completed */
  iterationsCompleted: number;
  /** Files modified during execution */
  filesModified: string[];
}

/**
 * Configuration for TaskContext.
 */
export interface TaskContextConfig {
  /** Base workspace directory */
  workspaceDir: string;
}

// ============================================================================
// TaskContext Manager
// ============================================================================

/**
 * Manages TaskContext lifecycle: creation, updates, and reads.
 *
 * This class provides methods for:
 * - Creating a new TaskContext when a task starts
 * - Updating status, steps, and other fields during execution
 * - Reading the current state for progress reporting
 * - Cleaning up completed task contexts
 *
 * @example
 * ```typescript
 * const ctx = new TaskContext({ workspaceDir: './workspace' });
 *
 * // Create context when task starts
 * await ctx.create('msg_123', {
 *   description: 'Fix the authentication bug',
 *   chatId: 'oc_xxx',
 * });
 *
 * // Start execution
 * await ctx.start('msg_123');
 *
 * // Update progress during execution
 * await ctx.updateStep('msg_123', 0, { status: 'completed' });
 * await ctx.setCurrentActivity('msg_123', 'Modifying auth.service.ts');
 *
 * // Complete the task
 * await ctx.complete('msg_123');
 * ```
 */
export class TaskContext {
  private readonly tasksDir: string;

  constructor(config: TaskContextConfig) {
    this.tasksDir = path.join(config.workspaceDir, 'tasks');
  }

  // ============================================================================
  // Context File Operations
  // ============================================================================

  /**
   * Get the path to the context.json file for a task.
   */
  getContextPath(taskId: string): string {
    const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.tasksDir, sanitized, 'context.json');
  }

  /**
   * Check if a TaskContext exists for a given task.
   */
  async exists(taskId: string): Promise<boolean> {
    try {
      await fs.access(this.getContextPath(taskId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read the current TaskContext data.
   *
   * Returns null if no context exists.
   */
  async read(taskId: string): Promise<TaskContextData | null> {
    const contextPath = this.getContextPath(taskId);
    try {
      const raw = await fs.readFile(contextPath, 'utf-8');
      return JSON.parse(raw) as TaskContextData;
    } catch (error) {
      logger.debug({ err: error, taskId }, 'No task context found');
      return null;
    }
  }

  /**
   * Write TaskContext data to disk.
   */
  private async write(data: TaskContextData): Promise<void> {
    const contextPath = this.getContextPath(data.taskId);

    // Ensure directory exists
    const dir = path.dirname(contextPath);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(contextPath, JSON.stringify(data, null, 2), 'utf-8');
    logger.debug({ taskId: data.taskId, status: data.status }, 'Task context written');
  }

  // ============================================================================
  // Lifecycle Methods
  // ============================================================================

  /**
   * Create a new TaskContext in `pending` state.
   *
   * Called when a deep task is initialized (before execution starts).
   *
   * @param taskId - Task identifier (typically messageId)
   * @param options - Initial task metadata
   */
  async create(
    taskId: string,
    options: {
      description: string;
      chatId: string;
      steps?: string[];
    }
  ): Promise<TaskContextData> {
    const now = new Date().toISOString();

    const data: TaskContextData = {
      taskId,
      description: options.description,
      status: 'pending',
      chatId: options.chatId,
      steps: (options.steps || []).map(name => ({
        name,
        status: 'pending' as const,
      })),
      createdAt: now,
      iterationsCompleted: 0,
      filesModified: [],
    };

    await this.write(data);
    logger.info({ taskId }, 'Task context created');
    return data;
  }

  /**
   * Transition task to `running` state.
   *
   * Called when execution begins.
   */
  async start(taskId: string): Promise<TaskContextData | null> {
    const data = await this.read(taskId);
    if (!data) {
      logger.warn({ taskId }, 'Cannot start: task context not found');
      return null;
    }

    data.status = 'running';
    data.startedAt = new Date().toISOString();

    // Mark first pending step as running
    const firstPending = data.steps.find(s => s.status === 'pending');
    if (firstPending) {
      firstPending.status = 'running';
      firstPending.startedAt = new Date().toISOString();
    }

    await this.write(data);
    logger.info({ taskId }, 'Task context: started');
    return data;
  }

  /**
   * Transition task to `completed` state.
   */
  async complete(taskId: string): Promise<TaskContextData | null> {
    const data = await this.read(taskId);
    if (!data) {
      logger.warn({ taskId }, 'Cannot complete: task context not found');
      return null;
    }

    data.status = 'completed';
    data.completedAt = new Date().toISOString();

    // Mark all running steps as completed
    for (const step of data.steps) {
      if (step.status === 'running') {
        step.status = 'completed';
        step.completedAt = new Date().toISOString();
      }
    }

    await this.write(data);
    logger.info({ taskId }, 'Task context: completed');
    return data;
  }

  /**
   * Transition task to `failed` state.
   */
  async fail(taskId: string, error: string): Promise<TaskContextData | null> {
    const data = await this.read(taskId);
    if (!data) {
      logger.warn({ taskId }, 'Cannot fail: task context not found');
      return null;
    }

    data.status = 'failed';
    data.completedAt = new Date().toISOString();
    data.error = error;

    // Mark running step as failed
    for (const step of data.steps) {
      if (step.status === 'running') {
        step.status = 'failed';
        step.completedAt = new Date().toISOString();
        step.error = error;
      }
    }

    await this.write(data);
    logger.info({ taskId, error }, 'Task context: failed');
    return data;
  }

  // ============================================================================
  // Step Management
  // ============================================================================

  /**
   * Update a specific step's status.
   *
   * @param taskId - Task identifier
   * @param stepIndex - Zero-based index of the step
   * @param update - Partial update to apply to the step
   */
  async updateStep(
    taskId: string,
    stepIndex: number,
    update: Partial<Pick<TaskStep, 'status' | 'error'>>
  ): Promise<TaskContextData | null> {
    const data = await this.read(taskId);
    if (!data) {
      logger.warn({ taskId }, 'Cannot update step: task context not found');
      return null;
    }

    if (stepIndex < 0 || stepIndex >= data.steps.length) {
      logger.warn({ taskId, stepIndex, totalSteps: data.steps.length }, 'Step index out of range');
      return data;
    }

    const step = data.steps[stepIndex];

    if (update.status === 'running' && step.status === 'pending') {
      step.startedAt = new Date().toISOString();
    }

    if (update.status === 'completed' || update.status === 'failed') {
      step.completedAt = new Date().toISOString();
    }

    if (update.status !== undefined) {
      step.status = update.status;
    }
    if (update.error !== undefined) {
      step.error = update.error;
    }

    await this.write(data);
    return data;
  }

  /**
   * Add a new step to the task.
   */
  async addStep(taskId: string, name: string): Promise<TaskContextData | null> {
    const data = await this.read(taskId);
    if (!data) {
      logger.warn({ taskId }, 'Cannot add step: task context not found');
      return null;
    }

    data.steps.push({
      name,
      status: 'pending',
    });

    await this.write(data);
    return data;
  }

  // ============================================================================
  // Field Updates
  // ============================================================================

  /**
   * Update the current activity description.
   *
   * Called by the executor to indicate what it's currently working on.
   */
  async setCurrentActivity(taskId: string, activity: string): Promise<TaskContextData | null> {
    const data = await this.read(taskId);
    if (!data) {
      logger.warn({ taskId }, 'Cannot set activity: task context not found');
      return null;
    }

    data.currentActivity = activity;
    await this.write(data);
    return data;
  }

  /**
   * Increment the iterations completed counter.
   */
  async incrementIterations(taskId: string): Promise<TaskContextData | null> {
    const data = await this.read(taskId);
    if (!data) {
      logger.warn({ taskId }, 'Cannot increment iterations: task context not found');
      return null;
    }

    data.iterationsCompleted++;
    await this.write(data);
    return data;
  }

  /**
   * Add a file to the modified files list.
   */
  async addModifiedFile(taskId: string, filePath: string): Promise<TaskContextData | null> {
    const data = await this.read(taskId);
    if (!data) {
      logger.warn({ taskId }, 'Cannot add file: task context not found');
      return null;
    }

    if (!data.filesModified.includes(filePath)) {
      data.filesModified.push(filePath);
    }

    await this.write(data);
    return data;
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  /**
   * Get elapsed time since the task started.
   *
   * Returns null if the task hasn't started yet.
   */
  async getElapsedTime(taskId: string): Promise<number | null> {
    const data = await this.read(taskId);
    if (!data || !data.startedAt) {
      return null;
    }

    const end = data.completedAt ? new Date(data.completedAt) : new Date();
    const start = new Date(data.startedAt);
    return end.getTime() - start.getTime();
  }

  /**
   * Get a summary of the task progress suitable for display.
   */
  async getProgressSummary(taskId: string): Promise<{
    status: TaskStatus;
    completedSteps: number;
    totalSteps: number;
    currentActivity?: string;
    elapsedMs: number | null;
    iterationsCompleted: number;
  } | null> {
    const data = await this.read(taskId);
    if (!data) {
      return null;
    }

    const completedSteps = data.steps.filter(
      s => s.status === 'completed'
    ).length;
    const elapsedMs = await this.getElapsedTime(taskId);

    return {
      status: data.status,
      completedSteps,
      totalSteps: data.steps.length,
      currentActivity: data.currentActivity,
      elapsedMs,
      iterationsCompleted: data.iterationsCompleted,
    };
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Remove the context file.
   */
  async cleanup(taskId: string): Promise<void> {
    const contextPath = this.getContextPath(taskId);
    try {
      await fs.unlink(contextPath);
      logger.info({ taskId }, 'Task context cleaned up');
    } catch (error) {
      logger.debug({ err: error, taskId }, 'Task context cleanup skipped (not found)');
    }
  }
}
