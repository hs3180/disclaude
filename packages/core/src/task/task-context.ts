/**
 * TaskContext - Shared task state for inter-agent communication.
 *
 * This module implements the Task Context data structure as described in Issue #857:
 * Provides a mechanism for the Reporter Agent to read current deep task information.
 *
 * Architecture:
 * ┌─────────────────┐     ┌──────────────────┐
 * │   Deep Task     │────▶│  Task Context    │
 * │   (主任务)       │     │  (共享状态)       │
 * └─────────────────┘     └────────┬─────────┘
 *                                  │
 *                                  ▼
 *                         ┌──────────────────┐
 *                         │  Reporter Agent  │
 *                         │  (独立汇报 Agent) │
 *                         └────────┬─────────┘
 *                                  │
 *                                  ▼
 *                         ┌──────────────────┐
 *                         │   用户通知        │
 *                         └──────────────────┘
 *
 * @module task/task-context
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskContext');

/**
 * Status of a task.
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Phase of task execution.
 */
export type TaskPhase = 'evaluate' | 'execute' | 'reflect' | 'idle';

/**
 * Information about a single iteration.
 */
export interface IterationInfo {
  /** Iteration number (1-indexed) */
  number: number;
  /** Phase currently executing */
  currentPhase: TaskPhase;
  /** When this iteration started */
  startTime: Date;
  /** Duration in milliseconds (0 if still running) */
  durationMs: number;
  /** Any error that occurred */
  error?: string;
}

/**
 * Current task context information.
 */
export interface TaskContextInfo {
  /** Task ID (typically message ID) */
  taskId: string;
  /** Chat ID for sending messages */
  chatId: string;
  /** Current status */
  status: TaskStatus;
  /** Task title/description (first line of original request) */
  title: string;
  /** When the task was created */
  createdAt: Date;
  /** When the task started executing */
  startedAt?: Date;
  /** When the task completed */
  completedAt?: Date;
  /** Total elapsed time in milliseconds */
  elapsedMs: number;
  /** Current iteration number (0 if not started) */
  currentIteration: number;
  /** Maximum iterations allowed */
  maxIterations: number;
  /** Current phase */
  currentPhase: TaskPhase;
  /** List of completed iterations */
  iterations: IterationInfo[];
  /** Current step being executed (if any) */
  currentStep?: string;
  /** Progress percentage (0-100) */
  progressPercent: number;
  /** ETA in seconds (estimated time remaining) */
  etaSeconds?: number;
  /** Any error message */
  errorMessage?: string;
  /** Path to task.md */
  taskMdPath: string;
}

/**
 * Global task context registry.
 * Stores context for all active tasks.
 */
class TaskContextRegistry {
  private contexts: Map<string, TaskContextInfo> = new Map();
  private activeTaskId: string | null = null;

  /**
   * Register a new task context.
   */
  register(context: TaskContextInfo): void {
    this.contexts.set(context.taskId, context);
    this.activeTaskId = context.taskId;
    logger.debug({ taskId: context.taskId }, 'Task context registered');
  }

  /**
   * Update an existing task context.
   */
  update(taskId: string, updates: Partial<TaskContextInfo>): void {
    const existing = this.contexts.get(taskId);
    if (existing) {
      this.contexts.set(taskId, { ...existing, ...updates });
      logger.debug({ taskId, updates: Object.keys(updates) }, 'Task context updated');
    }
  }

  /**
   * Get context for a specific task.
   */
  get(taskId: string): TaskContextInfo | undefined {
    return this.contexts.get(taskId);
  }

  /**
   * Get the currently active task (if any).
   */
  getActive(): TaskContextInfo | undefined {
    if (this.activeTaskId) {
      return this.contexts.get(this.activeTaskId);
    }
    return undefined;
  }

  /**
   * Get all active tasks.
   */
  getAll(): TaskContextInfo[] {
    return Array.from(this.contexts.values()).filter(
      ctx => ctx.status === 'running' || ctx.status === 'pending'
    );
  }

