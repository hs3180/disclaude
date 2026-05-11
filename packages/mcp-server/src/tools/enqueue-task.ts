/**
 * A2A task delegation tool — enqueue_task.
 *
 * Allows a ChatAgent to delegate a task to another project-bound agent
 * by sending a NonUserMessage via IPC to the PrimaryNode.
 *
 * @see Issue #3334 (A2A messaging — Agent-to-Agent task delegation)
 * @module mcp-server/tools/enqueue-task
 */

import { getIpcClient, createLogger } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';

const logger = createLogger('EnqueueTask');

export interface EnqueueTaskParams {
  sourceChatId: string;
  projectKey: string;
  payload: string;
  priority: 'low' | 'normal' | 'high';
}

export interface EnqueueTaskResult {
  success: boolean;
  message: string;
}

/**
 * Enqueue an A2A task for another project-bound agent.
 *
 * Anti-recursion and rate limiting are enforced on the PrimaryNode side.
 */
export async function enqueue_task(params: EnqueueTaskParams): Promise<EnqueueTaskResult> {
  const { sourceChatId, projectKey, payload, priority } = params;

  // Validate required parameters
  if (!sourceChatId) {
    return { success: false, message: 'sourceChatId is required' };
  }
  if (!projectKey) {
    return { success: false, message: 'projectKey is required' };
  }
  if (!payload) {
    return { success: false, message: 'payload is required' };
  }

  // Check IPC availability
  const ipcAvailable = await isIpcAvailable();
  if (!ipcAvailable) {
    return {
      success: false,
      message: 'A2A task delegation unavailable: IPC server not reachable',
    };
  }

  try {
    const ipcClient = getIpcClient();
    const result = await ipcClient.enqueueTask(sourceChatId, projectKey, payload, priority);

    if (result.success) {
      logger.info({ sourceChatId, projectKey, priority }, 'A2A task enqueued successfully');
      return {
        success: true,
        message: `Task enqueued for ${projectKey}. The project agent will process it in its bound chat.`,
      };
    }

    logger.warn({ sourceChatId, projectKey, error: result.error }, 'A2A task enqueue failed');
    return {
      success: false,
      message: result.error ?? 'Failed to enqueue task',
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, sourceChatId, projectKey }, 'A2A task enqueue error');
    return {
      success: false,
      message: `Failed to enqueue task: ${msg}`,
    };
  }
}
