/**
 * get_task_status tool implementation.
 *
 * Reads the current status of a task from the workspace task files.
 * This tool is used by the Reporter Agent (task-progress skill)
 * to intelligently decide when and what to report to the user.
 *
 * Issue #857: Provides task context for the independent Reporter Agent.
 * Unlike fixed-rule progress reporting (rejected PR #1262), this tool
 * exposes raw task state so the Agent can make intelligent decisions.
 *
 * @module mcp-server/tools/get-task-status
 */

import { createLogger, TaskStatusReader } from '@disclaude/core';
import { getWorkspaceDir } from './credentials.js';
import type { GetTaskStatusResult } from './types.js';

const logger = createLogger('GetTaskStatus');

/**
 * Get the current status of a task.
 *
 * @param params.taskId - Task identifier (typically the message ID).
 *                        If not provided, returns a list of all task IDs.
 * @returns Task status information or list of task IDs
 */
export async function get_task_status(params: {
  taskId?: string;
}): Promise<GetTaskStatusResult> {
  const { taskId } = params;

  logger.info({ taskId: taskId ?? 'all' }, 'get_task_status called');

  try {
    const workspaceDir = getWorkspaceDir();
    const reader = new TaskStatusReader({ workspaceDir });

    // If no taskId provided, list all available tasks
    if (!taskId) {
      const taskIds = await reader.listTaskIds();

      if (taskIds.length === 0) {
        return {
          success: true,
          message: 'No tasks found in workspace',
          tasks: [],
        };
      }

      return {
        success: true,
        message: `Found ${taskIds.length} task(s)`,
        tasks: taskIds.map(id => ({ taskId: id })),
      };
    }

    // Get specific task status
    const status = await reader.getTaskStatus(taskId);

    if (status.status === 'unknown') {
      return {
        success: false,
        message: `Task not found: ${taskId}`,
        error: 'task_not_found',
      };
    }

    return {
      success: true,
      message: `Task status: ${status.status}`,
      task: status,
    };
  } catch (error) {
    logger.error({ err: error, taskId }, 'get_task_status FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      message: `Failed to get task status: ${errorMessage}`,
      error: errorMessage,
    };
  }
}
