/**
 * get_task_status tool implementation.
 *
 * Allows agents to read task progress information from the shared TaskContext.
 * Used by Reporter Agents to monitor running tasks and generate progress reports.
 *
 * Issue #857: Foundation for Independent Reporter Agent design.
 *
 * @module mcp-server/tools/task-status
 */

import { createLogger, getTaskContext, initTaskContext, type TaskProgress } from '@disclaude/core';
import type { TaskStatusResult } from './types.js';

const logger = createLogger('TaskStatus');

/**
 * Get task status from the shared TaskContext.
 *
 * @param params.taskId - Optional task ID to query specific task
 * @param params.chatId - Optional chat ID to filter tasks
 * @param params.includeCompleted - Whether to include completed tasks (default: true)
 * @returns Task status information
 */
export async function get_task_status(params: {
  taskId?: string;
  chatId?: string;
  includeCompleted?: boolean;
}): Promise<TaskStatusResult> {
  const { taskId, chatId, includeCompleted = true } = params;

  logger.debug({ taskId, chatId, includeCompleted }, 'get_task_status called');

  try {
    // Ensure TaskContext is initialized
    let ctx = getTaskContext();
    if (!ctx) {
      ctx = initTaskContext();
    }

    // Query specific task
    if (taskId) {
      const progress = ctx.getTaskProgress(taskId);
      if (!progress) {
        return {
          success: false,
          message: `Task ${taskId} not found`,
          tasks: [],
          summary: ctx.getSummary(),
        };
      }

      const percentage = ctx.getProgressPercentage(taskId);
      return {
        success: true,
        message: `Task ${taskId}: ${progress.status}`,
        tasks: [formatTaskProgress(progress, percentage)],
        summary: ctx.getSummary(),
      };
    }

    // Query by chat ID
    let tasks = chatId
      ? ctx.getTasksByChatId(chatId)
      : ctx.getAllTasks();

    // Filter completed/failed/cancelled unless requested
    if (!includeCompleted) {
      tasks = tasks.filter((t: TaskProgress) => t.status === 'running' || t.status === 'pending');
    }

    const formattedTasks = tasks.map((t: TaskProgress) => ({
      ...formatTaskProgress(t, ctx!.getProgressPercentage(t.taskId)),
    }));

    return {
      success: true,
      message: tasks.length > 0
        ? `Found ${tasks.length} task(s)`
        : 'No tasks found',
      tasks: formattedTasks,
      summary: ctx.getSummary(),
    };

  } catch (error) {
    logger.error({ err: error, taskId }, 'get_task_status FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      message: `Failed to get task status: ${errorMessage}`,
      tasks: [],
      summary: { total: 0, pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
    };
  }
}

/**
 * Format TaskProgress for tool output.
 */
function formatTaskProgress(
  progress: TaskProgress,
  percentage: number
): {
  taskId: string;
  description: string;
  status: string;
  currentStep: string;
  progress: number;
  elapsedTime: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  stepsCompleted: number;
  stepsTotal: number;
} {
  return {
    taskId: progress.taskId,
    description: progress.description,
    status: progress.status,
    currentStep: progress.currentStep,
    progress: percentage,
    elapsedTime: progress.elapsedTime,
    startedAt: progress.startedAt?.toISOString(),
    completedAt: progress.completedAt?.toISOString(),
    error: progress.error,
    stepsCompleted: progress.steps.filter((s) => s.status === 'completed').length,
    stepsTotal: progress.steps.length,
  };
}
