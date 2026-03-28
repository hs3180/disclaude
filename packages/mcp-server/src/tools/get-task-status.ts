/**
 * get_task_status tool implementation.
 *
 * Reads task status from the file-based task management system.
 * Issue #857: Provides task state information for the Reporter Agent
 * to make intelligent progress reporting decisions.
 *
 * @module mcp-server/tools/get-task-status
 */

import { createLogger } from '@disclaude/core';
import { TaskFileManager } from '@disclaude/core';
import { getWorkspaceDir } from './credentials.js';
import type { TaskStatusInfo } from './types.js';

const logger = createLogger('GetTaskStatus');

export interface GetTaskStatusResult {
  success: boolean;
  message: string;
  task?: TaskStatusInfo;
  tasks?: TaskStatusInfo[];
  error?: string;
}

/**
 * Get status of a specific task or list all tasks.
 *
 * @param params.taskId - Optional task ID. If not provided, lists all tasks.
 * @returns Task status information
 */
export async function get_task_status(params: {
  taskId?: string;
}): Promise<GetTaskStatusResult> {
  const { taskId } = params;
  const workspaceDir = getWorkspaceDir();
  const fileManager = new TaskFileManager({ workspaceDir });

  try {
    if (taskId) {
      // Get specific task status
      const taskStatus = await fileManager.getTaskStatus(taskId);
      logger.info({ taskId, status: taskStatus.status }, 'Task status retrieved');

      if (taskStatus.status === 'not_found') {
        return {
          success: false,
          message: `Task "${taskId}" not found`,
          task: taskStatus,
        };
      }

      return {
        success: true,
        message: formatTaskStatus(taskStatus),
        task: taskStatus,
      };
    } else {
      // List all tasks
      const allTaskIds = await fileManager.listAllTasks();

      if (allTaskIds.length === 0) {
        return {
          success: true,
          message: 'No tasks found in workspace',
          tasks: [],
        };
      }

      // Get status for each task (limited to avoid excessive reads)
      const tasks: TaskStatusInfo[] = [];
      for (const id of allTaskIds.slice(0, 50)) {
        const status = await fileManager.getTaskStatus(id);
        tasks.push(status);
      }

      // Sort by status priority: running > pending > completed > failed
      const statusOrder: Record<string, number> = {
        running: 0,
        pending: 1,
        failed: 2,
        completed: 3,
        not_found: 4,
      };
      tasks.sort((a, b) => (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5));

      const summary = tasks.map(t =>
        `[${statusEmoji(t.status)}] ${t.title || t.taskId} (${t.status})`
      ).join('\n');

      return {
        success: true,
        message: `Found ${tasks.length} task(s):\n${summary}`,
        tasks,
      };
    }
  } catch (error) {
    logger.error({ err: error, taskId }, 'get_task_status FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: errorMessage,
      message: `Failed to get task status: ${errorMessage}`,
    };
  }
}

/**
 * Format task status as human-readable text.
 */
function formatTaskStatus(task: TaskStatusInfo): string {
  const lines: string[] = [];
  lines.push(`${statusEmoji(task.status)} Task: ${task.title || task.taskId}`);
  lines.push(`Status: ${task.status}`);

  if (task.description) {
    lines.push(`Description: ${task.description.substring(0, 200)}`);
  }

  if (task.createdAt) {
    lines.push(`Created: ${task.createdAt}`);
  }

  if (task.elapsedSeconds !== null) {
    const minutes = Math.floor(task.elapsedSeconds / 60);
    const seconds = task.elapsedSeconds % 60;
    lines.push(`Elapsed: ${minutes}m ${seconds}s`);
  }

  lines.push(`Iterations: ${task.totalIterations}`);
  lines.push(`Latest iteration: ${task.latestIteration || 'N/A'}`);

  return lines.join('\n');
}

/**
 * Get status emoji for task state.
 */
function statusEmoji(status: string): string {
  switch (status) {
    case 'running': return '🔄';
    case 'completed': return '✅';
    case 'failed': return '❌';
    case 'pending': return '⏳';
    default: return '❓';
  }
}
