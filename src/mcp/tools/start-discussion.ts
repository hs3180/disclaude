/**
 * start_discussion tool implementation.
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 *
 * This tool allows an agent to initiate a discussion by creating a new group chat
 * or using an existing one, then sending context information to the ChatAgent.
 *
 * @module mcp/tools/start-discussion
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import { createDiscussionChat } from '../../platforms/feishu/chat-ops.js';
import { getGroupService } from '../../platforms/feishu/group-service.js';
import { getLarkClientService, isLarkClientServiceInitialized } from '../../services/index.js';
import { send_message } from './send-message.js';

const logger = createLogger('StartDiscussion');

/**
 * Result type for start_discussion tool.
 */
export interface StartDiscussionResult {
  success: boolean;
  message: string;
  chatId?: string;
  error?: string;
}

/**
 * Discussion prompt template for ChatAgent.
 *
 * This template wraps the context information to help ChatAgent understand
 * the discussion purpose and provide appropriate responses.
 */
function formatDiscussionPrompt(topic: string, context: string): string {
  return `## 📢 离线讨论请求

**话题**: ${topic}

### 背景信息

${context}

---

请就以上话题与用户进行讨论。你需要：
1. 理解用户的问题和关注点
2. 提供有帮助的回复或建议
3. 如果需要更多信息，主动询问

---
*此讨论由 Agent 发起，用于非阻塞式交互*`;
}

/**
 * Start a discussion by creating a new group chat or using an existing one.
 *
 * This tool implements Issue #631 - "离线提问 - Agent 不阻塞工作的留言机制".
 *
 * Key features:
 * - Creates a new group chat with specified members
 * - Sends context information wrapped as a prompt for ChatAgent
 * - Non-blocking - returns immediately after creating the discussion
 *
 * @param params - Tool parameters
 * @returns Result with success status and chat ID
 *
 * @example
 * ```typescript
 * const result = await start_discussion({
 *   topic: 'API 设计讨论',
 *   members: ['ou_xxx', 'ou_yyy'],
 *   context: '我们需要讨论新 API 的设计...',
 * });
 * ```
 */
export async function start_discussion(params: {
  /** Discussion topic (used as group name) */
  topic: string;
  /** Member open_ids to invite to the discussion */
  members: string[];
  /** Context information to send to ChatAgent */
  context: string;
}): Promise<StartDiscussionResult> {
  const { topic, members, context } = params;

  logger.info({
    topic,
    memberCount: members?.length ?? 0,
    contextLength: context?.length ?? 0,
  }, 'start_discussion called');

  try {
    // Validate required parameters
    if (!topic) {
      return {
        success: false,
        message: '❌ topic is required',
        error: 'topic is required',
      };
    }

    if (!context) {
      return {
        success: false,
        message: '❌ context is required',
        error: 'context is required',
      };
    }

    // Get Feishu client
    let client: lark.Client;

    if (isLarkClientServiceInitialized()) {
      client = getLarkClientService().getClient();
    } else {
      // Fallback: Create client directly
      const appId = Config.FEISHU_APP_ID;
      const appSecret = Config.FEISHU_APP_SECRET;

      if (!appId || !appSecret) {
        const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
        logger.error({ topic }, errorMsg);
        return {
          success: false,
          message: `❌ ${errorMsg}`,
          error: errorMsg,
        };
      }

      client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });
    }

    // Create the discussion group
    const chatId = await createDiscussionChat(client, { topic, members });

    // Register the group for tracking
    const groupService = getGroupService();
    groupService.registerGroup({
      chatId,
      name: topic,
      createdAt: Date.now(),
      initialMembers: members || [],
    });

    logger.info({ chatId, topic, memberCount: members?.length ?? 0 }, 'Discussion group created');

    // Format the discussion prompt
    const discussionPrompt = formatDiscussionPrompt(topic, context);

    // Send the context as a prompt to the ChatAgent
    const sendResult = await send_message({
      content: discussionPrompt,
      format: 'text',
      chatId,
    });

    if (!sendResult.success) {
      logger.error({ chatId, error: sendResult.error }, 'Failed to send discussion prompt');
      // Still return success for group creation, but note the message failure
      return {
        success: true,
        chatId,
        message: `✅ 讨论群已创建，但发送上下文失败: ${sendResult.error}`,
      };
    }

    logger.info({ chatId, topic }, 'Discussion started successfully');

    return {
      success: true,
      chatId,
      message: `✅ 离线讨论已启动

- **群聊 ID**: ${chatId}
- **话题**: ${topic}
- **成员数**: ${members?.length ?? 0}

ChatAgent 已收到上下文信息，将与用户进行讨论。此操作为非阻塞式，您可以继续其他工作。`,
    };
  } catch (error) {
    logger.error({ err: error, topic }, 'start_discussion FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      message: `❌ 启动讨论失败: ${errorMessage}`,
      error: errorMessage,
    };
  }
}
