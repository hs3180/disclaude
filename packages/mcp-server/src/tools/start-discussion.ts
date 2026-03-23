/**
 * Start Discussion tool implementation with SOUL.md integration.
 *
 * This tool allows agents to initiate non-blocking discussions by creating
 * a new group chat (or using an existing one) and sending context to it.
 * Optionally loads a SOUL.md profile to inject discussion personality.
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 * Issue #1228: 讨论焦点保持 - 基于 SOUL.md 系统的讨论人格定义
 *
 * @module mcp-server/tools/start-discussion
 */

import { createLogger, getIpcClient, SoulLoader, resolveSoulPath } from '@disclaude/core';
import { send_interactive_message } from './interactive-message.js';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { StartDiscussionResult, StartDiscussionOptions } from './types.js';

const logger = createLogger('StartDiscussion');

/** Default soul name for discussions. */
const DEFAULT_DISCUSSION_SOUL = 'discussion';

/**
 * Load soul content for a discussion.
 *
 * Resolves the soul path and loads the SOUL.md content.
 * Returns empty string if soul is not found (graceful degradation).
 *
 * @param soulSpec - Soul name or path (defaults to "discussion")
 * @returns Soul content string, or empty string if not found
 */
async function loadDiscussionSoul(soulSpec?: string): Promise<{ content: string; loaded: boolean; path: string }> {
  const spec = soulSpec ?? DEFAULT_DISCUSSION_SOUL;
  const soulPath = resolveSoulPath(spec);

  if (!soulPath) {
    logger.debug({ soulSpec: spec }, 'Could not resolve soul path');
    return { content: '', loaded: false, path: '' };
  }

  const loader = new SoulLoader(soulPath);
  const result = await loader.load();

  if (result.loaded) {
    logger.info({ path: result.path, contentLength: result.content.length }, 'Discussion soul loaded');
    return { content: result.content, loaded: true, path: result.path };
  }

  logger.debug({ path: soulPath }, 'Discussion soul not found, using default behavior');
  return { content: '', loaded: false, path: soulPath };
}

/**
 * Build a discussion card structure.
 *
 * If soul content is available, includes a "Discussion Guidelines" section
 * that serves both as user-facing rules and agent personality injection.
 *
 * @param context - Discussion context/content
 * @param topic - Optional discussion topic
 * @param options - Optional response options for users
 * @param soulContent - Optional soul content for personality injection
 */
function buildDiscussionCard(
  context: string,
  topic?: string,
  options?: StartDiscussionOptions[],
  soulContent?: string,
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];

  // If soul content is loaded, include discussion guidelines
  if (soulContent) {
    elements.push({
      tag: 'markdown',
      content: `📌 **讨论规则**\n\n${soulContent}`,
    });
    elements.push({ tag: 'hr' });
  }

  // Main discussion context
  elements.push({
    tag: 'markdown',
    content: context,
  });

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
 * When a soul is specified (or defaults to "discussion"), loads the SOUL.md
 * profile and includes discussion guidelines in the card. This ensures the
 * agent participating in the discussion maintains focus on the topic.
 *
 * @example
 * ```typescript
 * // Create new group with discussion (uses default "discussion" soul)
 * await start_discussion({
 *   topic: '是否应该自动化代码格式化？',
 *   context: '在最近的任务中，发现代码格式化存在不一致的情况...',
 *   members: ['ou_xxx'],
 *   options: [
 *     { text: '是，应该自动化', value: 'yes', action: '创建格式化自动化配置' },
 *     { text: '不需要', value: 'no' },
 *   ],
 * });
 *
 * // Use existing group with custom soul
 * await start_discussion({
 *   chatId: 'oc_xxx',
 *   topic: 'PR Review 讨论',
 *   context: 'PR #123 需要讨论合并策略...',
 *   soul: 'review-discussion',
 * });
 * ```
 *
 * @param params - Discussion parameters
 * @returns Result with group chatId, messageId, and soul loading status
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
  /** Soul name or path for discussion personality (defaults to "discussion") */
  soul?: string;
}): Promise<StartDiscussionResult> {
  const { topic, context, chatId, members, options, soul } = params;

  logger.info({
    topic,
    hasChatId: !!chatId,
    memberCount: members?.length ?? 0,
    optionCount: options?.length ?? 0,
    contextLength: context?.length ?? 0,
    soul: soul ?? DEFAULT_DISCUSSION_SOUL,
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

    // Step 1: Load discussion soul (Issue #1228)
    let soulContent: string | undefined;
    let soulLoaded = false;
    try {
      const soulResult = await loadDiscussionSoul(soul);
      if (soulResult.loaded) {
        soulContent = soulResult.content;
        soulLoaded = true;
      }
    } catch (error) {
      // Soul loading failure should not block discussion creation
      logger.warn(
        { err: error instanceof Error ? error.message : String(error), soul },
        'Failed to load discussion soul, continuing without soul'
      );
    }

    // Step 2: Determine target chatId (create group or use existing)
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

    // Step 3: Send discussion context as interactive card (with soul if loaded)
    const card = buildDiscussionCard(context, topic, options, soulContent);
    const actionPrompts = options && options.length > 0
      ? buildActionPrompts(options, context)
      : {};

    const result = await send_interactive_message({
      chatId: targetChatId,
      card,
      actionPrompts,
    });

    if (result.success) {
      const soulInfo = soulLoaded ? ` (已加载讨论人格: ${soul ?? DEFAULT_DISCUSSION_SOUL})` : '';
      logger.info(
        { chatId: targetChatId, messageId: result.messageId, soulLoaded },
        'Discussion started successfully'
      );
      return {
        success: true,
        message: `✅ 讨论已发起${soulInfo}`,
        chatId: targetChatId,
        messageId: result.messageId,
        soulLoaded,
      };
    }

    return {
      success: false,
      error: result.error,
      message: `❌ 发送讨论内容失败: ${result.error}`,
      chatId: targetChatId,
      soulLoaded,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ err: error }, 'start_discussion failed');
    return {
      success: false,
      error: errorMessage,
      message: `❌ 发起讨论失败: ${errorMessage}`,
    };
  }
}
