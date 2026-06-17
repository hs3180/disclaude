/**
 * loop_stop tool implementation.
 *
 * Stops a running loop execution.
 * Issue #4075: Loop = while loop + push_to_agent + counter.
 *
 * @module mcp-server/tools/loop-stop
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { SendMessageResult } from './types.js';

const logger = createLogger('LoopStop');

export async function loop_stop(params: { loopId: string }): Promise<SendMessageResult> {
  const { loopId } = params;

  logger.info({ loopId }, 'loop_stop called');

  try {
    if (!loopId) { throw new Error('loopId is required'); }

    if (!(await isIpcAvailable())) {
      const errorMsg = 'IPC service unavailable. Please ensure Primary Node is running.';
      return { success: false, error: errorMsg, message: getIpcErrorMessage('ipc_unavailable') };
    }

    const ipcClient = getIpcClient();
    const result = await ipcClient.loopStop(loopId);
    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      return { success: false, error: result.error ?? 'Failed to stop loop', message: errorMsg };
    }

    return { success: true, message: `Loop stopped: ${loopId}` };
  } catch (error) {
    logger.error({ err: error, loopId }, 'loop_stop FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `Failed to stop loop: ${errorMessage}` };
  }
}
