/**
 * get_current_task_status MCP tool implementation.
 *
 * Allows Agents (e.g., Reporter Agent) to read the status of running tasks.
 * Part of Issue #857: independent Reporter Agent for task progress reporting.
 *
 * This tool reads from the in-memory TaskContext store and optionally
 * enriches the response with on-disk task metadata (iterations, final result).
 *
 * @module mcp-server/tools/get-task-status
 */

import { getTaskContext, type TaskContextEntry } from '@disclaude/core';

/** Tool input parameters */
export interface GetTaskStatusParams {
  /** Optional: specific task ID. If omitted, returns active task for chatId. */
  taskId?: string;
  /** Optional: chat ID to find active task. Used when taskId is not provided. */
  chatId?: string;
}

/** Summary of a task entry */
export interface TaskSummary {
  taskId: string;
  chatId: string;
  description: string;
  status: string;
  elapsedSeconds?: number;
}

/** Detailed task status */
export interface TaskDetail extends TaskSummary {
  currentStep?: string;
  completedSteps: string[];
  totalSteps?: number;
  currentIteration?: number;
  totalIterations?: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** Tool result */
export interface GetTaskStatusResult {
  success: boolean;
  message: string;
  /** Task status data (present when querying a specific task) */
  task?: TaskDetail;
  /** Summary when listing all active tasks */
  activeTasks?: TaskSummary[];
}

/**
 * Get the current status of a running task.
 *
 * Usage:
 * - Provide taskId to get a specific task's status
 * - Provide chatId to get the active task for that chat
 * - Provide neither to list all active tasks
 *
 * @param params - Tool parameters
 * @returns Task status result
 */
export function get_current_task_status(params: GetTaskStatusParams): GetTaskStatusResult {
  const { taskId, chatId } = params;
  const taskContext = getTaskContext();

  // Case 1: Specific task ID requested
  if (taskId) {
    const entry = taskContext.get(taskId);
    if (!entry) {
      return {
        success: false,
        message: `Task ${taskId} not found`,
      };
    }
    return {
      success: true,
      message: `Task ${taskId} status: ${entry.status}`,
      task: formatTaskEntry(entry),
    };
  }

  // Case 2: Chat ID provided, find active task
  if (chatId) {
    const entry = taskContext.getActiveTaskForChat(chatId);
    if (!entry) {
      return {
        success: false,
        message: `No active task found for chat ${chatId}`,
      };
    }
    return {
      success: true,
      message: `Active task for chat ${chatId}: ${entry.taskId} (${entry.status})`,
      task: formatTaskEntry(entry),
    };
  }

  // Case 3: List all active tasks
  const activeTasks = taskContext.listActive();
  if (activeTasks.length === 0) {
    return {
      success: true,
      message: 'No active tasks',
      activeTasks: [],
    };
  }

  return {
    success: true,
    message: `${activeTasks.length} active task(s)`,
    activeTasks: activeTasks.map(formatTaskSummary),
  };
}

/**
 * Format a TaskContextEntry for tool output.
 */
function formatTaskEntry(entry: TaskContextEntry): TaskDetail {
  const elapsed = entry.startedAt
    ? Math.round((Date.now() - new Date(entry.startedAt).getTime()) / 1000)
    : undefined;

  return {
    taskId: entry.taskId,
    chatId: entry.chatId,
    description: entry.description,
    status: entry.status,
    currentStep: entry.currentStep,
    completedSteps: entry.completedSteps,
    totalSteps: entry.totalSteps,
    currentIteration: entry.currentIteration,
    totalIterations: entry.totalIterations,
    error: entry.error,
    elapsedSeconds: elapsed,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
  };
}

/**
 * Format a summary of a task entry.
 */
function formatTaskSummary(entry: TaskContextEntry): TaskSummary {
  const elapsed = entry.startedAt
    ? Math.round((Date.now() - new Date(entry.startedAt).getTime()) / 1000)
    : undefined;

  return {
    taskId: entry.taskId,
    chatId: entry.chatId,
    description: entry.description,
    status: entry.status,
    elapsedSeconds: elapsed,
  };
}

/**
 * MCP tool schema for get_current_task_status.
 */
export const GET_TASK_STATUS_SCHEMA = {
  name: 'get_current_task_status',
  description: 'Get the current status of a running deep task. Provide taskId for a specific task, chatId for the active task in a chat, or neither to list all active tasks.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      taskId: {
        type: 'string',
        description: 'Specific task ID to query',
      },
      chatId: {
        type: 'string',
        description: 'Chat ID to find the active task for',
      },
    },
  },
};
