/**
 * TaskContext - In-memory shared state for running tasks.
 *
 * Provides a singleton store that tracks active deep-task executions,
 * enabling independent Reporter Agents to read task progress without
 * blocking the main task flow.
 *
 * Design (Issue #857):
 * - In-memory store: Fast reads for Agent polling
 * - Event-driven updates: Optional callbacks when task state changes
 * - Zero coupling: Reporter reads status via MCP tool, no direct dependency
 *
 * Lifecycle:
 *   1. ChatAgent creates TaskContext entry when deep-task skill is invoked
 *   2. Task execution loop updates steps/iteration as work progresses
 *   3. Reporter Agent reads status via get_current_task_status MCP tool
 *   4. Entry is cleaned up when task completes or fails
 *
 * @module task/task-context
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskContext');

// ============================================================================
// Types
// ============================================================================

/** Task execution status */
export type TaskContextStatus =
  | 'pending'    // Task created, waiting to start
  | 'running'    // Currently executing
  | 'evaluating' // Evaluator phase active
  | 'executing'  // Executor phase active
  | 'completed'  // Task finished successfully
  | 'failed';    // Task ended with error

/** A single step within a task iteration */
export interface TaskStep {
  /** Step description */
  description: string;
  /** Step status */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** Timestamp when step started */
  startedAt?: string;
  /** Timestamp when step finished */
  finishedAt?: string;
}

/** A task entry in the context store */
export interface TaskContextEntry {
  /** Unique task identifier (typically messageId) */
  taskId: string;
  /** Chat ID where task originated */
  chatId: string;
  /** Short description of the task */
  description: string;
  /** Current overall status */
  status: TaskContextStatus;
  /** Timestamp when task was created */
  createdAt: string;
  /** Timestamp when task started running */
  startedAt?: string;
  /** Timestamp of last update */
  updatedAt: string;
  /** Timestamp when task finished */
  finishedAt?: string;
  /** Description of the current step being executed */
  currentStep?: string;
  /** Completed step descriptions */
  completedSteps: string[];
  /** Total expected steps (if known) */
  totalSteps?: number;
  /** Current iteration number (for evaluate-execute loop) */
  currentIteration?: number;
  /** Total iterations completed */
  totalIterations?: number;
  /** Error message if status is 'failed' */
  error?: string;
}

/** Callback when a task entry is updated */
export type TaskContextUpdateCallback = (entry: TaskContextEntry) => void;

// ============================================================================
// TaskContext Store
// ============================================================================

/**
 * Singleton in-memory store for active task contexts.
 *
 * Thread-safe by design (single-threaded Node.js event loop).
 * Supports optional update callbacks for event-driven patterns.
 */
export class TaskContext {
  private readonly entries = new Map<string, TaskContextEntry>();
  private readonly updateCallbacks: TaskContextUpdateCallback[] = [];

