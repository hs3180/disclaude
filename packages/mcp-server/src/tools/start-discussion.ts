/**
 * start_discussion tool implementation.
 *
 * Composite tool that orchestrates group creation, context delivery, and
 * optional temp chat registration for non-blocking offline discussions.
 *
 * Issue #631: Offline discussion - Agent leaves messages without blocking work.
 * This is the "极简版" (minimal version) that composes existing primitives:
 *   - create_chat: Create a new group chat
 *   - send_text: Send the context prompt to the chat
 *   - register_temp_chat: Optionally track the chat for lifecycle management
 *
 * No new IPC protocol types are needed — this tool runs entirely on the
 * MCP server side using existing IPC client methods.
 *
 * @module mcp-server/tools/start-discussion
 */

import { createLogger } from '@disclaude/core';
import { create_chat } from './create-chat.js';
import { send_text } from './send-message.js';
import { register_temp_chat } from './register-temp-chat.js';
import type { StartDiscussionResult } from './types.js';

const logger = createLogger('StartDiscussion');

/**
 * Start a new discussion topic.
 *
 * This is a composite operation that:
 * 1. If no chatId is provided, creates a new group chat
 * 2. Sends the context as a prompt message to the chat
 * 3. Optionally registers the chat for temp lifecycle management
 *
 * The tool returns immediately after sending (non-blocking). The ChatAgent
 * in the target chat will process the context asynchronously.
 *
 * @param params.chatId - Use existing chat ID (optional, mutually exclusive with members)
 * @param params.members - Member IDs to create a new group (optional, mutually exclusive with chatId)
 * @param params.topic - Discussion topic, used as group name when creating (optional)
 * @param params.context - The context/prompt to send to ChatAgent (required)
 * @param params.registerTemp - Whether to register as temp chat (default: true)
 * @param params.expiresIn - Temp chat TTL in hours (default: 24)
 */
export async function start_discussion(params: {
  chatId?: string;
  members?: string[];
  topic?: string;
  context: string;
  registerTemp?: boolean;
  expiresIn?: number;
}): Promise<StartDiscussionResult> {
  const {
    chatId,
    members,
    topic,
    context,
    registerTemp = true,
    expiresIn = 24,
  } = params;

  logger.info({
    hasChatId: !!chatId,
    memberCount: members?.length,
    hasTopic: !!topic,
    contextLength: context?.length,
    registerTemp,
    expiresIn,
  }, 'start_discussion called');

  try {
    // Validate required parameters
    if (!context || typeof context !== 'string') {
      return {
        success: false,
        error: 'context is required and must be a non-empty string',
        message: '⚠️ context 参数为必填项，且必须是非空字符串。',
      };
    }

    // Validate mutually exclusive params
    if (chatId && members) {
      return {
        success: false,
        error: 'chatId and members are mutually exclusive',
        message: '⚠️ chatId 和 members 不能同时指定。请选择使用现有群聊或创建新群聊。',
      };
    }

    // Step 1: Determine target chat
    let targetChatId: string;
    let chatName: string | undefined;

    if (chatId) {
      // Use existing chat
      targetChatId = chatId;
      logger.info({ chatId }, 'Using existing chat for discussion');
    } else {
      // Create a new group chat
      const createResult = await create_chat({
        name: topic,
        description: `Discussion: ${topic ?? 'Untitled'}`,
        memberIds: members,
      });

      if (!createResult.success) {
        logger.error({ error: createResult.error }, 'Failed to create chat for discussion');
        return {
          success: false,
          error: createResult.error ?? 'Failed to create group chat',
          message: `❌ 创建群聊失败: ${createResult.message}`,
        };
      }

      targetChatId = createResult.chatId!;
      chatName = createResult.name;
      logger.info({ chatId: targetChatId, name: chatName }, 'Created new chat for discussion');
    }

    // Step 2: Send context prompt to the chat
    const promptMessage = topic
      ? `## Discussion Topic: ${topic}\n\n${context}`
      : context;

    const sendResult = await send_text({
      text: promptMessage,
      chatId: targetChatId,
    });

    if (!sendResult.success) {
      logger.error(
        { chatId: targetChatId, error: sendResult.error },
        'Failed to send context to discussion chat'
      );
      return {
        success: false,
        chatId: targetChatId,
        error: sendResult.error ?? 'Failed to send message',
        message: `❌ 发送讨论内容失败: ${sendResult.message}`,
      };
    }

    logger.info({ chatId: targetChatId }, 'Discussion context sent');

    // Step 3: Optionally register as temp chat (only for newly created chats)
    if (registerTemp && !chatId) {
      const expiresAt = new Date(Date.now() + expiresIn * 60 * 60 * 1000).toISOString();
      const regResult = await register_temp_chat({
        chatId: targetChatId,
        expiresAt,
        context: { topic, source: 'start_discussion' },
      });

      if (!regResult.success) {
        // Non-fatal: log warning but don't fail the overall operation
        logger.warn(
          { chatId: targetChatId, error: regResult.error },
          'Failed to register temp chat (non-fatal)'
        );
      }
    }

    // Return immediately (non-blocking)
    const createdOrUsed = chatId ? 'used existing' : 'created new';
    return {
      success: true,
      chatId: targetChatId,
      name: chatName,
      message: `✅ Discussion started (${createdOrUsed} chat: ${targetChatId}). Context sent, returning immediately.`,
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
