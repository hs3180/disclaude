/**
 * Ask User tool implementation.
 *
 * This tool provides a simplified interface for agents to ask users questions
 * with predefined options. It builds on top of send_interactive_message.
 *
 * @module mcp/tools/ask-user
 */

import { createLogger } from '../../utils/logger.js';
import { send_interactive_message } from './interactive-message.js';
import type { AskUserResult, AskUserOptions } from './types.js';

const logger = createLogger('AskUser');

/**
 * Build a Feishu card structure for a question with options.
 */
function buildQuestionCard(
  question: string,
  options: AskUserOptions[],
  title?: string
): Record<string, unknown> {
  const buttons = options.map((opt, index) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: opt.text },
    value: opt.value || `option_${index}`,
    type: opt.style === 'danger' ? 'danger' :
          opt.style === 'primary' ? 'primary' : 'default',
  }));

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title || '🤖 Agent 提问' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'markdown',
        content: question,
      },
      {
        tag: 'action',
        actions: buttons,
      },
    ],
  };
}

/**
 * Build action prompts from options.
 *
 * Each prompt includes context about what action to take when the user
 * selects that option. This enables the agent to continue execution
 * based on the user's choice.
 */
function buildActionPrompts(
  options: AskUserOptions[],
  context?: string
): Record<string, string> {
  const prompts: Record<string, string> = {};

  for (const opt of options) {
    const value = opt.value || `option_${opt.text}`;
    const contextPart = context ? `\n\n**上下文**: ${context}` : '';
    const actionPart = opt.action
      ? `\n\n**请执行**: ${opt.action}`
      : '';

    prompts[value] = `[用户操作] 用户选择了「${opt.text}」选项。${contextPart}${actionPart}`;
  }

  return prompts;
}

/**
 * Ask the user a question with predefined options.
 *
 * This tool provides a Human-in-the-Loop capability for agents.
 * When the user selects an option, the agent receives a message
 * with the selection and can continue execution accordingly.
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

    // Build card and action prompts
    const card = buildQuestionCard(question, options, title);
    const actionPrompts = buildActionPrompts(options, context);

    logger.debug({
      chatId,
      cardStructure: JSON.stringify(card).slice(0, 200),
      promptKeys: Object.keys(actionPrompts),
    }, 'Built card and prompts');

    // Send the interactive message
    const result = await send_interactive_message({
      card,
      actionPrompts,
      chatId,
      parentMessageId,
    });

    if (result.success) {
      logger.info({
        chatId,
        messageId: result.messageId,
        optionCount: options.length,
      }, 'Question sent successfully');

      return {
        success: true,
        message: `✅ 问题已发送，等待用户选择 (${options.length} 个选项)`,
        messageId: result.messageId,
      };
    } else {
      return {
        success: false,
        error: result.error,
        message: result.message || '❌ 发送问题失败',
      };
    }

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