  /**
   * Register a callback to be called whenever a task entry is updated.
   *
   * @param callback - Function called with the updated entry
   * @returns Unsubscribe function
   */
  onUpdate(callback: TaskContextUpdateCallback): () => void {
    this.updateCallbacks.push(callback);
    return () => {
      const index = this.updateCallbacks.indexOf(callback);
      if (index >= 0) {
        this.updateCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Fire update callbacks.
   */
  private fireUpdate(entry: TaskContextEntry): void {
    for (const cb of this.updateCallbacks) {
      try {
        cb(entry);
      } catch (error) {
        logger.error({ err: error, taskId: entry.taskId }, 'Update callback error');
      }
    }
  }

  /**
   * Create a new task context entry.
   *
   * @param taskId - Unique task identifier
   * @param chatId - Chat where task originated
   * @param description - Short task description
   * @returns The created entry
   */
  create(taskId: string, chatId: string, description: string): TaskContextEntry {
    const now = new Date().toISOString();
    const entry: TaskContextEntry = {
      taskId,
      chatId,
      description,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      completedSteps: [],
    };

    this.entries.set(taskId, entry);
    logger.info({ taskId, chatId }, 'Task context created');
    this.fireUpdate(entry);
    return entry;
  }

  /**
   * Update the status of a task.
   *
   * @param taskId - Task identifier
   * @param status - New status
   * @param extra - Optional extra fields to update
   * @returns Updated entry or undefined if not found
   */
  updateStatus(
    taskId: string,
    status: TaskContextStatus,
    extra?: Partial<Pick<TaskContextEntry, 'currentStep' | 'error' | 'currentIteration' | 'totalIterations' | 'totalSteps'>>
  ): TaskContextEntry | undefined {
    const entry = this.entries.get(taskId);
    if (!entry) {
      logger.warn({ taskId }, 'Task not found for status update');
      return undefined;
    }

    const now = new Date().toISOString();
    entry.status = status;
    entry.updatedAt = now;

    if (status === 'running' && !entry.startedAt) {
      entry.startedAt = now;
    }

    if (status === 'completed' || status === 'failed') {
      entry.finishedAt = now;
    }

    if (extra?.currentStep !== undefined) {
      entry.currentStep = extra.currentStep;
    }
    if (extra?.error !== undefined) {
      entry.error = extra.error;
    }
    if (extra?.currentIteration !== undefined) {
      entry.currentIteration = extra.currentIteration;
    }
    if (extra?.totalIterations !== undefined) {
      entry.totalIterations = extra.totalIterations;
    }
    if (extra?.totalSteps !== undefined) {
      entry.totalSteps = extra.totalSteps;
    }

    logger.debug({ taskId, status }, 'Task status updated');
    this.fireUpdate(entry);
    return entry;
  }

  /**
   * Record a completed step for a task.
   *
   * @param taskId - Task identifier
   * @param stepDescription - Description of the completed step
   * @returns Updated entry or undefined if not found
   */
  completeStep(taskId: string, stepDescription: string): TaskContextEntry | undefined {
    const entry = this.entries.get(taskId);
    if (!entry) {
      logger.warn({ taskId }, 'Task not found for step completion');
      return undefined;
    }

    entry.completedSteps.push(stepDescription);
    entry.updatedAt = new Date().toISOString();

    logger.debug({ taskId, step: stepDescription, total: entry.completedSteps.length }, 'Task step completed');
    this.fireUpdate(entry);
    return entry;
  }

  /**
   * Get a task context entry.
   *
   * @param taskId - Task identifier
   * @returns The entry or undefined if not found
   */
  get(taskId: string): TaskContextEntry | undefined {
    return this.entries.get(taskId);
  }

  /**
   * Get the active (non-terminal) task for a given chat.
   *
   * @param chatId - Chat identifier
   * @returns The active task entry or undefined
   */
  getActiveTaskForChat(chatId: string): TaskContextEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.chatId === chatId && entry.status !== 'completed' && entry.status !== 'failed') {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * List all active (non-terminal) tasks.
   *
   * @returns Array of active task entries
   */
  listActive(): TaskContextEntry[] {
    const result: TaskContextEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.status !== 'completed' && entry.status !== 'failed') {
        result.push(entry);
      }
    }
    return result;
  }

  /**
   * List all tasks (including completed/failed).
   *
   * @returns Array of all task entries
   */
  listAll(): TaskContextEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Remove a task entry from the store.
   *
   * @param taskId - Task identifier
   * @returns true if removed, false if not found
   */
  delete(taskId: string): boolean {
    const deleted = this.entries.delete(taskId);
    if (deleted) {
      logger.info({ taskId }, 'Task context deleted');
    }
    return deleted;
  }

  /**
   * Clean up completed/failed tasks older than a given age.
   *
   * @param maxAgeMs - Maximum age in milliseconds (default: 1 hour)
   * @returns Number of entries cleaned up
   */
  cleanup(maxAgeMs: number = 3600000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [taskId, entry] of this.entries) {
      if (
        (entry.status === 'completed' || entry.status === 'failed') &&
        entry.finishedAt
      ) {
        const age = now - new Date(entry.finishedAt).getTime();
        if (age > maxAgeMs) {
          this.entries.delete(taskId);
          cleaned++;
        }
      }
    }

    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up old task contexts');
    }
    return cleaned;
  }

  /**
   * Get the number of entries in the store.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Check if a task exists.
   */
  has(taskId: string): boolean {
    return this.entries.has(taskId);
  }
}

// ============================================================================
// Singleton
// ============================================================================

/** Global singleton TaskContext instance */
let globalTaskContext: TaskContext | undefined;

/**
 * Get the global TaskContext singleton.
 *
 * @returns The global TaskContext instance
 */
export function getTaskContext(): TaskContext {
  if (!globalTaskContext) {
    globalTaskContext = new TaskContext();
    logger.debug('Global TaskContext initialized');
  }
  return globalTaskContext;
}

/**
 * Reset the global TaskContext (for testing).
 */
export function resetTaskContext(): void {
  globalTaskContext = undefined;
}
