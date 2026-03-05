/**
 * Welcome Event Handler.
 *
 * Handles Feishu welcome-related events:
 * - P2P chat entered (user starts private chat with bot)
 * - Chat member added (bot or users added to group)
 *
 * Issue #463: 帮助消息系统 - 入群/私聊引导
 * Issue #676: 新用户加入群聊时发送 /help 信息
 * Extracted from feishu-channel.ts for Issue #694.
 */

import { createLogger } from '../../utils/logger.js';
import type { WelcomeService } from '../../platforms/feishu/welcome-service.js';
import type {
  FeishuP2PChatEnteredEventData,
  FeishuChatMemberAddedEventData,
} from '../../types/platform.js';

const logger = createLogger('WelcomeEventHandler');

/**
 * WelcomeEventHandlerDeps - Dependencies for welcome event handler.
 */
export interface WelcomeEventHandlerDeps {
  /** Check if channel is running */
  isRunning: () => boolean;
  /** Get the welcome service */
  getWelcomeService: () => WelcomeService | undefined;
  /** Get the app ID for bot detection */
  getAppId: () => string;
}

/**
 * WelcomeEventHandler - Handles welcome-related Feishu events.
 */
export class WelcomeEventHandler {
  constructor(private readonly deps: WelcomeEventHandlerDeps) {}

  /**
   * Check if a chat ID is a group chat based on ID prefix.
   * In Feishu, group chat IDs start with 'oc_' and private chat IDs start with 'ou_'.
   *
   * Issue #676: Used in handleChatMemberAdded where chat_type is not available.
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
   * Issue #463: Send welcome message on first private chat.
   */
  async handleP2PChatEntered(data: FeishuP2PChatEnteredEventData): Promise<void> {
    if (!this.deps.isRunning()) {
      return;
    }

    const welcomeService = this.deps.getWelcomeService();
    if (!welcomeService) {
      return;
    }

    const { event } = data;
    if (!event?.user?.open_id) {
      logger.debug('P2P chat entered event missing user info');
      return;
    }

    const userId = event.user.open_id;
    logger.info({ userId }, 'P2P chat entered, sending welcome message');

    await welcomeService.handleP2PChatEntered(userId);
  }

  /**
   * Handle chat member added event.
   * Triggered when members are added to a chat.
   * Issue #463: Send welcome message when bot is added to a group.
   * Issue #676: Send help message when users join a group that already has the bot.
   */
  async handleChatMemberAdded(data: FeishuChatMemberAddedEventData): Promise<void> {
    if (!this.deps.isRunning()) {
      return;
    }

    const welcomeService = this.deps.getWelcomeService();
    if (!welcomeService) {
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

    const appId = this.deps.getAppId();

    // Check if the bot is among the added members
    // Bot's member_id_type is "app_id" and member_id is the bot's app_id
    const botMemberAdded = event.members.some(
      (member) => member.member_id_type === 'app_id' && member.member_id === appId
    );

    // Get non-bot members (users who joined)
    const userMembers = event.members.filter(
      (member) => !(member.member_id_type === 'app_id' && member.member_id === appId)
    );

    if (botMemberAdded) {
      // Bot was added to the group -> send welcome message
      logger.info({ chatId: event.chat_id }, 'Bot added to group, sending welcome message');
      await welcomeService.handleBotAddedToGroup(event.chat_id);
    } else if (userMembers.length > 0) {
      // Users joined a group that already has the bot -> send help message
      logger.info(
        { chatId: event.chat_id, userCount: userMembers.length },
        'New users joined group, sending help message'
      );
      const userIds = userMembers.map((m) => m.member_id);
      await welcomeService.handleUserJoinedGroup(event.chat_id, userIds);
    }
  }
}
