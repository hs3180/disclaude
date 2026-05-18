/**
 * report_task_progress tool implementation for sending task progress cards.
 *
 * Issue #857: Provides a prompt-driven progress reporting mechanism.
 * The agent decides when to report progress based on its own judgment,
 * not fixed rules. This tool formats and sends the progress card.
 *
 * @module mcp-server/tools/report-task-progress
 */

import { createLogger, getIpcClient, type FeishuCard } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import { getFeishuCredentials } from './credentials.js';
import { invokeMessageSentCallback } from './callback-manager.js';
import type { SendMessageResult } from './types.js';

const logger = createLogger('ReportTaskProgress');

/**
 * Build a progress card for task status display.
 */
function buildProgressCard(params: {
  taskId: string;
  status: string;
  currentStep: string;
  completedSteps: number;
  totalSteps: number;
  elapsedTime: string;
  message: string;
}): Record<string, unknown> {
  const { status, currentStep, completedSteps, totalSteps, elapsedTime, message } = params;

  const statusEmoji = status === 'completed' ? '✅' : status === 'failed' ? '❌' : '🔄';
  const headerTemplate = status === 'completed' ? 'green' : status === 'failed' ? 'red' : 'blue';

  const elements: unknown[] = [];

  // Progress bar text
  if (totalSteps > 0) {
    const percent = Math.round((completedSteps / totalSteps) * 100);
    elements.push({
      tag: 'markdown',
      content: `**进度**: ${completedSteps}/${totalSteps} (${percent}%) — ${currentStep}`,
    });
  } else {
    elements.push({
      tag: 'markdown',
      content: `**当前**: ${currentStep}`,
    });
  }

  // Elapsed time
  elements.push({
    tag: 'markdown',
    content: `**已用时间**: ${elapsedTime}`,
  });

  // Custom message
  if (message) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: message,
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: 'plain_text',
        content: `${statusEmoji} 任务进度`,
      },
      template: headerTemplate,
    },
    elements,
  };
}

/**
 * Send a task progress card to a chat.
 *
 * The agent calls this tool to report task progress to the user.
 * The agent decides WHEN to report based on its own judgment.
 *
 * @param params.taskId - Task identifier
 * @param params.chatId - Target chat ID
 * @param params.status - Current task status (running/completed/failed)
 * @param params.currentStep - Description of current activity
 * @param params.completedSteps - Number of completed steps
 * @param params.totalSteps - Total number of steps (0 if unknown)
 * @param params.elapsedTime - Human-readable elapsed time
 * @param params.message - Optional additional message to the user
 */
export async function report_task_progress(params: {
  taskId: string;
  chatId: string;
  status: string;
  currentStep: string;
  completedSteps?: number;
  totalSteps?: number;
  elapsedTime?: string;
  message?: string;
}): Promise<SendMessageResult> {
  const {
    taskId,
    chatId,
    status,
    currentStep,
    completedSteps = 0,
    totalSteps = 0,
    elapsedTime = '',
    message = '',
  } = params;

  logger.info({
    chatId,
    taskId,
    status,
    completedSteps,
    totalSteps,
  }, 'report_task_progress called');

  try {
    if (!chatId) {
      throw new Error('chatId is required');
    }
    if (!taskId) {
      throw new Error('taskId is required');
    }

    const card = buildProgressCard({
      taskId,
      status,
      currentStep,
      completedSteps,
      totalSteps,
      elapsedTime,
      message,
    });

    const { appId, appSecret } = getFeishuCredentials();

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured';
      logger.error({ chatId }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    if (!(await isIpcAvailable())) {
      const errorMsg = 'IPC service unavailable';
      logger.error({ chatId }, errorMsg);
      return {
        success: false,
        error: errorMsg,
        message: '❌ IPC 服务不可用。请检查 Primary Node 服务是否正在运行。',
      };
    }

    const ipcClient = getIpcClient();
    const result = await ipcClient.sendCard(chatId, card as FeishuCard);

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, error: result.error }, 'IPC progress card failed');
      return {
        success: false,
        error: result.error ?? 'Failed to send progress card',
        message: errorMsg,
      };
    }

    invokeMessageSentCallback(chatId);
    logger.info({ chatId, taskId, status }, 'Progress card sent');
    return { success: true, message: '✅ Progress card sent' };

  } catch (error) {
    logger.error({ err: error, chatId, taskId }, 'report_task_progress FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to report progress: ${errorMessage}` };
  }
}
