/**
 * start_discussion tool implementation.
 *
 * Creates a temporary discussion session: optionally creates a group chat,
 * sends an interactive card, and persists session state as a JSON file.
 *
 * This implements the temporary session mechanism from Issue #1317 inline
 * (no Manager class, direct file I/O). Session files are stored in
 * workspace/temporary-sessions/ as JSON.
 *
 * @module mcp-server/tools/start-discussion
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import {
  generateSessionId,
  writeSession,
} from './temporary-session.js';
import type { StartDiscussionResult, SessionOption, ActionPromptMap, TemporarySession } from './types.js';

const logger = createLogger('StartDiscussion');

/**
 * Start a discussion session.
 *
 * Workflow:
 * 1. Generate a session ID and create a session JSON file (status: pending)
 * 2. If no chatId provided, create a new group chat via IPC
 * 3. Send an interactive card with the discussion content
 * 4. Update session file (status: active, chatId, messageId)
 *
 * @param params.topic - Discussion topic (used for session ID and optional group name)
 * @param params.message - The message content to display in the interactive card
 * @param params.options - Button options for user interaction
 * @param params.chatId - Existing chat ID (optional, creates new group if not provided)
 * @param params.memberIds - Member IDs for new group creation (optional)
 * @param params.groupName - Name for the new group (optional, defaults to topic)
 * @param params.actionPrompts - Custom action prompts (optional)
 * @param params.context - Use-case specific context stored in session (optional)
 * @param params.expiresInMinutes - Session expiry time in minutes (default: 1440 = 24h)
 */
export async function start_discussion(params: {
  topic: string;
  message: string;
  options: SessionOption[];
  chatId?: string;
  memberIds?: string[];
  groupName?: string;
  actionPrompts?: ActionPromptMap;
  context?: Record<string, unknown>;
  expiresInMinutes?: number;
}): Promise<StartDiscussionResult> {
  const {
    topic,
    message,
    options,
    chatId: providedChatId,
    memberIds,
    groupName,
    actionPrompts,
    context,
    expiresInMinutes = 1440,
  } = params;

  logger.info({ topic, hasChatId: !!providedChatId, optionCount: options?.length }, 'start_discussion called');

  try {
    // Validate required parameters
    if (!topic || typeof topic !== 'string' || topic.trim().length === 0) {
      return {
        success: false,
        error: 'topic is required and must be a non-empty string',
        message: '❌ topic 参数不能为空',
      };
    }
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return {
        success: false,
        error: 'message is required and must be a non-empty string',
        message: '❌ message 参数不能为空',
      };
    }
    if (!Array.isArray(options) || options.length === 0) {
      return {
        success: false,
        error: 'options is required and must be a non-empty array',
        message: '❌ options 参数必须为非空数组',
      };
    }

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
    const sessionId = generateSessionId(topic);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString();

    // Step 1: Create session file (status: pending)
    const session: TemporarySession = {
      sessionId,
      status: 'pending',
      chatId: providedChatId ?? null,
      messageId: null,
      createdAt: now,
      updatedAt: now,
      expiresAt,
      topic: topic.trim(),
      message: message.trim(),
      options,
      actionPrompts: actionPrompts ?? {},
      context: context ?? {},
      response: null,
    };

    await writeSession(session);
    logger.info({ sessionId, status: 'pending' }, 'Session file created');

    // Step 2: Create group chat if no chatId provided
    let chatId = providedChatId;
    if (!chatId) {
      const chatResult = await ipcClient.createChat(
        groupName ?? topic.trim(),
        undefined,
        memberIds
      );

      if (!chatResult.success) {
        const errorMsg = getIpcErrorMessage(chatResult.errorType, chatResult.error);
        logger.error({ errorType: chatResult.errorType, error: chatResult.error }, 'Group creation failed');
        return {
          success: false,
          error: `Failed to create group: ${chatResult.error}`,
          message: `❌ 群聊创建失败: ${errorMsg}`,
        };
      }

      chatId = chatResult.chatId;
      logger.info({ sessionId, chatId }, 'Group chat created');
    }

    // Step 3: Send interactive card
    const sendResult = await ipcClient.sendInteractive(chatId!, {
      question: message.trim(),
      options,
      title: topic.trim(),
      context: context ? JSON.stringify(context) : undefined,
      actionPrompts,
    });

    if (!sendResult.success) {
      const errorMsg = getIpcErrorMessage(sendResult.errorType, sendResult.error);
      logger.error({ errorType: sendResult.errorType, error: sendResult.error }, 'Interactive card send failed');
      return {
        success: false,
        error: `Failed to send interactive card: ${sendResult.error}`,
        message: `❌ 交互卡片发送失败: ${errorMsg}`,
      };
    }

    // Step 4: Update session file (status: active)
    session.chatId = chatId!;
    session.messageId = sendResult.messageId ?? null;
    session.status = 'active';
    session.updatedAt = new Date().toISOString();
    await writeSession(session);
    logger.info({ sessionId, chatId, status: 'active' }, 'Session activated');

    return {
      success: true,
      sessionId,
      chatId,
      message: `✅ Discussion started (session: ${sessionId}, chat: ${chatId})`,
    };

  } catch (error) {
    logger.error({ err: error, topic }, 'start_discussion FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to start discussion: ${errorMessage}`,
    };
  }
}
