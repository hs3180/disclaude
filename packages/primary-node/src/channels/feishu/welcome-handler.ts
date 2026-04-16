/**
 * Welcome Handler.
 *
 * Handles welcome messages for new chats and group joins.
 * Issue #463: Send welcome message on first private chat
 * Issue #676: Send help message when users join a group
 * Issue #694: Extracted from feishu-channel.ts
 *
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

import { createLogger, type FeishuChatMemberAddedEventData, type FeishuP2PChatEnteredEventData } from '@disclaude/core';
import type { WelcomeService } from '../../platforms/feishu/welcome-service.js';

const logger = createLogger('WelcomeHandler');

/**
 * Welcome Handler.
 *
 * Handles P2P chat entered and chat member added events.
 */
export class WelcomeHandler {
  private welcomeService?: WelcomeService;
  private appId: string;
  private isRunning: () => boolean;

  /**
   * Create a WelcomeHandler.
   *
   * @param appId - Feishu App ID for bot identification
   * @param isRunning - Function to check if channel is running
   */
  constructor(appId: string, isRunning: () => boolean) {
    this.appId = appId;
    this.isRunning = isRunning;
  }

  /**
   * Set the WelcomeService.
   */
  setWelcomeService(service: WelcomeService): void {
    this.welcomeService = service;
  }

  /**
   * Check if a group was recently added (bot was added within TTL) and consume the flag.
   * Issue #2284: Used by message handler to inject auto-rename guidance.
   *
   * @param chatId - The chat ID to check
   * @returns true if the group was recently added (flag is consumed), false otherwise
   */
  consumeIfRecentlyAddedGroup(chatId: string): boolean {
    return this.welcomeService?.consumeIfRecentlyAdded(chatId) ?? false;
  }

  /**
   * Check if a chat ID is a group chat based on ID prefix.
   * In Feishu, group chat IDs start with 'oc_' and private chat IDs start with 'ou_'.
   *
   * @param chatId - Chat ID to check
   * @returns true if it's a group chat ID
   */
  private isGroupChatId(chatId: string): boolean {
    return chatId.startsWith('oc_');
  }

  /**
   * Handle P2P chat entered event.
   * Triggered when a user starts a private chat with the bot.
   */
  async handleP2PChatEntered(data: FeishuP2PChatEnteredEventData): Promise<void> {
    if (!this.isRunning() || !this.welcomeService) {
      return;
    }

    const { event } = data;
    if (!event?.user?.open_id) {
      logger.debug('P2P chat entered event missing user info');
      return;
    }

    const userId = event.user.open_id;
    logger.info({ userId }, 'P2P chat entered, sending welcome message');

    await this.welcomeService.handleP2PChatEntered(userId);
  }

  /**
   * Handle chat member added event.
   * Triggered when members are added to a chat.
   */
  async handleChatMemberAdded(data: FeishuChatMemberAddedEventData): Promise<void> {
    if (!this.isRunning() || !this.welcomeService) {
      return;
    }

    const { event } = data;
    if (!event?.chat_id || !event?.members || event.members.length === 0) {
      logger.debug('Chat member added event missing required fields');
      return;
    }

    // Only send messages to group chats
    if (!this.isGroupChatId(event.chat_id)) {
      logger.debug({ chatId: event.chat_id }, 'Member added to non-group chat, skipping');
      return;
    }

    // Filter out null/undefined entries from members array (defensive)
    const members = event.members.filter((m): m is NonNullable<typeof m> => m !== null && m !== undefined);

    // Check if the bot is among the added members
    // Bot's member_id_type is "app_id" and member_id is the bot's app_id
    const botMemberAdded = members.some(
      (member) => member.member_id_type === 'app_id' && member.member_id === this.appId
    );

    // Get non-bot members (users who joined)
    const userMembers = members.filter(
      (member) => !(member.member_id_type === 'app_id' && member.member_id === this.appId)
    );

    if (botMemberAdded) {
      // Bot was added to the group -> send welcome message
      logger.info({ chatId: event.chat_id }, 'Bot added to group, sending welcome message');
      await this.welcomeService.handleBotAddedToGroup(event.chat_id);
    } else if (userMembers.length > 0) {
      // Users joined a group that already has the bot -> send help message
      logger.info(
        { chatId: event.chat_id, userCount: userMembers.length },
        'New users joined group, sending help message'
      );
      const userIds = userMembers.map((m) => m.member_id);
      await this.welcomeService.handleUserJoinedGroup(event.chat_id, userIds);
    }
  }
}
