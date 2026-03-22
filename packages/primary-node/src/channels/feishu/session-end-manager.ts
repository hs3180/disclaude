/**
 * Session End Manager.
 *
 * Manages the cleanup flow when a session-end trigger phrase is detected.
 * Handles group dissolution, unregistration, and logging.
 *
 * Flow:
 * 1. Trigger phrase detected in agent's outgoing message
 * 2. Manager sends a farewell message (optional)
 * 3. Unregister group from GroupService
 * 4. Dissolve the group chat via Feishu API
 *
 * @see Issue #1229 - 智能会话结束 - 判断讨论何时可以关闭
 */

import * as fs from 'fs';
import * as path from 'path';
import type * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '@disclaude/core';
import { dissolveChat } from '../../platforms/feishu/chat-ops.js';
import { type GroupService } from '../../platforms/feishu/group-service.js';
import type { TriggerResult } from './trigger-detector.js';

const logger = createLogger('SessionEndManager');

/**
 * Configuration for SessionEndManager.
 */
export interface SessionEndManagerConfig {
  /** Group service for managing bot-created groups */
  groupService: GroupService;
  /** Directory for storing session records */
  workspaceDir?: string;
}

/**
 * Session record stored when a discussion ends.
 */
export interface SessionRecord {
  /** Group chat ID */
  chatId: string;
  /** Group name */
  groupName?: string;
  /** Session end reason */
  reason?: string;
  /** Summary provided by the agent */
  summary?: string;
  /** Session end timestamp */
  endedAt: number;
  /** Session duration in milliseconds (from group creation) */
  durationMs?: number;
}

/**
 * Session End Manager.
 *
 * Orchestrates the cleanup flow when a discussion session ends via trigger phrase.
 */
export class SessionEndManager {
  private groupService: GroupService;
  private workspaceDir: string;

  constructor(config: SessionEndManagerConfig) {
    this.groupService = config.groupService;
    this.workspaceDir = config.workspaceDir || process.cwd();
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

    logger.info(
      {
        chatId,
        reason: trigger.reason,
        hasSummary: !!trigger.summary,
        isManaged: this.groupService.isManaged(chatId),
        groupName: groupInfo?.name,
      },
      'Session end triggered'
    );

    // Save session record
    const record = this.buildSessionRecord(chatId, trigger, groupInfo);
    this.saveSessionRecord(record);

    // Step 1: Unregister from GroupService
    if (this.groupService.isManaged(chatId)) {
      this.groupService.unregisterGroup(chatId);
      logger.info({ chatId }, 'Group unregistered from GroupService');
    }

    // Step 2: Dissolve the chat via Feishu API
    try {
      await dissolveChat(client, chatId);
      logger.info({ chatId }, 'Chat dissolved successfully');
      return true;
    } catch (error) {
      logger.error(
        { err: error, chatId },
        'Failed to dissolve chat - group may still be accessible'
      );
      return false;
    }
  }

  /**
   * Build a session record from the trigger result and group info.
   */
  private buildSessionRecord(
    chatId: string,
    trigger: TriggerResult,
    groupInfo: { name?: string; createdAt?: number } | undefined
  ): SessionRecord {
    const now = Date.now();
    return {
      chatId,
      groupName: groupInfo?.name,
      reason: trigger.reason,
      summary: trigger.summary,
      endedAt: now,
      durationMs: groupInfo?.createdAt ? now - groupInfo.createdAt : undefined,
    };
  }

  /**
   * Save session record to workspace.
   *
   * Records are appended to a Markdown file for easy review.
   */
  private saveSessionRecord(record: SessionRecord): void {
    try {
      const recordsDir = path.join(this.workspaceDir, 'workspace');
      if (!fs.existsSync(recordsDir)) {
        fs.mkdirSync(recordsDir, { recursive: true });
      }

      const filePath = path.join(recordsDir, 'session-records.md');
      const date = new Date(record.endedAt).toLocaleString('zh-CN');
      const duration = record.durationMs
        ? `${Math.round(record.durationMs / 60000)}分钟`
        : '未知';

      const entry = [
        '',
        `## ${date} - ${record.groupName || record.chatId}`,
        '',
        `- **结束原因**: ${record.reason || '正常结束'}`,
        `- **持续时间**: ${duration}`,
        ...(record.summary ? [`- **总结**: ${record.summary}`] : []),
        `- **群组ID**: ${record.chatId}`,
        '',
      ].join('\n');

      // Append or create file
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, `# 会话记录\n\n自动记录已结束的讨论会话。\n`, 'utf-8');
      }

      fs.appendFileSync(filePath, entry, 'utf-8');
      logger.debug({ filePath, chatId: record.chatId }, 'Session record saved');
    } catch (error) {
      // Don't fail the session end if record saving fails
      logger.warn({ err: error }, 'Failed to save session record');
    }
  }
}
