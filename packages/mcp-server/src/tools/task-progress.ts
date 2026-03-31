/**
 * update_task_progress tool implementation.
 *
 * Allows agents to update their task progress in the shared TaskContext.
 * Used by Task Agents to report their progress during execution.
 *
 * Issue #857: Foundation for Independent Reporter Agent design.
 *
 * @module mcp-server/tools/task-progress
 */

import { createLogger, getTaskContext, initTaskContext } from '@disclaude/core';
import type { TaskProgressResult } from './types.js';

const logger = createLogger('TaskProgress');

/**
 * Register a new task for progress tracking.
 *
 * @param params - Task registration parameters
 * @returns Registration result
 */
export async function register_task(params: {
  taskId: string;
  description: string;
  chatId?: string;
  totalEstimatedSteps?: number;
}): Promise<TaskProgressResult> {
  const { taskId, description, chatId, totalEstimatedSteps } = params;

  logger.info({ taskId, description }, 'register_task called');

  try {
    if (!taskId) {
      return { success: false, message: 'taskId is required' };
    }
    if (!description) {
      return { success: false, message: 'description is required' };
    }

    let ctx = getTaskContext();
    if (!ctx) {
      ctx = initTaskContext();
    }

    const progress = ctx.registerTask({
      taskId,
      description,
      chatId,
      totalEstimatedSteps,
    });

    return {
      success: true,
      message: `✅ Task "${description}" registered (${taskId})`,
      taskId: progress.taskId,
      status: progress.status,
    };

  } catch (error) {
    logger.error({ err: error, taskId }, 'register_task FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, message: `❌ Failed to register task: ${errorMessage}` };
  }
}

/**
 * Update progress for a running task.
 *
 * @param params - Progress update parameters
 * @returns Update result
 */
export async function update_task_progress(params: {
  taskId: string;
  currentStep?: string;
  status?: string;
  error?: string;
  addStep?: string;
  updateStepName?: string;
  updateStepStatus?: string;
  totalEstimatedSteps?: number;
}): Promise<TaskProgressResult> {
  const {
    taskId,
    currentStep,
    status,
    error,
    addStep,
    updateStepName,
    updateStepStatus,
    totalEstimatedSteps,
  } = params;

  logger.debug({ taskId, currentStep, status }, 'update_task_progress called');

  try {
    if (!taskId) {
      return { success: false, message: 'taskId is required' };
    }

    let ctx = getTaskContext();
    if (!ctx) {
      ctx = initTaskContext();
    }

    // Build update object
    const update: Parameters<typeof ctx.updateProgress>[1] = {};

    if (currentStep !== undefined) {
      update.currentStep = currentStep;
    }

    if (status !== undefined) {
      // Validate status
      const validStatuses = ['pending', 'running', 'completed', 'failed', 'cancelled'];
      if (!validStatuses.includes(status)) {
        return { success: false, message: `Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}` };
      }
      update.status = status as 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    }

    if (error !== undefined) {
      update.error = error;
    }

    if (addStep !== undefined) {
      update.addStep = { name: addStep, status: 'running' };
    }

    if (updateStepName !== undefined && updateStepStatus !== undefined) {
      const validStepStatuses = ['pending', 'running', 'completed', 'failed'];
      if (!validStepStatuses.includes(updateStepStatus)) {
        return { success: false, message: `Invalid step status: ${updateStepStatus}` };
      }
      update.updateStep = {
        name: updateStepName,
        status: updateStepStatus as 'pending' | 'running' | 'completed' | 'failed',
      };
    }

    if (totalEstimatedSteps !== undefined) {
      update.totalEstimatedSteps = totalEstimatedSteps;
    }

    const progress = ctx.updateProgress(taskId, update);
    const percentage = ctx.getProgressPercentage(taskId);

    return {
      success: true,
      message: `✅ Task progress updated: ${progress.currentStep} (${percentage}%)`,
      taskId: progress.taskId,
      status: progress.status,
    };

  } catch (error) {
    logger.error({ err: error, taskId }, 'update_task_progress FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, message: `❌ Failed to update task progress: ${errorMessage}` };
  }
}

/**
 * Complete a task.
 *
 * @param params - Completion parameters
 * @returns Completion result
 */
export async function complete_task(params: {
  taskId: string;
  result?: string;
}): Promise<TaskProgressResult> {
  const { taskId, result } = params;

  logger.info({ taskId }, 'complete_task called');

  try {
    if (!taskId) {
      return { success: false, message: 'taskId is required' };
    }

    let ctx = getTaskContext();
    if (!ctx) {
      ctx = initTaskContext();
    }

    const progress = ctx.completeTask(taskId, result);

    return {
      success: true,
      message: `✅ Task completed: ${progress.description}`,
      taskId: progress.taskId,
      status: progress.status,
    };

  } catch (error) {
    logger.error({ err: error, taskId }, 'complete_task FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, message: `❌ Failed to complete task: ${errorMessage}` };
  }
}
