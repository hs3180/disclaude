/**
 * Ask User tool implementation.
 *
 * This tool provides a simplified interface for agents to ask users questions
 * with predefined options.
 *
 * Issue #1570 (Phase 1): Card building and action prompt registration
 * have been moved to the Primary Node side. This tool now only validates
 * parameters and forwards raw params via IPC.
 *
 * @module mcp-server/tools/ask-user
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import { getFeishuCredentials } from './credentials.js';
import { invokeMessageSentCallback } from './callback-manager.js';
import type { AskUserResult, AskUserOptions } from './types.js';

const logger = createLogger('AskUser');

/**
 * Ask the user a question with predefined options.
 *
 * This tool provides a Human-in-the-Loop capability for agents.
 * When the user selects an option, the agent receives a message
 * with the selection and can continue execution accordingly.
 *
 * Card building and action prompt registration happen on the Primary Node
 * side via the `sendInteractive` IPC type (Issue #1570: Phase 1).
 *
 * @example
 * ```typescript
 * // Simple question
 * await ask_user({
 *   question: '如何处理这个 PR？',
 *   options: [
 *     { text: '合并', value: 'merge', action: '执行 gh pr merge' },
 *     { text: '关闭', value: 'close', style: 'danger', action: '执行 gh pr close' },
 *     { text: '等待', value: 'wait' },
 *   ],
 *   context: 'PR #123: Fix bug in authentication',
 *   chatId: 'oc_xxx',
 * });
 * ```
 *
 * @example
 * ```typescript
 * // PR Review workflow (MVP use case from Issue #532)
 * await ask_user({
 *   question: `发现新的 PR:\n\n**PR #123**: Fix authentication bug\n\n作者: @developer\n\n请选择处理方式:`,
 *   options: [
 *     { text: '✓ 合并', value: 'merge', style: 'primary', action: '合并此 PR' },
 *     { text: '✗ 关闭', value: 'close', style: 'danger', action: '关闭此 PR' },
 *     { text: '⏳ 等待', value: 'wait', action: '标记为等待中，稍后再处理' },
 *     { text: '📝 请求修改', value: 'request_changes', action: '请求作者修改' },
 *   ],
 *   context: 'PR #123 from scheduled scan',
 *   title: '🔔 PR 审核请求',
 *   chatId: 'oc_xxx',
 * });
 * ```
 */
export async function ask_user(params: {
  /** The question to ask the user */
  question: string;
  /** Available options for the user to choose from */
  options: AskUserOptions[];
  /** Optional context information to include in the response */
  context?: string;
  /** Optional title for the card (default: "🤖 Agent 提问") */
  title?: string;
  /** Target chat ID */
  chatId: string;
  /** Optional parent message ID for thread reply */
  parentMessageId?: string;
}): Promise<AskUserResult> {
  const { question, options, context, title, chatId, parentMessageId } = params;

  logger.info({
    chatId,
    questionLength: question?.length ?? 0,
    optionCount: options?.length ?? 0,
    hasContext: !!context,
  }, 'ask_user called');

  try {
    // Validate required parameters
    if (!question || typeof question !== 'string') {
      return {
        success: false,
        error: 'question is required and must be a string',
        message: '❌ 问题不能为空',
      };
    }

    if (!options || !Array.isArray(options) || options.length === 0) {
      return {
        success: false,
        error: 'options is required and must be a non-empty array',
        message: '❌ 必须提供至少一个选项',
      };
    }

    if (options.length > 5) {
      logger.warn({ optionCount: options.length }, 'More than 5 options may not display well on mobile');
    }

    if (!chatId) {
      return {
        success: false,
        error: 'chatId is required',
        message: '❌ chatId 不能为空',
      };
    }

    // Validate each option
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      if (!opt.text) {
        return {
          success: false,
          error: `Option ${i} is missing 'text' field`,
          message: `❌ 选项 ${i + 1} 缺少显示文本`,
        };
      }
    }

    const { appId, appSecret } = getFeishuCredentials();

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error({ chatId }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
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

    // Issue #1570: Pass raw params via sendInteractive IPC type.
    // Card building and action prompt registration happen on Primary Node.
    const ipcClient = getIpcClient();
    const result = await ipcClient.sendInteractive(
      chatId,
      question,
      options,
      title,
      context,
      parentMessageId,
    );

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'sendInteractive IPC failed');
      return {
        success: false,
        error: result.error ?? 'Failed to send interactive message via IPC',
        message: errorMsg,
      };
    }

    invokeMessageSentCallback(chatId);

    logger.info({
      chatId,
      messageId: result.messageId,
      optionCount: options.length,
    }, 'Question sent successfully via sendInteractive');

    return {
      success: true,
      message: `✅ 问题已发送，等待用户选择 (${options.length} 个选项)`,
      messageId: result.messageId,
    };

  } catch (error) {
    logger.error({ err: error, chatId }, 'ask_user failed');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: errorMessage,
      message: `❌ 发送问题失败: ${errorMessage}`,
    };
  }
}
