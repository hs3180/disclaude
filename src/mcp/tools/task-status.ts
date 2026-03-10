/**
 * Task Status Tool - MCP tool for reading current task status.
 *
 * Issue #857: Reporter Agent needs to read task status for intelligent reporting.
 *
 * @module mcp/tools/task-status
 */

import { z } from 'zod';
import { getTaskStateManager } from '../../utils/task-state-manager.js';
import { taskProgressService } from '../../agents/task-progress-service.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('TaskStatusTool');

/**
 * Task status result for MCP tool response.
 */
export interface TaskStatusResult {
  success: boolean;
  message: string;
  task?: {
    id: string;
    prompt: string;
    status: string;
    progress: number;
    currentStep?: string;
    createdAt: string;
    updatedAt: string;
    elapsedSeconds?: number;
    estimatedSecondsRemaining?: number;
    error?: string;
  };
}

/**
 * Get current task status.
 *
 * Returns information about the currently running task, including:
 * - Task ID and description
 * - Current status (running, paused, completed, cancelled, error)
 * - Progress percentage
 * - Current step description
 * - Time elapsed
 * - Estimated time remaining (if available)
 *
 * @returns Task status result
 */
export async function get_current_task_status(): Promise<TaskStatusResult> {
  try {
    const taskStateManager = getTaskStateManager();
    const currentTask = await taskStateManager.getCurrentTask();

    if (!currentTask) {
      return {
        success: true,
        message: 'No active task found.',
      };
    }

    // Calculate elapsed time
    const startTime = new Date(currentTask.createdAt).getTime();
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);

    // Try to get progress info from TaskProgressService
    let estimatedSecondsRemaining: number | undefined;
    const activeProgress = taskProgressService.getActiveTask(currentTask.chatId);
    if (activeProgress && currentTask.status === 'running') {
      // If we have progress tracking, estimate remaining time based on progress
      const remainingPercent = 100 - activeProgress.percent;
      if (activeProgress.percent > 0 && elapsedSeconds > 0) {
        const secondsPerPercent = elapsedSeconds / activeProgress.percent;
        estimatedSecondsRemaining = Math.round(secondsPerPercent * remainingPercent);
      }
    }

    const taskInfo: TaskStatusResult['task'] = {
      id: currentTask.id,
      prompt: currentTask.prompt,
      status: currentTask.status,
      progress: currentTask.progress,
      currentStep: currentTask.currentStep,
      createdAt: currentTask.createdAt,
      updatedAt: currentTask.updatedAt,
      elapsedSeconds,
      estimatedSecondsRemaining,
      error: currentTask.error,
    };

    logger.debug({ task: taskInfo }, 'Task status retrieved');

    return {
      success: true,
      message: `Current task: ${currentTask.status} (${currentTask.progress}%)`,
      task: taskInfo,
    };
  } catch (error) {
    logger.error({ err: error }, 'Failed to get task status');
    return {
      success: false,
      message: `Failed to get task status: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

