/**
 * create_chat tool implementation.
 *
 * This tool creates a new Feishu group chat as an atomic capability.
 * The Agent can then use send_text/send_interactive to send messages
 * to the created group, composing the workflow itself.
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 * Rejected PR #1531 taught us: MCP tools should expose atomic capabilities,
 * not combine multiple operations into one tool.
 *
 * @module mcp-server/tools/create-chat
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { CreateChatResult } from './types.js';

const logger = createLogger('CreateChat');

/**
 * Create a new group chat via IPC to PrimaryNode's GroupService.
 *
 * Issue #631: Atomic create_chat capability.
 * The Agent composes the full workflow:
 *   1. create_chat({ topic: "...", members: [...] })  → get chatId
 *   2. send_text({ chatId, text: "..." })              → send context
 *   3. Continue working (non-blocking)
 *
 * @param params.topic - Optional chat topic/name (auto-generated if not provided)
 * @param params.members - Optional initial member open_ids
 */
export async function create_chat(params: {
  topic?: string;
  members?: string[];
}): Promise<CreateChatResult> {
  const { topic, members } = params;

  logger.info({
    topic,
    memberCount: members?.length ?? 0,
  }, 'create_chat called');

  try {
    // Check IPC availability
    if (!(await isIpcAvailable())) {
      const errorMsg = 'IPC service unavailable. Please ensure Primary Node is running.';
      logger.error(errorMsg);
      return {
        success: false,
        error: errorMsg,
        message: '❌ IPC 服务不可用。请检查 Primary Node 服务是否正在运行。',
      };
    }

    const ipcClient = getIpcClient();
    const result = await ipcClient.createChat(topic, members);

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ errorType: result.errorType, error: result.error }, 'create_chat IPC failed');
      return {
        success: false,
        error: result.error ?? 'Failed to create chat via IPC',
        message: errorMsg,
      };
    }

    const chatId = result.chatId;
    const chatName = result.chatName ?? topic ?? '未命名群聊';

    logger.info({ chatId, chatName }, 'Chat created successfully');

    const memberInfo = members && members.length > 0
      ? `\n👥 成员: ${members.length} 人`
      : '';

    return {
      success: true,
      chatId: chatId ?? '',
      chatName,
      message: `✅ 群聊已创建\n💬 群名: ${chatName}\n🆔 Chat ID: ${chatId}${memberInfo}\n\n💡 使用 send_text 或 send_interactive 向该群发送消息`,
    };

  } catch (error) {
    logger.error({ err: error }, 'create_chat FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to create chat: ${errorMessage}`,
    };
  }
}
