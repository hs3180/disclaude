/**
 * Discussion tool implementation for Issue #631.
 *
 * This tool enables agents to start offline discussions in new or existing chats.
 * The agent can spawn a ChatAgent to facilitate the discussion without blocking
 * the current work.
 *
 * Features:
 * - Create a new discussion group or use existing chat
 * - Provide context material for the discussion
 * - Define follow-up actions after discussion completes
 *
 * @module mcp/tools/discussion
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import { getGroupService } from '../../platforms/feishu/group-service.js';
import { getSubagentManager, type DiscussionResult } from '../../agents/subagent-manager.js';
import type { PilotCallbacks } from '../../agents/pilot/index.js';

const logger = createLogger('DiscussionTool');

/**
 * Options for starting a discussion.
 */
export interface StartDiscussionOptions {
  /** The topic/question to discuss */
  topic: string;
  /** Context material for the discussion (background info, related data, etc.) */
  context?: string;
  /** Initial members to invite (open_ids). If empty, only the creator is added */
  members?: string[];
  /** Optional group name/topic. Auto-generated if not provided */
  groupName?: string;
  /** Creator's open_id for tracking and auto-adding */
  creatorId?: string;
  /** Existing chat ID to use instead of creating a new group */
  existingChatId?: string;
  /** Callback when discussion completes */
  onDiscussionComplete?: (result: DiscussionResult) => void | Promise<void>;
}

/**
 * Result of starting a discussion.
 */
export interface StartDiscussionResult {
  /** Whether the discussion was started successfully */
  success: boolean;
  /** The chat ID where the discussion is taking place */
  chatId?: string;
  /** The subagent ID managing the discussion */
  subagentId?: string;
  /** Error message if failed */
  error?: string;
  /** User-friendly message */
  message: string;
}

/**
 * Build PilotCallbacks for the discussion agent.
 *
 * @param client - Feishu client for API calls
 * @returns PilotCallbacks implementation
 */
function buildDiscussionCallbacks(_client: lark.Client): PilotCallbacks {
  return {
    sendMessage: (chatId: string, text: string, parentMessageId?: string) => {
      // Use IPC or direct API to send message
      logger.debug({ chatId, parentMessageId }, 'Discussion agent sending message');
      // For now, we'll use the Feishu API directly
      // In production, this should go through IPC
    },
    sendCard: (chatId: string, card: Record<string, unknown>, description?: string, parentMessageId?: string) => {
      logger.debug({ chatId, parentMessageId }, 'Discussion agent sending card');
    },
    sendFile: (chatId: string, filePath: string) => {
      logger.debug({ chatId, filePath }, 'Discussion agent sending file');
    },
  };
}

/**
 * Start an offline discussion (Issue #631).
 *
 * This tool creates a discussion group (or uses an existing chat) and spawns
 * a ChatAgent to facilitate the discussion. The main agent can continue working
 * while the discussion proceeds in the background.
 *
 * @example
 * ```typescript
 * const result = await start_discussion({
 *   topic: '如何优化用户反馈处理流程',
 *   context: '最近一周收到 50 条用户反馈，其中 30% 与登录问题相关...',
 *   members: ['ou_xxx', 'ou_yyy'],
 *   creatorId: 'ou_zzz',
 * });
 * ```
 */
export async function start_discussion(params: {
  /** The topic/question to discuss */
  topic: string;
  /** Context material for the discussion */
  context?: string;
  /** Initial members to invite (open_ids) */
  members?: string[];
  /** Optional group name */
  groupName?: string;
  /** Creator's open_id */
  creatorId?: string;
  /** Existing chat ID to use */
  existingChatId?: string;
}): Promise<StartDiscussionResult> {
  const { topic, context, members, groupName, creatorId, existingChatId } = params;

  logger.info({
    topic,
    hasContext: !!context,
    memberCount: members?.length ?? 0,
    existingChatId,
  }, 'start_discussion called');

  try {
    // Validate required parameters
    if (!topic) {
      return {
        success: false,
        error: 'topic is required',
        message: '❌ 请提供讨论话题',
      };
    }

    // Get Feishu credentials
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured';
      logger.error(errorMsg);
      return {
        success: false,
        error: errorMsg,
        message: '❌ Feishu 凭证未配置，无法创建讨论',
      };
    }

    // Create Feishu client
    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    // Determine chat ID
    let chatId: string;

    if (existingChatId) {
      // Use existing chat
      chatId = existingChatId;
      logger.info({ chatId }, 'Using existing chat for discussion');
    } else {
      // Create a new discussion group
      const groupService = getGroupService();
      const group = await groupService.createGroup(client, {
        topic: groupName || `讨论: ${topic.slice(0, 50)}${topic.length > 50 ? '...' : ''}`,
        members,
        creatorId,
      });
      ({ chatId } = group);
      logger.info({ chatId, groupName: group.name }, 'Created new discussion group');
    }

    // Get the subagent manager
    const manager = getSubagentManager();
    if (!manager) {
      return {
        success: false,
        error: 'SubagentManager not initialized',
        message: '❌ 子代理管理器未初始化',
      };
    }

    // Build callbacks for the discussion agent
    const callbacks = buildDiscussionCallbacks(client);

    // Spawn a chat agent for the discussion
    const handle = await manager.spawn({
      type: 'chat',
      name: 'discussion-agent',
      prompt: topic,
      chatId,
      callbacks,
      discussionContext: context,
      senderOpenId: creatorId,
      timeout: 24 * 60 * 60 * 1000, // 24 hours default timeout
    });

    logger.info({ subagentId: handle.id, chatId }, 'Discussion agent spawned');

    return {
      success: true,
      chatId,
      subagentId: handle.id,
      message: existingChatId
        ? `✅ 已在现有群聊中发起讨论「${topic}」`
        : `✅ 已创建讨论群并发起讨论「${topic}」\n\n群聊 ID: ${chatId}\n子代理 ID: ${handle.id}`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ err: error }, 'Failed to start discussion');
    return {
      success: false,
      error: errorMessage,
      message: `❌ 发起讨论失败: ${errorMessage}`,
    };
  }
}

/**
 * MCP tool definition for start_discussion.
 */
export const discussionToolDefinition = {
  name: 'start_discussion',
  description: `发起离线讨论（Issue #631）

创建一个讨论群（或使用现有群聊），并启动一个 Chat Agent 来主持讨论。
主 Agent 可以继续工作，讨论在后台进行。

使用场景：
- 每日回顾分析后发起深入讨论
- 收集用户对某个功能的反馈
- 讨论改进方案并收集意见

讨论完成后，Agent 会根据讨论结果建议后续行动（创建 issue、skill 或定时任务）。`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      topic: {
        type: 'string',
        description: '讨论话题或问题',
      },
      context: {
        type: 'string',
        description: '讨论背景信息（可选）',
      },
      members: {
        type: 'array',
        items: { type: 'string' },
        description: '邀请成员的 open_id 列表（可选）',
      },
      groupName: {
        type: 'string',
        description: '群聊名称（可选，自动生成）',
      },
      creatorId: {
        type: 'string',
        description: '创建者的 open_id（可选）',
      },
      existingChatId: {
        type: 'string',
        description: '现有群聊 ID（可选，不创建新群）',
      },
    },
    required: ['topic'],
  },
};
