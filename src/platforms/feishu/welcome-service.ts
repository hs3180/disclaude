/**
 * Welcome Service - Handles welcome messages for new chats.
 *
 * Provides:
 * - Welcome message when bot enters a new P2P chat
 * - Welcome message when bot is added to a group
 * - Tracks first-time private chats in memory
 *
 * Issue #463: 帮助消息系统 - 入群/私聊引导 + 指令注册
 */

import { createLogger } from '../../utils/logger.js';

const logger = createLogger('WelcomeService');

/**
 * Welcome service configuration.
 */
export interface WelcomeServiceConfig {
  /** Function to generate help text */
  generateHelpText: () => string;

  /** Function to generate welcome message */
  generateWelcomeMessage: () => string;

  /** Function to send a message */
  sendMessage: (chatId: string, text: string) => Promise<void>;
}

/**
 * Welcome Service - Manages welcome messages for new chats.
 */
export class WelcomeService {
  private generateWelcomeMessage: () => string;
  private sendMessage: (chatId: string, text: string) => Promise<void>;

  /** Track first-time private chats (memory-only, resets on restart) */
  private firstTimePrivateChats = new Set<string>();

  constructor(config: WelcomeServiceConfig) {
    // generateHelpText is kept for potential future use
    void config.generateHelpText;
    this.generateWelcomeMessage = config.generateWelcomeMessage;
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
   * Handle first private chat with a user.
   * Sends welcome message with help if this is the first time.
   */
  async handleFirstPrivateChat(chatId: string): Promise<boolean> {
    if (!this.isPrivateChat(chatId)) {
      logger.debug({ chatId }, 'handleFirstPrivateChat called with non-private chat ID');
      return false;
    }

    // Check if this is the first time
    if (this.firstTimePrivateChats.has(chatId)) {
      logger.debug({ chatId }, 'Already sent welcome to this private chat');
      return false;
    }

    // Mark as sent
    this.firstTimePrivateChats.add(chatId);

    logger.info({ chatId }, 'First private chat, sending welcome message');

    try {
      await this.sendMessage(chatId, this.generateWelcomeMessage());
      logger.info({ chatId }, 'Welcome message sent to private chat');
      return true;
    } catch (error) {
      logger.error({ err: error, chatId }, 'Failed to send welcome message to private chat');
      return false;
    }
  }

  /**
   * Handle P2P chat entered event.
   * This is called when a user starts a private chat with the bot.
   */
  async handleP2PChatEntered(chatId: string): Promise<boolean> {
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
