/**
 * Start Discussion tool implementation.
 *
 * This tool allows agents to initiate non-blocking discussions by creating
 * a new group chat (or using an existing one) and sending context to it.
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 *
 * @module mcp-server/tools/start-discussion
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { send_interactive_message } from './interactive-message.js';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { StartDiscussionResult, StartDiscussionOptions } from './types.js';

const logger = createLogger('StartDiscussion');

/**
 * Build a discussion card structure.
 */
function buildDiscussionCard(
  context: string,
  topic?: string,
  options?: StartDiscussionOptions[]
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: context,
    },
  ];

  // Add action buttons if options are provided
  if (options && options.length > 0) {
    const buttons = options.map((opt, index) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: opt.text },
      value: opt.value || `option_${index}`,
      type: opt.style === 'danger' ? 'danger' :
            opt.style === 'primary' ? 'primary' : 'default',
    }));
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'action', actions: buttons });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: topic ? `💬 ${topic}` : '💬 讨论话题' },
      template: 'blue',
    },
    elements,
  };
}

/**
 * Build action prompts from discussion options.
 */
function buildActionPrompts(
  options: StartDiscussionOptions[],
  context?: string
): Record<string, string> {
  const prompts: Record<string, string> = {};

  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const value = opt.value || `option_${i}`;
    const contextPart = context ? `\n\n**讨论背景**: ${context}` : '';
    const actionPart = opt.action
      ? `\n\n**请执行**: ${opt.action}`
      : '';

    prompts[value] = `[用户操作] 用户在讨论群中选择了「${opt.text}」选项。${contextPart}${actionPart}`;
  }

  return prompts;
}

/**
 * Start a non-blocking discussion.
 *
 * Creates a new group chat (or uses an existing one) and sends the discussion
 * context to it. Returns immediately without waiting for user responses.
 *
 * @example
 * ```typescript
 * // Create new group with discussion
 * await start_discussion({
 *   topic: '是否应该自动化代码格式化？',
 *   context: '在最近的任务中，发现代码格式化存在不一致的情况...',
 *   members: ['ou_xxx'],
 *   options: [
 *     { text: '是，应该自动化', value: 'yes', action: '创建格式化自动化配置' },
 *     { text: '不需要', value: 'no' },
 *     { text: '需要更多信息', value: 'more_info' },
 *   ],
 * });
 *
 * // Use existing group
 * await start_discussion({
 *   chatId: 'oc_xxx',
 *   topic: 'PR Review 讨论',
 *   context: 'PR #123 需要讨论合并策略...',
 * });
 * ```
 *
 * @param params - Discussion parameters
 * @returns Result with group chatId and messageId
 */
export async function start_discussion(params: {
  /** Discussion topic (used as group name when creating new group) */
  topic?: string;
  /** Context/information to send to the discussion group */
  context: string;
  /** Use existing group chat ID (skip group creation) */
  chatId?: string;
  /** Member open_ids for creating new group */
  members?: string[];
  /** Optional response options for users to choose from */
  options?: StartDiscussionOptions[];
}): Promise<StartDiscussionResult> {
  const { topic, context, chatId, members, options } = params;

  logger.info({
    topic,
    hasChatId: !!chatId,
    memberCount: members?.length ?? 0,
    optionCount: options?.length ?? 0,
    contextLength: context?.length ?? 0,
  }, 'start_discussion called');

  try {
    // Validate required parameters
    if (!context || typeof context !== 'string') {
      return {
        success: false,
        error: 'context is required and must be a string',
        message: '❌ 讨论内容不能为空',
      };
    }

    // Check IPC availability
    if (!(await isIpcAvailable())) {
      const errorMsg = 'IPC 服务不可用。请检查 Primary Node 服务是否正在运行。';
      logger.error(errorMsg);
      return {
        success: false,
        error: errorMsg,
        message: `❌ ${errorMsg}`,
      };
    }

    // Step 1: Determine target chatId (create group or use existing)
    let targetChatId = chatId;
    let groupName: string | undefined;

    if (!targetChatId) {
      // Need to create a new group
      logger.info({ topic, memberCount: members?.length ?? 0 }, 'Creating new discussion group');

      const ipcClient = getIpcClient();
      const groupResult = await ipcClient.feishuCreateGroup(topic, members);

      if (!groupResult.success) {
        const errorMsg = getIpcErrorMessage(groupResult.errorType, groupResult.error);
        logger.error({ err: groupResult.error, errorType: groupResult.errorType }, 'Failed to create group');
        return {
          success: false,
          error: groupResult.error,
          message: `❌ 创建讨论群失败: ${errorMsg}`,
        };
      }

      targetChatId = groupResult.chatId;
      groupName = groupResult.name;
      logger.info({ chatId: targetChatId, name: groupName }, 'Discussion group created');
    }

    if (!targetChatId) {
      return {
        success: false,
        error: 'No chatId available',
        message: '❌ 无法确定目标群聊',
      };
    }

    // Step 2: Send discussion context as interactive card
    const card = buildDiscussionCard(context, topic, options);
    const actionPrompts = options && options.length > 0
      ? buildActionPrompts(options, context)
      : {};

    const result = await send_interactive_message({
      card,
      actionPrompts,
      chatId: targetChatId,
    });

    if (result.success) {
      logger.info({
        chatId: targetChatId,
        messageId: result.messageId,
        isNewGroup: !chatId,
      }, 'Discussion started successfully');

      const groupInfo = groupName ? ` (群: ${groupName})` : '';
      return {
        success: true,
        message: `✅ 讨论已发起${groupInfo}，等待用户参与`,
        chatId: targetChatId,
        messageId: result.messageId,
      };
    } else {
      return {
        success: false,
        error: result.error,
        message: result.message || '❌ 发送讨论内容失败',
        chatId: targetChatId,
      };
    }

  } catch (error) {
    logger.error({ err: error, topic }, 'start_discussion failed');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: errorMessage,
      message: `❌ 发起讨论失败: ${errorMessage}`,
    };
  }
}