  /**
   * Mark a task as completed and remove from active list.
   */
  complete(taskId: string): void {
    const context = this.contexts.get(taskId);
    if (context) {
      this.contexts.set(taskId, {
        ...context,
        status: 'completed',
        completedAt: new Date(),
      });
      if (this.activeTaskId === taskId) {
        this.activeTaskId = null;
      }
      logger.debug({ taskId }, 'Task context marked as completed');
    }
  }

  /**
   * Mark a task as failed.
   */
  fail(taskId: string, error: string): void {
    const context = this.contexts.get(taskId);
    if (context) {
      this.contexts.set(taskId, {
        ...context,
        status: 'failed',
        errorMessage: error,
        completedAt: new Date(),
      });
      if (this.activeTaskId === taskId) {
        this.activeTaskId = null;
      }
      logger.debug({ taskId, error }, 'Task context marked as failed');
    }
  }

  /**
   * Remove a task context (cleanup).
   */
  remove(taskId: string): void {
    this.contexts.delete(taskId);
    if (this.activeTaskId === taskId) {
      this.activeTaskId = null;
    }
    logger.debug({ taskId }, 'Task context removed');
  }

  /**
   * Clear all completed/failed tasks (cleanup old contexts).
   */
  cleanup(): number {
    let cleaned = 0;
    for (const [taskId, context] of this.contexts.entries()) {
      if (context.status === 'completed' || context.status === 'failed' || context.status === 'cancelled') {
        this.contexts.delete(taskId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug({ cleaned }, 'Cleaned up completed task contexts');
    }
    return cleaned;
  }
}

// Global singleton registry
const globalRegistry = new TaskContextRegistry();

/**
 * TaskContext - Manages shared task state for the Reporter Agent.
 *
 * Usage:
 * 1. At task start: TaskContext.start(taskId, chatId, title, taskMdPath)
 * 2. During execution: TaskContext.updatePhase(taskId, phase, step?)
 * 3. On iteration change: TaskContext.startIteration(taskId, number)
 * 4. At task end: TaskContext.complete(taskId) or TaskContext.fail(taskId, error)
 * 5. Reporter Agent: TaskContext.getActive() to get current status
 */
export const TaskContext = {
  /**
   * Start a new task context.
   */
  start(
    taskId: string,
    chatId: string,
    title: string,
    taskMdPath: string,
    maxIterations: number = 20
  ): TaskContextInfo {
    const now = new Date();
    const context: TaskContextInfo = {
      taskId,
      chatId,
      status: 'running',
      title,
      createdAt: now,
      startedAt: now,
      elapsedMs: 0,
      currentIteration: 0,
      maxIterations,
      currentPhase: 'idle',
      iterations: [],
      progressPercent: 0,
      taskMdPath,
    };
    globalRegistry.register(context);
    return context;
  },

  /**
   * Update the current phase of execution.
   */
  updatePhase(taskId: string, phase: TaskPhase, step?: string): void {
    globalRegistry.update(taskId, {
      currentPhase: phase,
      currentStep: step,
    });
  },

  /**
   * Start a new iteration.
   */
  startIteration(taskId: string, iteration: number): void {
    const iterationInfo: IterationInfo = {
      number: iteration,
      currentPhase: 'evaluate',
      startTime: new Date(),
      durationMs: 0,
    };
    const context = globalRegistry.get(taskId);
    if (context) {
      const iterations = [...context.iterations, iterationInfo];
      const progressPercent = Math.round((iteration / context.maxIterations) * 100);
      globalRegistry.update(taskId, {
        currentIteration: iteration,
        iterations,
        progressPercent: Math.min(progressPercent, 95), // Cap at 95% until complete
      });
    }
  },

  /**
   * Complete current iteration phase.
   */
  completeIterationPhase(taskId: string, phase: TaskPhase, durationMs: number): void {
    const context = globalRegistry.get(taskId);
    if (context && context.iterations.length > 0) {
      const iterations = [...context.iterations];
      const lastIteration = iterations[iterations.length - 1];
      if (phase === 'evaluate') {
        lastIteration.currentPhase = 'execute';
      } else if (phase === 'execute') {
        lastIteration.durationMs = durationMs;
      }
      globalRegistry.update(taskId, { iterations });
    }
  },

  /**
   * Update elapsed time.
   */
  updateElapsedTime(taskId: string): void {
    const context = globalRegistry.get(taskId);
    if (context && context.startedAt) {
      const elapsedMs = Date.now() - context.startedAt.getTime();

      // Calculate ETA based on average iteration time
      let etaSeconds: number | undefined;
      if (context.iterations.length > 0 && context.currentIteration > 0) {
        const avgIterationMs = elapsedMs / context.currentIteration;
        const remainingIterations = context.maxIterations - context.currentIteration;
        etaSeconds = Math.round((avgIterationMs * remainingIterations) / 1000);
      }

      globalRegistry.update(taskId, { elapsedMs, etaSeconds });
    }
  },

  /**
   * Mark task as completed.
   */
  complete(taskId: string): void {
    globalRegistry.update(taskId, {
      status: 'completed',
      completedAt: new Date(),
      progressPercent: 100,
      currentPhase: 'idle',
    });
  },

  /**
   * Mark task as failed.
   */
  fail(taskId: string, error: string): void {
    globalRegistry.fail(taskId, error);
  },

  /**
   * Mark task as cancelled.
   */
  cancel(taskId: string): void {
    globalRegistry.update(taskId, {
      status: 'cancelled',
      completedAt: new Date(),
      currentPhase: 'idle',
    });
  },

  /**
   * Get context for a specific task.
   */
  get(taskId: string): TaskContextInfo | undefined {
    return globalRegistry.get(taskId);
  },

  /**
   * Get the currently active task.
   */
  getActive(): TaskContextInfo | undefined {
    return globalRegistry.getActive();
  },

  /**
   * Get all active tasks.
   */
  getAll(): TaskContextInfo[] {
    return globalRegistry.getAll();
  },

  /**
   * Remove a task context.
   */
  remove(taskId: string): void {
    globalRegistry.remove(taskId);
  },

  /**
   * Cleanup completed tasks.
   */
  cleanup(): number {
    return globalRegistry.cleanup();
  },

  /**
   * Format task status for human-readable output.
   */
  formatStatus(context: TaskContextInfo): string {
    const elapsed = formatDuration(context.elapsedMs);
    const eta = context.etaSeconds ? formatDuration(context.etaSeconds * 1000) : 'unknown';
    const progressBar = createProgressBar(context.progressPercent);

    let status = `📊 **Task Status Report**\n\n`;
    status += `**Task ID**: ${context.taskId}\n`;
    status += `**Title**: ${context.title}\n`;
    status += `**Status**: ${getStatusEmoji(context.status)} ${context.status}\n`;
    status += `**Phase**: ${context.currentPhase}\n`;
    status += `**Iteration**: ${context.currentIteration}/${context.maxIterations}\n`;
    status += `**Progress**: ${progressBar} ${context.progressPercent}%\n`;
    status += `**Elapsed**: ${elapsed}\n`;
    if (context.status === 'running' && context.etaSeconds) {
      status += `**ETA**: ~${eta}\n`;
    }
    if (context.currentStep) {
      status += `**Current Step**: ${context.currentStep}\n`;
    }
    if (context.errorMessage) {
      status += `**Error**: ❌ ${context.errorMessage}\n`;
    }
    return status;
  },
};

/**
 * Format duration in human-readable format.
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Create a text progress bar.
 */
function createProgressBar(percent: number, width: number = 10): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Get emoji for task status.
 */
function getStatusEmoji(status: TaskStatus): string {
  switch (status) {
    case 'pending': return '⏳';
    case 'running': return '🔄';
    case 'completed': return '✅';
    case 'failed': return '❌';
    case 'cancelled': return '🚫';
    default: return '❓';
  }
}

// Re-export types
export type { TaskStatus as TaskContextStatus, TaskPhase as TaskContextPhase };
