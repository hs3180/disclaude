/**
 * Session End Manager.
 *
 * Manages the cleanup flow when a session-end trigger phrase is detected.
 * Handles group dissolution and unregistration — no file system dependencies.
 *
 * Flow:
 * 1. Trigger phrase detected in agent's outgoing text message
 * 2. Manager unregisters group from GroupService
 * 3. Manager dissolves the group chat via Feishu API
 *
 * Simplified from the initial PR #1449 implementation:
 * - Only handles text messages (no rich text/card support)
 * - No session record file (session-records.md removed)
 * - No workspaceDir dependency
 *
 * @see Issue #1229 - 智能会话结束 - 判断讨论何时可以关闭
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '@disclaude/core';
import { dissolveChat } from '../../platforms/feishu/chat-ops.js';
import type { GroupService } from '../../platforms/feishu/group-service.js';
import type { TriggerResult } from './trigger-detector.js';

const logger = createLogger('SessionEndManager');

/**
 * Session end manager — handles cleanup when a discussion session ends.
 *
 * Orchestrates the cleanup flow when a discussion session ends via trigger phrase.
 * No file system dependencies — only interacts with GroupService and Feishu API.
 */
export class SessionEndManager {
  private groupService: GroupService;

  constructor(groupService: GroupService) {
    this.groupService = groupService;
  }

  /**
   * Handle session end trigger.
   *
   * This is the main entry point called when a trigger phrase is detected.
   * It performs the cleanup sequence:
   * 1. Log the session end
   * 2. Unregister from GroupService
   * 3. Dissolve the chat (if bot-created)
   *
   * @param chatId - The chat ID where the trigger was detected
   * @param trigger - The trigger detection result
   * @param client - Feishu API client (needed for dissolveChat)
   * @returns Whether the session was successfully ended
   */
  async handleSessionEnd(
    chatId: string,
    trigger: TriggerResult,
    client: lark.Client
  ): Promise<boolean> {
    const groupInfo = this.groupService.getGroup(chatId);
    const isManaged = this.groupService.isManaged(chatId);

    logger.info(
      {
        chatId,
        reason: trigger.reason,
        hasSummary: !!trigger.summary,
        isManaged,
        groupName: groupInfo?.name,
      },
      'Session end triggered'
    );

    // Only handle managed groups (bot-created)
    if (!isManaged) {
      logger.debug({ chatId }, 'Skipping session end for unmanaged group');
      return false;
    }

    // Step 1: Unregister from GroupService
    const unregistered = this.groupService.unregisterGroup(chatId);
    if (!unregistered) {
      logger.warn({ chatId }, 'Failed to unregister group');
    }

    // Step 2: Dissolve the chat via Feishu API
    try {
      await dissolveChat(client, chatId);
      logger.info({ chatId, reason: trigger.reason }, 'Session ended successfully');
      return true;
    } catch (error) {
      // Group was already unregistered, so log the error but don't re-throw
      logger.error({ err: error, chatId }, 'Failed to dissolve chat after unregister');
      return false;
    }
  }
}
