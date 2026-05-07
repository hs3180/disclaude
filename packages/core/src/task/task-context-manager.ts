/**
 * TaskContextManager - manages TaskContext files for deep task progress tracking.
 *
 * Responsibilities:
 * - Create initial TaskContext when a deep task starts
 * - Update context as the task progresses through phases
 * - Read context for Reporter Agent consumption
 * - List active tasks (running or pending)
 * - Clean up context on task completion
 *
 * Uses TaskFileManager for directory structure consistency.
 *
 * @module task/task-context-manager
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import {
  TaskFileManager,
  type TaskFileManagerConfig,
} from './task-files.js';
import type {
  TaskContext,
  TaskPhase,
  CreateTaskContextOptions,
  UpdateTaskContextOptions,
  TaskMetrics,
} from './task-context.js';

const logger = createLogger('TaskContextManager');

/**
 * Default task context with sensible initial values.
 */
function createDefaultMetrics(): TaskMetrics {
  return {
    filesModified: 0,
    testsRun: 0,
    testsPassed: 0,
    toolsInvoked: 0,
  };
}

/**
 * Manages TaskContext files for deep task progress reporting.
 *
 * Works alongside TaskFileManager — both operate on the same
 * `tasks/{taskId}/` directory structure:
 * - TaskFileManager manages markdown files (task.md, evaluation.md, etc.)
 * - TaskContextManager manages task-context.json (machine-readable state)
 *
 * @example
 * ```typescript
 * const manager = new TaskContextManager({ workspaceDir: '/workspace' });
 *
 * // Create context when task starts
 * await manager.createContext({
 *   taskId: 'om_abc123',
 *   chatId: 'oc_chat456',
 *   title: 'Fix login bug',
 *   description: 'Fix the authentication timeout issue',
 * });
 *
 * // Update during execution
 * await manager.updateContext('om_abc123', {
 *   phase: 'execution',
 *   currentStep: 'Modifying auth.service.ts',
 *   plannedSteps: ['Run tests', 'Update documentation'],
 * });
 *
 * // Read for reporting
 * const context = await manager.getContext('om_abc123');
 *
 * // Mark complete
 * await manager.updateContext('om_abc123', {
 *   status: 'completed',
 *   phase: 'completed',
 *   completedAt: new Date().toISOString(),
 * });
 * ```
 */
export class TaskContextManager {
  private readonly fileManager: TaskFileManager;

  constructor(config: TaskFileManagerConfig) {
    this.fileManager = new TaskFileManager(config);
  }

  /**
   * Get the path to task-context.json for a given task.
   *
   * @param taskId - Task identifier
   * @returns Absolute path to task-context.json
   */
  getContextPath(taskId: string): string {
    return path.join(this.fileManager.getTaskDir(taskId), 'task-context.json');
  }

  /**
   * Create initial TaskContext for a new deep task.
   *
   * Sets status to 'pending' and phase to 'definition'.
   * Call updateContext() to transition to 'running' when execution starts.
   *
   * @param options - Task creation options
   * @returns The created TaskContext
   */
  async createContext(options: CreateTaskContextOptions): Promise<TaskContext> {
    await this.fileManager.initializeTask(options.taskId);

    const now = new Date().toISOString();

    const context: TaskContext = {
      version: 1,
      taskId: options.taskId,
      chatId: options.chatId,
      status: 'pending',
      phase: 'definition',
      title: options.title,
      description: options.description,
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      completedAt: null,
      currentIteration: 0,
      totalIterations: 0,
      currentStep: null,
      completedSteps: [],
      plannedSteps: [],
      metrics: createDefaultMetrics(),
      error: null,
    };

    await this.writeContext(options.taskId, context);
    logger.info({ taskId: options.taskId }, 'TaskContext created');
    return context;
  }

  /**
   * Update an existing TaskContext.
   *
   * Only provided fields will be updated. The updatedAt timestamp
   * is always refreshed.
   *
   * Special handling:
   * - Setting status to 'running' auto-sets startedAt if not set
   * - Setting status to 'completed' or 'failed' auto-sets completedAt and phase
   * - currentStep changes are recorded in completedSteps
   *
   * @param taskId - Task identifier
   * @param updates - Partial updates to apply
   * @returns Updated TaskContext, or null if not found
   */
  async updateContext(
    taskId: string,
    updates: UpdateTaskContextOptions
  ): Promise<TaskContext | null> {
    const context = await this.getContext(taskId);
    if (!context) {
      logger.warn({ taskId }, 'Cannot update: TaskContext not found');
      return null;
    }

    const now = new Date().toISOString();

    // Track step completion: if currentStep is changing, record the old step
    if (updates.currentStep !== undefined && context.currentStep !== null) {
      if (updates.currentStep !== context.currentStep) {
        context.completedSteps.push({
          description: context.currentStep,
          startedAt: context.updatedAt,
          completedAt: now,
          status: 'completed',
        });
      }
    }

    // Apply updates
    if (updates.status !== undefined) {context.status = updates.status;}
    if (updates.phase !== undefined) {context.phase = updates.phase;}
    if (updates.currentIteration !== undefined) {context.currentIteration = updates.currentIteration;}
    if (updates.currentStep !== undefined) {context.currentStep = updates.currentStep;}
    if (updates.plannedSteps !== undefined) {context.plannedSteps = updates.plannedSteps;}
    if (updates.error !== undefined) {context.error = updates.error;}

    // Merge metrics
    if (updates.metrics !== undefined) {
      context.metrics = {
        ...context.metrics,
        ...updates.metrics,
      };
    }

    // Auto-set startedAt when transitioning to running
    if (updates.status === 'running' && context.startedAt === null) {
      context.startedAt = now;
    }

    // Auto-set completedAt and phase for terminal states
    if (updates.status === 'completed') {
      context.completedAt = updates.completedAt ?? now;
      context.phase = 'completed';
      context.currentStep = null;
    } else if (updates.status === 'failed') {
      context.completedAt = updates.completedAt ?? now;
      context.phase = 'failed';
      context.currentStep = null;
    } else if (updates.completedAt !== undefined) {
      context.completedAt = updates.completedAt;
    }

    context.updatedAt = now;

    await this.writeContext(taskId, context);
    logger.debug({ taskId, status: context.status, phase: context.phase }, 'TaskContext updated');
    return context;
  }

