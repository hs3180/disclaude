/**
 * Welcome Service - Handles welcome messages for new chats.
 *
 * Provides:
 * - Welcome message when bot enters a new P2P chat
 * - Welcome message when bot is added to a group
 * - Help message when users join a group that already has the bot
 * - Tracks first-time private chats in memory
 *
 * Issue #463: 帮助消息系统 - 入群/私聊引导 + 指令注册
 * Issue #676: 新用户加入群聊时发送 /help 信息
 *
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('WelcomeService');

/**
 * Welcome service configuration.
 */
export interface WelcomeServiceConfig {
  /** Function to generate welcome message */
  generateWelcomeMessage: () => string;

  /** Function to generate help message for new users joining group */
  generateHelpMessage?: () => string;

  /** Function to send a message */
  sendMessage: (chatId: string, text: string) => Promise<void>;
}

/**
 * Welcome Service - Manages welcome messages for new chats.
 */
export class WelcomeService {
  private generateWelcomeMessage: () => string;
  private generateHelpMessage?: () => string;
  private sendMessage: (chatId: string, text: string) => Promise<void>;

  /** Track first-time private chats (memory-only, resets on restart) */
  private firstTimePrivateChats = new Set<string>();

  constructor(config: WelcomeServiceConfig) {
    this.generateWelcomeMessage = config.generateWelcomeMessage;
    this.generateHelpMessage = config.generateHelpMessage;
    this.sendMessage = config.sendMessage;
  }

  /**
   * Check if a chat ID is a private chat.
   * In Feishu, private chat IDs start with 'ou_' (user open_id).
   */
  isPrivateChat(chatId: string): boolean {
    return chatId.startsWith('ou_');
  }

  /**
   * Check if a chat ID is a group chat.
   * In Feishu, group chat IDs start with 'oc_'.
   */
  isGroupChat(chatId: string): boolean {
    return chatId.startsWith('oc_');
  }

  /**
   * Handle bot being added to a group chat.
   * Sends welcome message with help.
   */
  async handleBotAddedToGroup(chatId: string): Promise<void> {
    if (!this.isGroupChat(chatId)) {
      logger.warn({ chatId }, 'handleBotAddedToGroup called with non-group chat ID');
      return;
    }

    logger.info({ chatId }, 'Bot added to group, sending welcome message');

    try {
      await this.sendMessage(chatId, this.generateWelcomeMessage());
      logger.info({ chatId }, 'Welcome message sent to group');
    } catch (error) {
      logger.error({ err: error, chatId }, 'Failed to send welcome message to group');
    }
  }

  /**
   * Handle users joining a group chat that already has the bot.
   * Sends help message to introduce bot capabilities to new users.
   *
   * Issue #676: 新用户加入群聊时发送 /help 信息
   *
   * @param chatId - The group chat ID
   * @param userIds - Array of user open_ids who joined (optional, for future use)
   */
  async handleUserJoinedGroup(chatId: string, userIds?: string[]): Promise<void> {
    if (!this.isGroupChat(chatId)) {
      logger.warn({ chatId }, 'handleUserJoinedGroup called with non-group chat ID');
      return;
    }

    // Use help message if available, otherwise use welcome message
    const message = this.generateHelpMessage
      ? this.generateHelpMessage()
      : this.generateWelcomeMessage();

    logger.info({ chatId, userCount: userIds?.length }, 'Users joined group, sending help message');

    try {
      await this.sendMessage(chatId, message);
      logger.info({ chatId }, 'Help message sent to group for new users');
    } catch (error) {
      logger.error({ err: error, chatId }, 'Failed to send help message to group');
    }
  }

  /**
   * Handle first private chat with a user.
   * Sends welcome message with help if this is the first time.
   *
   * @returns 'sent' if welcome was just sent, 'already_sent' if already sent before,
   *          'failed' if an error occurred, 'skipped' if not a private chat.
   */
  async handleFirstPrivateChat(chatId: string): Promise<'sent' | 'already_sent' | 'failed' | 'skipped'> {
    if (!this.isPrivateChat(chatId)) {
      logger.debug({ chatId }, 'handleFirstPrivateChat called with non-private chat ID');
      return 'skipped';
    }

    // Check if this is the first time
    if (this.firstTimePrivateChats.has(chatId)) {
      logger.debug({ chatId }, 'Already sent welcome to this private chat');
      return 'already_sent';
    }

    // Mark as sent
    this.firstTimePrivateChats.add(chatId);

    logger.info({ chatId }, 'First private chat, sending welcome message');

    try {
      await this.sendMessage(chatId, this.generateWelcomeMessage());
      logger.info({ chatId }, 'Welcome message sent to private chat');
      return 'sent';
    } catch (error) {
      logger.error({ err: error, chatId }, 'Failed to send welcome message to private chat');
      // Issue #1357: Remove from tracked set so it can be retried on next interaction
      this.firstTimePrivateChats.delete(chatId);
      return 'failed';
    }
  }

  /**
   * Handle P2P chat entered event.
   * This is called when a user starts a private chat with the bot.
   */
  handleP2PChatEntered(chatId: string): Promise<'sent' | 'already_sent' | 'failed' | 'skipped'> {
    return this.handleFirstPrivateChat(chatId);
  }

  /**
   * Get the count of first-time private chats tracked.
   */
  getFirstTimeChatCount(): number {
    return this.firstTimePrivateChats.size;
  }

  /**
   * Clear all tracked first-time chats (for testing).
   */
  clearFirstTimeChats(): void {
    this.firstTimePrivateChats.clear();
  }
}

// Singleton instance
let globalWelcomeService: WelcomeService | undefined;

/**
 * Initialize the global welcome service.
 */
export function initWelcomeService(config: WelcomeServiceConfig): WelcomeService {
  globalWelcomeService = new WelcomeService(config);
  return globalWelcomeService;
}

/**
 * Get the global welcome service.
 */
export function getWelcomeService(): WelcomeService | undefined {
  return globalWelcomeService;
}

/**
 * Reset the global welcome service (for testing).
 */
export function resetWelcomeService(): void {
  globalWelcomeService = undefined;
}
