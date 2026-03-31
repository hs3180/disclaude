/**
 * TaskContext - Shared state for task progress tracking.
 *
 * Provides a centralized in-memory store for task progress information.
 * Used by:
 * - Task agents to update their progress during execution
 * - Reporter agents to read task status and generate reports
 * - MCP tools to expose task information to agents
 *
 * Issue #857: Foundation for Independent Reporter Agent design.
 *
 * Architecture:
 * ```
 * ┌─────────────────┐     ┌──────────────────┐
 * │   Deep Task     │────▶│   TaskContext    │
 * │   (主任务)       │     │  (共享状态)       │
 * └─────────────────┘     └────────┬─────────┘
 *                                  │
 *                                  ▼
 *                         ┌──────────────────┐
 *                         │  Reporter Agent  │
 *                         │  (独立汇报 Agent) │
 *                         └──────────────────┘
 * ```
 *
 * @module task/task-context
 */

import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskContext');

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Status of a tracked task.
 */
export type TaskProgressStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * A single step in task execution progress.
 */
export interface TaskStep {
  /** Step identifier or name */
  name: string;
  /** Step status */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** Timestamp when step started */
  startedAt?: Date;
  /** Timestamp when step completed */
  completedAt?: Date;
  /** Optional error message if step failed */
  error?: string;
}

/**
 * Progress information for a tracked task.
 */
export interface TaskProgress {
  /** Unique task identifier */
  taskId: string;
  /** Human-readable task description */
  description: string;
  /** Current task status */
  status: TaskProgressStatus;
  /** Current step description (free-form, set by agent) */
  currentStep: string;
  /** Structured step list (optional, for detailed tracking) */
  steps: TaskStep[];
  /** Chat ID where the task was initiated */
  chatId?: string;
  /** Timestamp when task was registered */
  registeredAt: Date;
  /** Timestamp when task started running */
  startedAt?: Date;
  /** Timestamp of last progress update */
  updatedAt: Date;
  /** Timestamp when task completed or failed */
  completedAt?: Date;
  /** Error message if task failed */
  error?: string;
  /** Elapsed time in milliseconds */
  elapsedTime: number;
  /** Total estimated steps (optional, for progress percentage) */
  totalEstimatedSteps?: number;
  /** Custom metadata (extensible by agents) */
  metadata?: Record<string, unknown>;
}

/**
 * Options for registering a new task.
 */
export interface RegisterTaskOptions {
  /** Unique task identifier */
  taskId: string;
  /** Human-readable task description */
  description: string;
  /** Chat ID where the task was initiated */
  chatId?: string;
  /** Total estimated steps (optional) */
  totalEstimatedSteps?: number;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Options for updating task progress.
 */
export interface UpdateProgressOptions {
  /** Updated current step description */
  currentStep?: string;
  /** Updated status */
  status?: TaskProgressStatus;
  /** Error message (if status is 'failed') */
  error?: string;
  /** Add a structured step */
  addStep?: TaskStep;
  /** Update a step by name */
  updateStep?: { name: string; status: TaskStep['status']; error?: string };
  /** Update total estimated steps */
  totalEstimatedSteps?: number;
  /** Update custom metadata (merged) */
  metadata?: Record<string, unknown>;
}

/**
 * Events emitted by TaskContext.
 */
export type TaskContextEventType =
  | 'task:registered'
  | 'task:started'
  | 'task:progress'
  | 'task:completed'
  | 'task:failed'
  | 'task:cancelled';

/**
 * Event payload for TaskContext events.
 */
export interface TaskContextEvent {
  type: TaskContextEventType;
  taskId: string;
  progress: TaskProgress;
  timestamp: Date;
}

// ============================================================================
// TaskContext Implementation
// ============================================================================

/**
 * Shared state store for task progress tracking.
 *
 * Provides a centralized in-memory store that connects task agents (which update
 * progress) with reporter agents (which read progress and generate reports).
 *
 * ## Usage
 *
 * ```typescript
 * // Initialize (called once at startup)
 * const ctx = initTaskContext();
 *
 * // Register a task (when deep task starts)
 * ctx.registerTask({ taskId: 'task-1', description: 'Fix bug #123', chatId: 'oc_xxx' });
 *
 * // Update progress (called by task agent via MCP tool)
 * ctx.updateProgress('task-1', { currentStep: 'Analyzing code...' });
 *
 * // Complete a task
 * ctx.completeTask('task-1');
 *
 * // Read progress (called by reporter agent via MCP tool)
 * const progress = ctx.getTaskProgress('task-1');
 * ```
 *
 * @example
 * ```typescript
 * // Listen for events
 * const ctx = getTaskContext();
 * ctx.on('task:progress', (event) => {
 *   console.log(`Task ${event.taskId}: ${event.progress.currentStep}`);
 * });
 * ```
 */
export class TaskContext extends EventEmitter {
  private tasks: Map<string, TaskProgress> = new Map();
  private maxTasks: number;

