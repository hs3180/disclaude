/**
 * start_discussion tool implementation.
 *
 * Initiates a non-blocking discussion by creating (or reusing) a group chat
 * and sending a context prompt to it. The context message primes the ChatAgent
 * so it can present the topic to users when they reply.
 *
 * This is a lightweight composition of create_chat + send_text, keeping business
 * logic minimal and using platform-agnostic APIs throughout.
 *
 * @module mcp-server/tools/start-discussion
 */

import { createLogger } from '@disclaude/core';
import { create_chat } from './create-chat.js';
import { send_text } from './send-message.js';
import type { StartDiscussionResult } from './types.js';

const logger = createLogger('StartDiscussion');

/**
 * Start a non-blocking discussion.
 *
 * Flow:
 * 1. If chatId is provided, reuse it; otherwise create a new group chat.
 * 2. Send the context as a text message to the chat (primes the ChatAgent).
 * 3. Return immediately — the actual discussion happens asynchronously.
 *
 * @param params.chatId - Existing chat ID to reuse (optional)
 * @param params.members - Member IDs for a new chat (optional, used when chatId is not provided)
 * @param params.topic - Discussion topic, used as group name when creating a new chat (optional)
 * @param params.context - The context/prompt to send to the ChatAgent (required)
 */
export async function start_discussion(params: {
  chatId?: string;
  members?: string[];
  topic?: string;
  context: string;
}): Promise<StartDiscussionResult> {
  const { chatId, members, topic, context } = params;

  logger.info(
    { hasChatId: !!chatId, memberCount: members?.length, hasTopic: !!topic },
    'start_discussion called',
  );

  try {
    // Validate required parameter
    if (!context) {
      return {
        success: false,
        error: 'context is required',
        message: '❌ context 参数不能为空',
      };
    }

    // Step 1: Resolve target chatId
    let targetChatId = chatId;

    if (!targetChatId) {
      // Create a new group chat
      logger.info({ topic, memberCount: members?.length }, 'Creating new chat for discussion');

      const createResult = await create_chat({
        name: topic,
        memberIds: members,
      });

      if (!createResult.success) {
        logger.error({ error: createResult.error }, 'Failed to create chat for discussion');
        return {
          success: false,
          error: createResult.error,
          message: `❌ 创建讨论群失败: ${createResult.message}`,
        };
      }

      targetChatId = createResult.chatId;

      if (!targetChatId) {
        return {
          success: false,
          error: 'create_chat returned no chatId',
          message: '❌ 创建讨论群失败: 未返回 chatId',
        };
      }

      logger.info({ chatId: targetChatId }, 'Chat created for discussion');
    }

    // Step 2: Send context message to the chat
    logger.info({ chatId: targetChatId }, 'Sending context to discussion chat');

    const sendResult = await send_text({
      chatId: targetChatId,
      text: context,
    });

    if (!sendResult.success) {
      logger.error({ chatId: targetChatId, error: sendResult.error }, 'Failed to send context');
      return {
        success: false,
        chatId: targetChatId,
        error: sendResult.error,
        message: `❌ 发送讨论上下文失败: ${sendResult.message}`,
      };
    }

    logger.info({ chatId: targetChatId }, 'Discussion started successfully');
    return {
      success: true,
      chatId: targetChatId,
      message: `✅ Discussion started in ${targetChatId}`,
    };
  } catch (error) {
    logger.error({ err: error }, 'start_discussion FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to start discussion: ${errorMessage}`,
    };
  }
}
