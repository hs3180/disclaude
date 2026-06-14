/**
 * loop_status tool implementation.
 *
 * Gets the current status of a loop execution.
 * Issue #4075: Loop = while loop + push_to_agent + counter.
 *
 * @module mcp-server/tools/loop-status
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { SendMessageResult } from './types.js';

const logger = createLogger('LoopStatus');

export async function loop_status(params: { loopId: string }): Promise<SendMessageResult> {
  const { loopId } = params;

  logger.info({ loopId }, 'loop_status called');

  try {
    if (!loopId) { throw new Error('loopId is required'); }

    if (!(await isIpcAvailable())) {
      const errorMsg = 'IPC service unavailable. Please ensure Primary Node is running.';
      return { success: false, error: errorMsg, message: getIpcErrorMessage('ipc_unavailable') };
    }

    const ipcClient = getIpcClient();
    const result = await ipcClient.loopStatus(loopId);
    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      return { success: false, error: result.error ?? 'Failed to get loop status', message: errorMsg };
    }

    if (!result.status) {
      return { success: false, message: `Loop not found: ${loopId}` };
    }

    const s = result.status;
    return {
      success: true,
      message: `Loop ${s.loopId}: ${s.state} (step ${s.currentStep}/${s.totalSteps}, started ${s.startedAt})`,
    };
  } catch (error) {
    logger.error({ err: error, loopId }, 'loop_status FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `Failed to get loop status: ${errorMessage}` };
  }
}
