/**
 * report_progress MCP tool implementation.
 *
 * Allows the Agent to report task progress to users during long-running tasks.
 * The Agent decides when to report progress (intelligent approach per Issue #857).
 *
 * This tool:
 * 1. Persists progress to progress.md in the task directory
 * 2. Sends a progress card to the user's chat via send_card
 *
 * @module mcp-server/tools/report-progress
 * @since Issue #857
 */

import { createLogger, type TaskProgress, type TaskProgressStatus } from '@disclaude/core';
import { send_card } from './send-card.js';
import { getWorkspaceDir } from './credentials.js';
import type { SendMessageResult } from './types.js';

const logger = createLogger('ReportProgress');

/**
 * Build a Feishu progress card.
 *
 * @param params - Progress card parameters
 * @returns Feishu card object
 */
function buildProgressCard(params: {
  progress: number;
  status: TaskProgressStatus;
  message: string;
  completedSteps: string[];
  remainingSteps: string[];
}): Record<string, unknown> {
  const { progress, status, message, completedSteps, remainingSteps } = params;

  // Status emoji and color
  const statusConfig: Record<TaskProgressStatus, { emoji: string; template: string; title: string }> = {
    in_progress: { emoji: '🔄', template: 'blue', title: '任务执行中' },
    completed: { emoji: '✅', template: 'green', title: '任务完成' },
    failed: { emoji: '❌', template: 'red', title: '任务失败' },
    paused: { emoji: '⏸️', template: 'orange', title: '任务暂停' },
  };

  const config = statusConfig[status];

  // Build progress bar (visual representation)
  const filledCount = Math.round(progress / 10);
  const emptyCount = 10 - filledCount;
  const progressBar = '█'.repeat(filledCount) + '░'.repeat(emptyCount);

  // Build elements
  const elements: Array<Record<string, unknown>> = [];

  // Progress bar
  elements.push({
    tag: 'markdown',
    content: `**进度**: ${progressBar} ${progress}%`,
  });

  // Current activity
  if (message) {
    elements.push({
      tag: 'markdown',
      content: `**当前**: ${message}`,
    });
  }

  // Completed steps
  if (completedSteps.length > 0) {
    elements.push({
      tag: 'markdown',
      content: `**已完成**:\n${completedSteps.map(s => `- ✅ ${s}`).join('\n')}`,
    });
  }

  // Remaining steps
  if (remainingSteps.length > 0) {
    elements.push({
      tag: 'markdown',
      content: `**待完成**:\n${remainingSteps.map(s => `- ⬜ ${s}`).join('\n')}`,
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { content: `${config.emoji} ${config.title}`, tag: 'plain_text' },
      template: config.template,
    },
    elements,
  };
}

/**
 * Write progress.md to the task directory.
 *
 * @param taskId - Task identifier
 * @param progressData - Progress data to persist
 */
async function writeProgressFile(
  taskId: string,
  progressData: TaskProgress
): Promise<void> {
  const workspaceDir = getWorkspaceDir();
  if (!workspaceDir) {
    logger.warn('No workspace dir configured, skipping progress file write');
    return;
  }

  const fs = await import('fs/promises');
  const path = await import('path');

  const taskDir = path.join(workspaceDir, 'tasks', taskId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  const progressPath = path.join(taskDir, 'progress.md');

  try {
    await fs.mkdir(taskDir, { recursive: true });

    const content = `# Task Progress

**Task ID**: ${progressData.taskId}
**Status**: ${progressData.status}
**Progress**: ${progressData.progress}%
**Started**: ${progressData.startedAt}
**Updated**: ${progressData.updatedAt}

## Current Activity

${progressData.message}

## Completed Steps

${progressData.completedSteps.map(s => `- ✅ ${s}`).join('\n') || '- None yet'}

## Remaining Steps

${progressData.remainingSteps.map(s => `- ⬜ ${s}`).join('\n') || '- None'}

---

*Progress updated at ${progressData.updatedAt}*
`;

    await fs.writeFile(progressPath, content, 'utf-8');
    logger.debug({ taskId, progress: progressData.progress }, 'Progress file written');
  } catch (error) {
    logger.error({ err: error, taskId }, 'Failed to write progress file');
    // Non-fatal: progress card can still be sent even if file write fails
  }
}

/**
 * Report task progress to the user.
 *
 * Persists progress to the task directory and sends a progress card to the chat.
 * The Agent decides when to call this tool (intelligent approach).
 *
 * @param params - Progress report parameters
 * @returns Result of the operation
 */
export async function report_progress(params: {
  /** Task identifier (messageId) */
  taskId: string;
  /** Target chat ID */
  chatId: string;
  /** Progress percentage (0-100) */
  progress: number;
  /** Human-readable description of current activity */
  message: string;
  /** List of completed steps */
  completedSteps?: string[];
  /** List of remaining steps */
  remainingSteps?: string[];
  /** Task status (default: in_progress) */
  status?: TaskProgressStatus;
  /** ISO 8601 start time (default: now) */
  startedAt?: string;
}): Promise<SendMessageResult> {
  const {
    taskId,
    chatId,
    progress: progressRaw,
    message,
    completedSteps = [],
    remainingSteps = [],
    status = 'in_progress',
    startedAt,
  } = params;

  // Clamp progress to 0-100
  const progress = Math.min(100, Math.max(0, Math.round(progressRaw)));
  const now = new Date().toISOString();

  logger.info({
    taskId,
    chatId,
    progress,
    status,
    messagePreview: message.substring(0, 80),
  }, 'report_progress called');

  try {
    // 1. Persist progress to file
    const progressData: TaskProgress = {
      taskId,
      progress,
      status,
      message,
      completedSteps,
      remainingSteps,
      updatedAt: now,
      startedAt: startedAt || now,
    };
    await writeProgressFile(taskId, progressData);

    // 2. Build and send progress card
    const card = buildProgressCard({
      progress,
      status,
      message,
      completedSteps,
      remainingSteps,
    });

    const result = await send_card({ card, chatId });

    if (result.success) {
      return {
        success: true,
        message: `✅ Progress reported: ${progress}% - ${message}`,
      };
    }

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, taskId }, 'report_progress FAILED');
    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to report progress: ${errorMessage}`,
    };
  }
}