  /**
   * @param maxTasks - Maximum number of tasks to track (default: 1000)
   */
  constructor(maxTasks: number = 1000) {
    super();
    this.maxTasks = maxTasks;
  }

  // --------------------------------------------------------------------------
  // Task Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Register a new task for progress tracking.
   *
   * @param options - Task registration options
   * @throws {Error} If taskId is empty or task already exists
   */
  registerTask(options: RegisterTaskOptions): TaskProgress {
    const { taskId, description, chatId, totalEstimatedSteps, metadata } = options;

    if (!taskId) {
      throw new Error('taskId is required');
    }

    if (this.tasks.has(taskId)) {
      throw new Error(`Task ${taskId} already registered`);
    }

    // Enforce max tasks limit
    if (this.tasks.size >= this.maxTasks) {
      this.evictOldestCompleted();
    }

    const now = new Date();
    const progress: TaskProgress = {
      taskId,
      description,
      status: 'pending',
      currentStep: 'Task registered',
      steps: [],
      chatId,
      registeredAt: now,
      updatedAt: now,
      elapsedTime: 0,
      totalEstimatedSteps,
      metadata,
    };

    this.tasks.set(taskId, progress);
    this.emitEvent('task:registered', progress);

    logger.info({ taskId, description }, 'Task registered');
    return progress;
  }

  /**
   * Mark a task as started.
   *
   * @param taskId - Task identifier
   * @param currentStep - Optional initial step description
   * @throws {Error} If task not found
   */
  startTask(taskId: string, currentStep?: string): TaskProgress {
    const progress = this.getTaskOrThrow(taskId);

    if (progress.status !== 'pending') {
      throw new Error(`Task ${taskId} is not pending (current: ${progress.status})`);
    }

    progress.status = 'running';
    progress.startedAt = new Date();
    progress.updatedAt = new Date();
    if (currentStep) {
      progress.currentStep = currentStep;
    }

    this.emitEvent('task:started', progress);
    logger.info({ taskId }, 'Task started');
    return progress;
  }

  /**
   * Update progress for a running task.
   *
   * @param taskId - Task identifier
   * @param update - Progress update options
   * @returns Updated task progress
   * @throws {Error} If task not found or not running
   */
  updateProgress(taskId: string, update: UpdateProgressOptions): TaskProgress {
    const progress = this.getTaskOrThrow(taskId);

    if (progress.status !== 'running' && progress.status !== 'pending') {
      throw new Error(`Cannot update progress for task ${taskId} (status: ${progress.status})`);
    }

    const now = new Date();

    // Auto-start if still pending
    if (progress.status === 'pending') {
      progress.status = 'running';
      progress.startedAt = now;
    }

    // Apply updates
    if (update.currentStep !== undefined) {
      progress.currentStep = update.currentStep;
    }

    if (update.status !== undefined) {
      progress.status = update.status;
      if (update.status === 'failed' && update.error) {
        progress.error = update.error;
        progress.completedAt = now;
      }
      if (update.status === 'completed') {
        progress.completedAt = now;
      }
      if (update.status === 'cancelled') {
        progress.completedAt = now;
      }
    }

    if (update.totalEstimatedSteps !== undefined) {
      progress.totalEstimatedSteps = update.totalEstimatedSteps;
    }

    // Handle structured steps
    if (update.addStep) {
      progress.steps.push(update.addStep);
    }

    if (update.updateStep) {
      const step = progress.steps.find(s => s.name === update.updateStep!.name);
      if (step) {
        step.status = update.updateStep.status;
        if (update.updateStep.error) {
          step.error = update.updateStep.error;
        }
        if (update.updateStep.status === 'completed' || update.updateStep.status === 'failed') {
          step.completedAt = now;
        }
      }
    }

    // Merge metadata
    if (update.metadata) {
      progress.metadata = { ...progress.metadata, ...update.metadata };
    }

    progress.updatedAt = now;
    progress.elapsedTime = now.getTime() - (progress.startedAt ?? progress.registeredAt).getTime();

    this.emitEvent('task:progress', progress);
    logger.debug({ taskId, step: progress.currentStep }, 'Task progress updated');
    return progress;
  }

