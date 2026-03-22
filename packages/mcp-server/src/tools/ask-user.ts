/**
 * Ask User tool implementation.
 *
 * This tool provides a simplified interface for agents to ask users questions
 * with predefined options. It builds on top of send_interactive_message.
 *
 * Issue #946: Enhanced with createGroup support for "御书房" review experience.
 * When createGroup is true, a new independent group chat is created and the
 * question is sent there instead of the original chat.
 *
 * @module mcp-server/tools/ask-user
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { send_interactive_message } from './interactive-message.js';
import { isIpcAvailable } from './ipc-utils.js';
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

  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const value = opt.value || `option_${i}`;
    const contextPart = context ? `\n\n**上下文**: ${context}` : '';
    const actionPart = opt.action
      ? `\n\n**请执行**: ${opt.action}`
      : '';

    prompts[value] = `[用户操作] 用户选择了「${opt.text}」选项。${contextPart}${actionPart}`;
  }

  return prompts;
}

/**
 * Create a group chat via IPC.
 *
 * @returns The created group's chatId and name, or null on failure.
 */
async function createGroupViaIpc(options?: {
  groupName?: string;
  members?: string[];
}): Promise<{ chatId: string; chatName: string } | null> {
  const ipcClient = getIpcClient();
  const result = await ipcClient.feishuCreateGroup(options);

  if (result.success && result.chatId) {
    return {
      chatId: result.chatId,
      chatName: result.chatName || result.chatId,
    };
  }

  logger.error({
    error: result.error,
    errorType: result.errorType,
  }, 'Failed to create group via IPC');

  return null;
}

/**
 * Ask the user a question with predefined options.
 *
 * This tool provides a Human-in-the-Loop capability for agents.
 * When the user selects an option, the agent receives a message
 * with the selection and can continue execution accordingly.
 *
 * Issue #946: When `createGroup` is true, a new independent group chat is
 * automatically created and the question is sent there. This enables the
 * "御书房" (Imperial Study) review experience where review discussions
 * happen in dedicated, isolated group chats.
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
 * // Issue #946: PR Review in independent group chat (御书房 experience)
 * await ask_user({
 *   question: '**代码变更审核**\n\n已完成认证模块重构...',
 *   options: [
 *     { text: '✅ 批准', value: 'approve', style: 'primary', action: '合并代码' },
 *     { text: '❌ 拒绝', value: 'reject', style: 'danger', action: '回滚更改' },
 *     { text: '✏️ 需要修改', value: 'revise', action: '根据反馈修改' },
 *   ],
 *   chatId: 'oc_xxx',
 *   createGroup: true,
 *   groupName: '代码审核 - PR #123',
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
  /**
   * Whether to create a new independent group chat for this question.
   * Issue #946: Enable "御书房" review experience.
   * When true, a new group chat is created and the question is sent there.
   */
  createGroup?: boolean;
  /**
   * Name for the new group chat (only used when createGroup is true).
   * If not provided, a default name will be auto-generated.
   */
  groupName?: string;
  /**
   * Member open_ids to add to the new group chat (only used when createGroup is true).
   */
  members?: string[];
}): Promise<AskUserResult> {
  const {
    question,
    options,
    context,
    title,
    chatId,
    parentMessageId,
    createGroup: shouldCreateGroup,
    groupName,
    members,
  } = params;

  logger.info({
    chatId,
    questionLength: question?.length ?? 0,
    optionCount: options?.length ?? 0,
    hasContext: !!context,
    createGroup: shouldCreateGroup,
    groupName,
    memberCount: members?.length ?? 0,
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

    // Issue #946: Create group if requested
    let targetChatId = chatId;
    let createdGroupName: string | undefined;

    if (shouldCreateGroup) {
      // Check IPC availability
      if (!(await isIpcAvailable())) {
        return {
          success: false,
          error: 'IPC service unavailable',
          message: '❌ 无法创建群聊：IPC 服务不可用。请检查 Primary Node 是否正在运行。',
        };
      }

      logger.info({
        groupName,
        memberCount: members?.length ?? 0,
        sourceChatId: chatId,
      }, 'Creating group chat for ask_user');

      const groupInfo = await createGroupViaIpc({ groupName, members });
      if (!groupInfo) {
        return {
          success: false,
          error: 'Failed to create group',
          message: '❌ 创建群聊失败，请稍后重试',
        };
      }

      targetChatId = groupInfo.chatId;
      createdGroupName = groupInfo.chatName;

      logger.info({
        newChatId: groupInfo.chatId,
        chatName: groupInfo.chatName,
      }, 'Group chat created for ask_user');
    }

    // Build card and action prompts
    const card = buildQuestionCard(question, options, title);
    const actionPrompts = buildActionPrompts(options, context);

    logger.debug({
      chatId: targetChatId,
      cardStructure: JSON.stringify(card).slice(0, 200),
      promptKeys: Object.keys(actionPrompts),
    }, 'Built card and prompts');

    // Send the interactive message to the target chat
    // Note: parentMessageId is not used when creating a new group
    const result = await send_interactive_message({
      card,
      actionPrompts,
      chatId: targetChatId,
      ...(shouldCreateGroup ? {} : { parentMessageId }),
    });

    if (result.success) {
      logger.info({
        chatId: targetChatId,
        messageId: result.messageId,
        optionCount: options.length,
        createdGroup: !!createdGroupName,
      }, 'Question sent successfully');

      const groupInfo = createdGroupName
        ? ` (群聊: ${createdGroupName})`
        : '';

      return {
        success: true,
        message: `✅ 问题已发送${groupInfo}，等待用户选择 (${options.length} 个选项)`,
        messageId: result.messageId,
        chatId: targetChatId,
        groupName: createdGroupName,
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