  /**
   * Transition to a new iteration.
   *
   * Increments iteration count and updates phase.
   *
   * @param taskId - Task identifier
   * @param phase - New phase (typically 'evaluation' or 'execution')
   * @returns Updated TaskContext
   */
  async startIteration(
    taskId: string,
    phase: TaskPhase
  ): Promise<TaskContext | null> {
    const context = await this.getContext(taskId);
    if (!context) {return null;}

    context.currentIteration++;
    context.totalIterations = context.currentIteration;
    context.phase = phase;
    context.updatedAt = new Date().toISOString();

    await this.writeContext(taskId, context);
    logger.info({
      taskId,
      iteration: context.currentIteration,
      phase,
    }, 'New iteration started');
    return context;
  }

  /**
   * Record a step completion explicitly.
   *
   * @param taskId - Task identifier
   * @param stepDescription - Description of the completed step
   * @param status - Step status (default: 'completed')
   */
  async recordStep(
    taskId: string,
    stepDescription: string,
    status: 'completed' | 'failed' | 'skipped' = 'completed'
  ): Promise<void> {
    const context = await this.getContext(taskId);
    if (!context) {return;}

    context.completedSteps.push({
      description: stepDescription,
      startedAt: context.updatedAt,
      completedAt: new Date().toISOString(),
      status,
    });
    context.updatedAt = new Date().toISOString();

    await this.writeContext(taskId, context);
    logger.debug({ taskId, step: stepDescription, status }, 'Step recorded');
  }

  /**
   * Increment metrics counters.
   *
   * @param taskId - Task identifier
   * @param delta - Metric increments to apply
   */
  async incrementMetrics(
    taskId: string,
    delta: Partial<TaskMetrics>
  ): Promise<void> {
    const context = await this.getContext(taskId);
    if (!context) {return;}

    if (delta.filesModified) {context.metrics.filesModified += delta.filesModified;}
    if (delta.testsRun) {context.metrics.testsRun += delta.testsRun;}
    if (delta.testsPassed) {context.metrics.testsPassed += delta.testsPassed;}
    if (delta.toolsInvoked) {context.metrics.toolsInvoked += delta.toolsInvoked;}
    context.updatedAt = new Date().toISOString();

    await this.writeContext(taskId, context);
  }

  /**
   * Read TaskContext for a task.
   *
   * @param taskId - Task identifier
   * @returns TaskContext or null if not found
   */
  async getContext(taskId: string): Promise<TaskContext | null> {
    const contextPath = this.getContextPath(taskId);

    try {
      const data = await fs.readFile(contextPath, 'utf-8');
      return JSON.parse(data) as TaskContext;
    } catch {
      // File doesn't exist or is invalid JSON
      return null;
    }
  }

  /**
   * List all tasks that have a TaskContext.
   *
   * @param filter - Optional filter for task status
   * @returns Array of TaskContext objects
   */
  async listContexts(
    filter?: { status?: TaskContext['status'] }
  ): Promise<TaskContext[]> {
    const tasksDir = this.fileManager.getTaskDir('').replace(/\/tasks\/?$/, '/tasks');

    try {
      const entries = await fs.readdir(tasksDir, { withFileTypes: true });
      const contexts: TaskContext[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) {continue;}

        const contextPath = path.join(tasksDir, entry.name, 'task-context.json');
        try {
          const data = await fs.readFile(contextPath, 'utf-8');
          const ctx = JSON.parse(data) as TaskContext;

          if (!filter || filter.status === undefined || ctx.status === filter.status) {
            contexts.push(ctx);
          }
        } catch {
          // Skip tasks without task-context.json
        }
      }

      return contexts;
    } catch {
      return [];
    }
  }

  /**
   * List active (pending or running) tasks.
   *
   * @returns Array of active TaskContext objects
   */
  async listActiveTasks(): Promise<TaskContext[]> {
    const allContexts = await this.listContexts();
    return allContexts.filter(ctx => ctx.status === 'pending' || ctx.status === 'running');
  }

  /**
   * Calculate elapsed time for a task.
   *
   * @param context - Task context
   * @returns Elapsed milliseconds, or null if not started
   */
  getElapsedTime(context: TaskContext): number | null {
    if (!context.startedAt) {return null;}

    const end = context.completedAt
      ? new Date(context.completedAt).getTime()
      : Date.now();
    return end - new Date(context.startedAt).getTime();
  }

  /**
   * Format elapsed time as human-readable string.
   *
   * @param ms - Elapsed milliseconds
   * @returns Formatted string like "2m 30s"
   */
  formatElapsedTime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }

  /**
   * Write TaskContext to disk.
   *
   * @param taskId - Task identifier
   * @param context - TaskContext to write
   */
  private async writeContext(taskId: string, context: TaskContext): Promise<void> {
    const contextPath = this.getContextPath(taskId);

    try {
      await fs.writeFile(contextPath, JSON.stringify(context, null, 2), 'utf-8');
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to write TaskContext');
      throw error;
    }
  }
}
