/**
 * Loop Runner MCP tools.
 *
 * Provides loop_start, loop_stop, and loop_status tools that
 * communicate with the Primary Node via IPC.
 *
 * Issue #4063 (Phase 0c): Loop Runner Integration.
 *
 * @module mcp-server/tools/loop-runner
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';
import type { SendMessageResult } from './types.js';

const logger = createLogger('LoopRunner');

/**
 * Start a loop execution.
 */
export async function loop_start(params: {
  chatId: string;
  workDir: string;
  prompt: string;
  maxSteps?: number;
  maxDuration?: string;
  maxConsecutiveFailures?: number;
}): Promise<SendMessageResult> {
  logger.info({ chatId: params.chatId }, 'loop_start called');

  try {
    if (!params.chatId) {
      throw new Error('chatId is required');
    }
    if (!params.workDir) {
      throw new Error('workDir is required');
    }
    if (!params.prompt) {
      throw new Error('prompt is required');
    }

    if (!(await isIpcAvailable())) {
      const errorMsg = 'IPC service unavailable. Please ensure Primary Node is running.';
      logger.error({ chatId: params.chatId }, errorMsg);
      return {
        success: false,
        error: errorMsg,
        message: '❌ IPC 服务不可用。请检查 Primary Node 服务是否正在运行。',
      };
    }

    const ipcClient = getIpcClient();
    const result = await ipcClient.loopStart(params);
    if (!result.success) {
      logger.error({ chatId: params.chatId, error: result.error }, 'loop_start IPC failed');
      return {
        success: false,
        error: result.error ?? 'loop_start failed via IPC',
        message: `❌ 启动循环失败: ${result.error ?? 'Unknown error'}`,
      };
    }

    logger.info({ loopId: result.loopId }, 'loop_start succeeded');
    return { success: true, message: `✅ Loop started: ${result.loopId ?? 'unknown'}` };

  } catch (error) {
    logger.error({ err: error }, 'loop_start FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed: ${errorMessage}` };
  }
}

/**
 * Stop a running loop.
 */
export async function loop_stop(params: {
  loopId: string;
}): Promise<SendMessageResult> {
  logger.info({ loopId: params.loopId }, 'loop_stop called');

  try {
    if (!params.loopId) {
      throw new Error('loopId is required');
    }

    if (!(await isIpcAvailable())) {
      return {
        success: false,
        error: 'IPC service unavailable',
        message: '❌ IPC 服务不可用。',
      };
    }

    const ipcClient = getIpcClient();
    const result = await ipcClient.loopStop(params.loopId);
    if (!result.success) {
      return {
        success: false,
        error: result.error ?? 'loop_stop failed',
        message: `❌ 停止循环失败: ${result.error ?? 'Unknown error'}`,
      };
    }

    return { success: true, message: `✅ Loop stopped: ${params.loopId}` };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed: ${errorMessage}` };
  }
}

/**
 * Get the status of a loop.
 */
export async function loop_status(params: {
  loopId: string;
}): Promise<SendMessageResult & { statusData?: Record<string, unknown> }> {
  logger.info({ loopId: params.loopId }, 'loop_status called');

  try {
    if (!params.loopId) {
      throw new Error('loopId is required');
    }

    if (!(await isIpcAvailable())) {
      return {
        success: false,
        error: 'IPC service unavailable',
        message: '❌ IPC 服务不可用。',
      };
    }

    const ipcClient = getIpcClient();
    const result = await ipcClient.loopStatus(params.loopId);
    if (!result.success) {
      return {
        success: false,
        error: result.error ?? 'loop_status failed',
        message: `❌ 查询状态失败: ${result.error ?? 'Unknown error'}`,
      };
    }

    const statusData: Record<string, unknown> = {
      loopId: result.loopId,
      state: result.state,
      currentStep: result.currentStep,
      totalSteps: result.totalSteps,
      completedSteps: result.completedSteps,
      failedSteps: result.failedSteps,
      consecutiveFailures: result.consecutiveFailures,
      elapsedMs: result.elapsedMs,
    };

    return {
      success: true,
      message: `📊 Loop ${result.loopId ?? params.loopId}: ${result.state ?? 'unknown'} (${result.currentStep ?? 0}/${result.totalSteps ?? 0})`,
      statusData,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed: ${errorMessage}` };
  }
}