  /**
   * Mark a task as completed.
   *
   * @param taskId - Task identifier
   * @param result - Optional result message
   * @returns Completed task progress
   */
  completeTask(taskId: string, result?: string): TaskProgress {
    const progress = this.getTaskOrThrow(taskId);

    progress.status = 'completed';
    progress.completedAt = new Date();
    progress.updatedAt = new Date();
    progress.currentStep = result || 'Task completed';
    progress.elapsedTime = progress.completedAt.getTime() - (progress.startedAt ?? progress.registeredAt).getTime();

    this.emitEvent('task:completed', progress);
    logger.info({ taskId }, 'Task completed');
    return progress;
  }

  /**
   * Mark a task as failed.
   *
   * @param taskId - Task identifier
   * @param error - Error message
   * @returns Failed task progress
   */
  failTask(taskId: string, error: string): TaskProgress {
    const progress = this.getTaskOrThrow(taskId);

    progress.status = 'failed';
    progress.error = error;
    progress.completedAt = new Date();
    progress.updatedAt = new Date();
    progress.elapsedTime = progress.completedAt.getTime() - (progress.startedAt ?? progress.registeredAt).getTime();

    this.emitEvent('task:failed', progress);
    logger.info({ taskId, error }, 'Task failed');
    return progress;
  }

  /**
   * Cancel a task.
   *
   * @param taskId - Task identifier
   * @param reason - Optional cancellation reason
   * @returns Cancelled task progress
   */
  cancelTask(taskId: string, reason?: string): TaskProgress {
    const progress = this.getTaskOrThrow(taskId);

    progress.status = 'cancelled';
    progress.error = reason;
    progress.completedAt = new Date();
    progress.updatedAt = new Date();
    progress.elapsedTime = progress.completedAt.getTime() - (progress.startedAt ?? progress.registeredAt).getTime();

    this.emitEvent('task:cancelled', progress);
    logger.info({ taskId, reason }, 'Task cancelled');
    return progress;
  }

  // --------------------------------------------------------------------------
  // Query Methods
  // --------------------------------------------------------------------------

  /**
   * Get progress for a specific task.
   *
   * @param taskId - Task identifier
   * @returns Task progress or undefined
   */
  getTaskProgress(taskId: string): TaskProgress | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tracked tasks.
   *
   * @returns Array of all task progress entries
   */
  getAllTasks(): TaskProgress[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get all running tasks.
   *
   * @returns Array of running task progress entries
   */
  getRunningTasks(): TaskProgress[] {
    return this.getAllTasks().filter(t => t.status === 'running');
  }

  /**
   * Get tasks filtered by chat ID.
   *
   * @param chatId - Chat ID to filter by
   * @returns Array of matching task progress entries
   */
  getTasksByChatId(chatId: string): TaskProgress[] {
    return this.getAllTasks().filter(t => t.chatId === chatId);
  }

  /**
   * Get a summary of all tasks.
   *
   * @returns Summary object with counts by status
   */
  getSummary(): {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
  } {
    const tasks = this.getAllTasks();
    return {
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'pending').length,
      running: tasks.filter(t => t.status === 'running').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      failed: tasks.filter(t => t.status === 'failed').length,
      cancelled: tasks.filter(t => t.status === 'cancelled').length,
    };
  }

  /**
   * Calculate progress percentage for a task.
   *
   * Uses structured steps if available, otherwise returns based on status.
   *
   * @param taskId - Task identifier
   * @returns Progress percentage (0-100)
   */
  getProgressPercentage(taskId: string): number {
    const progress = this.tasks.get(taskId);
    if (!progress) return 0;

    if (progress.status === 'completed') return 100;
    if (progress.status === 'failed' || progress.status === 'cancelled') {
      return progress.steps.length > 0
        ? Math.round((progress.steps.filter(s => s.status === 'completed').length / progress.steps.length) * 100)
        : 0;
    }

    // Use structured steps if available
    if (progress.steps.length > 0) {
      const completedSteps = progress.steps.filter(s => s.status === 'completed').length;
      return Math.round((completedSteps / progress.steps.length) * 100);
    }

    // Use totalEstimatedSteps if available
    if (progress.totalEstimatedSteps && progress.totalEstimatedSteps > 0) {
      const completedSteps = progress.steps.filter(s => s.status === 'completed').length;
      return Math.min(100, Math.round((completedSteps / progress.totalEstimatedSteps) * 100));
    }

    // Default: 0 for pending, 50 for running
    return progress.status === 'pending' ? 0 : 50;
  }

