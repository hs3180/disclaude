/**
 * loop_start tool implementation.
 *
 * Starts a loop execution that repeatedly pushes instructions to a chat agent.
 * Issue #4075: Loop = while loop + push_to_agent + counter.
 *
 * @module mcp-server/tools/loop-start
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { SendMessageResult } from './types.js';

const logger = createLogger('LoopStart');

export async function loop_start(params: {
  chatId: string;
  prompt: string;
  workDir?: string;
  maxSteps?: number;
  maxDurationMs?: number;
  stepIntervalMs?: number;
}): Promise<SendMessageResult & { loopId?: string }> {
  const { chatId, prompt } = params;

  logger.info({ chatId, promptPreview: prompt.substring(0, 100) }, 'loop_start called');

  try {
    if (!chatId) { throw new Error('chatId is required'); }
    if (!prompt) { throw new Error('prompt is required'); }

    if (!(await isIpcAvailable())) {
      const errorMsg = 'IPC service unavailable. Please ensure Primary Node is running.';
      logger.error({ chatId }, errorMsg);
      return { success: false, error: errorMsg, message: getIpcErrorMessage('ipc_unavailable') };
    }

    const ipcClient = getIpcClient();
    const result = await ipcClient.loopStart(params);
    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'IPC loopStart failed');
      return { success: false, error: result.error ?? 'Failed to start loop via IPC', message: errorMsg };
    }

    logger.info({ chatId, loopId: result.loopId }, 'loop_start succeeded');
    return { success: true, message: `Loop started: ${result.loopId}`, loopId: result.loopId };
  } catch (error) {
    logger.error({ err: error, chatId }, 'loop_start FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `Failed to start loop: ${errorMessage}` };
  }
}
