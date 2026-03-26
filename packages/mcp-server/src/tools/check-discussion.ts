/**
 * check_discussion tool implementation.
 *
 * Reads a temporary session's current state from its JSON file.
 * Also checks for expiry and updates status if overdue.
 *
 * @module mcp-server/tools/check-discussion
 */

import { createLogger } from '@disclaude/core';
import { readSession, expireOverdueSessions } from './temporary-session.js';
import type { CheckDiscussionResult } from './types.js';

const logger = createLogger('CheckDiscussion');

/**
 * Check the status of a discussion session.
 *
 * Reads the session file and returns its current state.
 * Automatically marks overdue sessions as expired.
 *
 * @param params.sessionId - The session identifier to check
 */
export async function check_discussion(params: {
  sessionId: string;
}): Promise<CheckDiscussionResult> {
  const { sessionId } = params;

  logger.info({ sessionId }, 'check_discussion called');

  try {
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      return {
        success: false,
        error: 'sessionId is required and must be a non-empty string',
        message: '❌ sessionId 参数不能为空',
      };
    }

    // Expire any overdue sessions first
    await expireOverdueSessions();

    const session = await readSession(sessionId.trim());

    if (!session) {
      return {
        success: false,
        error: `Session not found: ${sessionId}`,
        message: `❌ 会话未找到: ${sessionId}`,
      };
    }

    // Build a human-readable status summary
    const statusEmoji = {
      pending: '⏳',
      active: '🟢',
      expired: '🔴',
    }[session.status];

    const responseInfo = session.response
      ? `\nResponse: ${session.response.text} (${session.response.value}) at ${session.response.respondedAt}`
      : '\nNo response yet.';

    return {
      success: true,
      session,
      message: `${statusEmoji} Session ${session.sessionId}: ${session.status}\n` +
        `Topic: ${session.topic}\n` +
        `Chat: ${session.chatId ?? 'N/A'}\n` +
        `Created: ${session.createdAt}\n` +
        `Expires: ${session.expiresAt}` +
        responseInfo,
    };

  } catch (error) {
    logger.error({ err: error, sessionId }, 'check_discussion FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to check discussion: ${errorMessage}`,
    };
  }
}
