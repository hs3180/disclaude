/**
 * Welcome Handler for Feishu Channel.
 *
 * Handles welcome message events when bot enters chats or users join groups.
 *
 * Issue #463: 帮助消息系统 - 入群/私聊引导
 * Issue #676: 新用户加入群聊时发送 /help 信息
 */

import { createLogger } from '../../utils/logger.js';
import type { WelcomeService } from '../../platforms/feishu/welcome-service.js';
import type {
  FeishuChatMemberAddedEventData,
  FeishuP2PChatEnteredEventData,
} from '../../types/platform.js';

const logger = createLogger('WelcomeHandler');

/**
 * WelcomeHandler - Handles welcome message events.
 *
 * This class encapsulates the logic for handling:
 * - P2P chat entered events (user starts private chat with bot)
 * - Chat member added events (bot added to group, or users join group with bot)
 */
export class WelcomeHandler {
  private welcomeService?: WelcomeService;
  private appId: string;

  /**
   * @param appId - Bot's App ID for detecting when bot is added to group
   */
  constructor(appId: string) {
    this.appId = appId;
  }

  /**
   * Set the WelcomeService instance.
   */
  setWelcomeService(service: WelcomeService): void {
    this.welcomeService = service;
  }

  /**
   * Check if the handler is ready (has WelcomeService).
   */
  isReady(): boolean {
    return this.welcomeService !== undefined;
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
   *
   * @param data - Event data from Feishu
   */
  async handleP2PChatEntered(data: FeishuP2PChatEnteredEventData): Promise<void> {
    if (!this.welcomeService) {
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
   *
   * @param data - Event data from Feishu
   */
  async handleChatMemberAdded(data: FeishuChatMemberAddedEventData): Promise<void> {
    if (!this.welcomeService) {
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

    // Check if the bot is among the added members
    // Bot's member_id_type is "app_id" and member_id is the bot's app_id
    const botMemberAdded = event.members.some(
      (member) => member.member_id_type === 'app_id' && member.member_id === this.appId
    );

    // Get non-bot members (users who joined)
    const userMembers = event.members.filter(
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
