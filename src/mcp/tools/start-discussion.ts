/**
 * start_discussion tool implementation.
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 *
 * This tool allows the agent to create a discussion group and leave a message
 * for the user to respond to later. It's non-blocking - the agent can continue
 * its work while waiting for the user to reply.
 *
 * @module mcp/tools/start-discussion
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import { getGroupService, type CreateGroupOptions } from '../../platforms/feishu/group-service.js';
import { sendMessageToFeishu } from '../utils/feishu-api.js';
import { getIpcClient } from '../../ipc/unix-socket-client.js';
import { existsSync } from 'fs';
import { DEFAULT_IPC_CONFIG } from '../../ipc/protocol.js';

const logger = createLogger('StartDiscussion');

/**
 * Check if IPC is available for Feishu API calls.
 */
function isIpcAvailable(): boolean {
  return existsSync(DEFAULT_IPC_CONFIG.socketPath);
}

/**
 * Parameters for start_discussion tool.
 */
export interface StartDiscussionParams {
  /** Use existing chat ID (optional) */
  chatId?: string;
  /** Create new chat with these members (optional) */
  members?: string[];
  /** Discussion topic (used for group name) */
  topic?: string;
  /** Context to send to ChatAgent */
  context: string;
}

/**
 * Result of start_discussion tool.
 */
export interface StartDiscussionResult {
  success: boolean;
  chatId?: string;
  messageId?: string;
  error?: string;
  message: string;
}

/**
 * Format the discussion context as a prompt message.
 */
function formatDiscussionPrompt(topic: string | undefined, context: string): string {
  const topicLine = topic ? `**讨论主题**: ${topic}\n\n` : '';
  return `${topicLine}**背景说明**:\n${context}

---
*这是一条离线留言。请在方便时回复此消息继续讨论。*`;
}

/**
 * start_discussion tool implementation.
 *
 * Creates a discussion group (or uses existing) and sends context message.
 * Non-blocking - returns immediately after sending.
 */
export async function start_discussion(params: StartDiscussionParams): Promise<StartDiscussionResult> {
  const { chatId: existingChatId, members, topic, context } = params;

  logger.info({
    existingChatId,
    memberCount: members?.length,
    topic,
    contextLength: context.length,
  }, 'start_discussion called');

  try {
    if (!context) {
      return { success: false, message: '❌ context is required' };
    }

    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured';
      logger.error(errorMsg);
      return { success: false, message: `❌ ${errorMsg}` };
    }

    let targetChatId: string;

    if (existingChatId) {
      // Use existing chat
      targetChatId = existingChatId;
      logger.info({ chatId: targetChatId }, 'Using existing chat');
    } else {
      // Create new group chat
      const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });
      const groupService = getGroupService();

      const createOptions: CreateGroupOptions = {
        topic: topic || '离线讨论',
        members: members || [],
      };

      logger.info({ createOptions }, 'Creating new discussion group');
      const groupInfo = await groupService.createGroup(client, createOptions);
      targetChatId = groupInfo.chatId;
      logger.info({ chatId: targetChatId, topic }, 'Discussion group created');
    }

    // Format and send the discussion prompt
    const promptMessage = formatDiscussionPrompt(topic, context);

    // Try IPC first if available
    const useIpc = isIpcAvailable();
    let messageId: string | undefined;

    if (useIpc) {
      const ipcClient = getIpcClient();
      const result = await ipcClient.feishuSendMessage(targetChatId, promptMessage);
      if (!result.success) {
        logger.error({ error: result.error, errorType: result.errorType }, 'IPC message failed');
        return {
          success: false,
          message: `❌ 发送讨论消息失败: ${result.error || '未知错误'}`,
        };
      }
      messageId = result.messageId;
    } else {
      // Fallback: Create client directly
      const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });
      await sendMessageToFeishu(client, targetChatId, 'text', JSON.stringify({ text: promptMessage }));
    }

    logger.info({ chatId: targetChatId, messageId }, 'Discussion context sent');

    return {
      success: true,
      chatId: targetChatId,
      messageId,
      message: `✅ 讨论已发起\n- 群聊ID: \`${targetChatId}\`\n- 主题: ${topic || '未指定'}\n\n用户可以在方便时回复此讨论。`,
    };

  } catch (error) {
    logger.error({ err: error }, 'start_discussion FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, message: `❌ 发起讨论失败: ${errorMessage}` };
  }
}
