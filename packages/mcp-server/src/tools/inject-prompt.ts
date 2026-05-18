/**
 * inject_prompt tool implementation.
 *
 * Injects a prompt into a chat agent, triggering agent creation if needed.
 * This allows skills to send initialization prompts to newly created groups.
 *
 * Issue #631: Non-blocking interaction — Agent-to-human messaging without blocking.
 *
 * @module mcp-server/tools/inject-prompt
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { SendMessageResult } from './types.js';

const logger = createLogger('InjectPrompt');

/**
 * Inject a prompt into a chat agent via IPC.
 *
 * @param params.chatId - Target chat ID
 * @param params.prompt - The prompt text to inject
 */
export async function inject_prompt(params: {
  chatId: string;
  prompt: string;
}): Promise<SendMessageResult> {
  const { chatId, prompt } = params;

  logger.info({
    chatId,
    promptPreview: prompt.substring(0, 100),
  }, 'inject_prompt called');

  try {
    if (!prompt) {
      throw new Error('prompt is required');
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

    logger.debug({ chatId }, 'Using IPC for prompt injection');
    const ipcClient = getIpcClient();
    const result = await ipcClient.injectPrompt(chatId, prompt);
    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'IPC prompt injection failed');
      return {
        success: false,
        error: result.error ?? 'Failed to inject prompt via IPC',
        message: errorMsg,
      };
    }

    logger.debug({ chatId }, 'Prompt injected successfully');
    return { success: true, message: '✅ Prompt injected successfully' };

  } catch (error) {
    logger.error({ err: error, chatId }, 'inject_prompt FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to inject prompt: ${errorMessage}` };
  }
}