  // --------------------------------------------------------------------------
  // Event Handling
  // --------------------------------------------------------------------------

  /**
   * Subscribe to task context events.
   *
   * @param eventType - Type of event to listen for, or 'all' for all events
   * @param callback - Event callback
   * @returns Unsubscribe function
   */
  onTaskEvent(
    eventType: TaskContextEventType | 'all',
    callback: (event: TaskContextEvent) => void
  ): () => void {
    const handler = (event: TaskContextEvent) => {
      if (eventType === 'all' || event.type === eventType) {
        callback(event);
      }
    };
    this.on('taskEvent', handler);
    return () => this.off('taskEvent', handler);
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  /**
   * Remove a task from tracking.
   *
   * @param taskId - Task identifier
   * @returns True if task was removed
   */
  removeTask(taskId: string): boolean {
    return this.tasks.delete(taskId);
  }

  /**
   * Clean up completed/failed/cancelled tasks older than a given age.
   *
   * @param maxAge - Maximum age in milliseconds (default: 1 hour)
   * @returns Number of tasks cleaned up
   */
  cleanup(maxAge: number = 3600000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, progress] of this.tasks) {
      if (
        (progress.status === 'completed' || progress.status === 'failed' || progress.status === 'cancelled') &&
        progress.completedAt &&
        now - progress.completedAt.getTime() > maxAge
      ) {
        this.tasks.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug({ count: cleaned }, 'Cleaned up old task records');
    }
    return cleaned;
  }

  /**
   * Clear all tracked tasks.
   */
  clear(): void {
    this.tasks.clear();
    logger.info('All tasks cleared');
  }

  /**
   * Dispose of resources.
   */
  dispose(): void {
    this.removeAllListeners();
    this.tasks.clear();
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private getTaskOrThrow(taskId: string): TaskProgress {
    const progress = this.tasks.get(taskId);
    if (!progress) {
      throw new Error(`Task ${taskId} not found`);
    }
    return progress;
  }

  private emitEvent(type: TaskContextEventType, progress: TaskProgress): void {
    const event: TaskContextEvent = {
      type,
      taskId: progress.taskId,
      progress: { ...progress },
      timestamp: new Date(),
    };
    this.emit('taskEvent', event);
  }

  private evictOldestCompleted(): void {
    const completed = Array.from(this.tasks.entries())
      .filter(([, p]) => p.status === 'completed' || p.status === 'failed' || p.status === 'cancelled')
      .sort(([, a], [, b]) => {
        const aTime = a.completedAt?.getTime() ?? 0;
        const bTime = b.completedAt?.getTime() ?? 0;
        return aTime - bTime;
      });

    // Evict oldest 10% of completed tasks
    const toEvict = Math.max(1, Math.floor(completed.length * 0.1));
    for (let i = 0; i < toEvict && i < completed.length; i++) {
      this.tasks.delete(completed[i][0]);
    }

    logger.debug({ evicted: toEvict }, 'Evicted oldest completed tasks');
  }
}

// ============================================================================
// Global Singleton
// ============================================================================

let globalContext: TaskContext | undefined;

/**
 * Get the global TaskContext instance.
 *
 * @returns TaskContext instance or undefined if not initialized
 */
export function getTaskContext(): TaskContext | undefined {
  return globalContext;
}

/**
 * Initialize the global TaskContext instance.
 *
 * @param maxTasks - Maximum number of tasks to track (default: 1000)
 * @returns TaskContext instance
 */
export function initTaskContext(maxTasks: number = 1000): TaskContext {
  if (globalContext) {
    globalContext.dispose();
  }
  globalContext = new TaskContext(maxTasks);
  logger.info({ maxTasks }, 'Global TaskContext initialized');
  return globalContext;
}

/**
 * Reset the global TaskContext (for testing).
 */
export function resetTaskContext(): void {
  if (globalContext) {
    globalContext.dispose();
  }
  globalContext = undefined;
}
