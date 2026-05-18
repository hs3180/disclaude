/**
 * push_to_agent tool implementation.
 *
 * Pushes an instruction to a chat agent, triggering agent creation if needed.
 * This allows skills to send instructions to agents handling a specific chat.
 *
 * Issue #631: Non-blocking interaction — Agent-to-human messaging without blocking.
 *
 * @module mcp-server/tools/push-to-agent
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { SendMessageResult } from './types.js';

const logger = createLogger('PushToAgent');

/**
 * Push an instruction to a chat agent via IPC.
 *
 * @param params.chatId - Target chat ID
 * @param params.message - The instruction text to push
 */
export async function push_to_agent(params: {
  chatId: string;
  message: string;
}): Promise<SendMessageResult> {
  const { chatId, message } = params;

  logger.info({
    chatId,
    messagePreview: message.substring(0, 100),
  }, 'push_to_agent called');

  try {
    if (!message) {
      throw new Error('message is required');
    }
    if (!chatId) {
      throw new Error('chatId is required');
    }

    // Check IPC availability
    if (!(await isIpcAvailable())) {
      const errorMsg = 'IPC service unavailable. Please ensure Primary Node is running.';
      logger.error({ chatId }, errorMsg);
      return {
        success: false,
        error: errorMsg,
        message: '❌ IPC 服务不可用。请检查 Primary Node 服务是否正在运行。',
      };
    }

    logger.debug({ chatId }, 'Using IPC for push_to_agent');
    const ipcClient = getIpcClient();
    const result = await ipcClient.pushToAgent(chatId, message);
    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'IPC push_to_agent failed');
      return {
        success: false,
        error: result.error ?? 'Failed to push to agent via IPC',
        message: errorMsg,
      };
    }

    logger.debug({ chatId }, 'push_to_agent succeeded');
    return { success: true, message: '✅ Instruction pushed to agent successfully' };

  } catch (error) {
    logger.error({ err: error, chatId }, 'push_to_agent FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to push to agent: ${errorMessage}` };
  }
}
