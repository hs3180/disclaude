/**
 * get_current_task_status tool implementation.
 *
 * This tool provides the Reporter Agent with access to current deep task status.
 * Part of Issue #857: Independent Reporter Agent for progress reporting.
 *
 * @module mcp-server/tools/task-status
 */

import { createLogger, TaskContext, type TaskContextInfo } from '@disclaude/core';

const logger = createLogger('TaskStatus');

/**
 * Result type for get_current_task_status tool.
 */
export interface TaskStatusResult {
  success: boolean;
  hasActiveTask: boolean;
  task?: TaskContextInfo;
  formattedStatus?: string;
  error?: string;
}

/**
 * Get the current active task status.
 *
 * This tool allows the Reporter Agent to query the current task state
 * and decide when/if to send progress updates.
 *
 * @returns Current task status information
 */
export async function get_current_task_status(): Promise<TaskStatusResult> {
  logger.debug('get_current_task_status called');

  try {
    // Update elapsed time for active tasks
    const activeTask = TaskContext.getActive();
    if (activeTask) {
      TaskContext.updateElapsedTime(activeTask.taskId);
    }

    // Get fresh context after update
    const task = TaskContext.getActive();

    if (!task) {
      logger.debug('No active task found');
      return {
        success: true,
        hasActiveTask: false,
      };
    }

    const formattedStatus = TaskContext.formatStatus(task);

    logger.debug({
      taskId: task.taskId,
      status: task.status,
      iteration: task.currentIteration,
    }, 'Active task found');

    return {
      success: true,
      hasActiveTask: true,
      task,
      formattedStatus,
    };
  } catch (error) {
    logger.error({ err: error }, 'get_current_task_status failed');
    return {
      success: false,
      hasActiveTask: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get all active tasks.
 *
 * @returns List of all active tasks
 */
export async function get_all_active_tasks(): Promise<TaskStatusResult> {
  logger.debug('get_all_active_tasks called');

  try {
    const tasks = TaskContext.getAll();

    if (tasks.length === 0) {
      return {
        success: true,
        hasActiveTask: false,
      };
    }

    // Format all tasks
    const formattedStatus = tasks.map(task => {
      TaskContext.updateElapsedTime(task.taskId);
      return TaskContext.formatStatus(TaskContext.get(task.taskId)!);
    }).join('\n\n---\n\n');

    return {
      success: true,
      hasActiveTask: true,
      task: tasks[0], // Primary task
      formattedStatus,
    };
  } catch (error) {
    logger.error({ err: error }, 'get_all_active_tasks failed');
    return {
      success: false,
      hasActiveTask: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
