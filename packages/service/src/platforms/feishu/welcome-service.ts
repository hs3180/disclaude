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
 * Migrated to @disclaude/service (Issue #1040)
 */

import { createLogger, isGroupChat, isPrivateChat, type ChatType } from '@disclaude/core';

const logger = createLogger('WelcomeService');

/**
 * Welcome service configuration.
 */
export interface WelcomeServiceConfig {
  /** Function to generate welcome message */
  generateWelcomeMessage: (chatId: string, chatType: ChatType) => string | undefined;

  /** Function to generate help message for new users joining group */
  generateHelpMessage?: (chatId: string, chatType: ChatType) => string | undefined;

  /** Function to send a message */
  sendMessage: (chatId: string, text: string) => Promise<void>;
  /** Native event delivery can address a P2P user before a chat ID is known. */
  sendWelcomeMessage?: (chatId: string, text: string, chatType: ChatType) => Promise<void>;
}

/**
 * Welcome Service - Manages welcome messages for new chats.
 */
export class WelcomeService {
  private generateWelcomeMessage: WelcomeServiceConfig['generateWelcomeMessage'];
  private generateHelpMessage?: WelcomeServiceConfig['generateHelpMessage'];
  private sendMessage: (chatId: string, text: string) => Promise<void>;
  private sendWelcomeMessage?: WelcomeServiceConfig['sendWelcomeMessage'];
  private readonly automaticPrompts = new Map<string, number>();
  private readonly disabledChats = new Set<string>();
  private readonly privateChatIds = new Map<string, string>();
  private readonly maxChats = 1000;

  /** Track first-time private chats (memory-only, resets on restart) */
  private firstTimePrivateChats = new Set<string>();

  constructor(config: WelcomeServiceConfig) {
    this.generateWelcomeMessage = config.generateWelcomeMessage;
    this.generateHelpMessage = config.generateHelpMessage;
    this.sendMessage = config.sendMessage;
    this.sendWelcomeMessage = config.sendWelcomeMessage;
  }

  isEnabled(chatId: string): boolean {
    return !this.disabledChats.has(this.privateChatIds.get(chatId) ?? chatId);
  }

  setEnabled(chatId: string, enabled: boolean): void {
    const key = this.privateChatIds.get(chatId) ?? chatId;
    if (enabled) { this.disabledChats.delete(key); }
    else {
      if (!this.disabledChats.has(key) && this.disabledChats.size >= this.maxChats) { throw new Error('Guidance preference capacity reached'); }
      this.disabledChats.add(key);
    }
  }

  /** Join the P2P entered-event address to the actual inbound chat's preference/rate state. */
  registerPrivateChat(userId: string, chatId: string): void {
    if (!this.privateChatIds.has(userId) && this.privateChatIds.size >= this.maxChats) { return; }
    this.privateChatIds.set(userId, chatId);
    const previous = this.automaticPrompts.get(userId);
    if (previous !== undefined) { this.automaticPrompts.set(chatId, Math.max(previous, this.automaticPrompts.get(chatId) ?? 0)); this.automaticPrompts.delete(userId); }
    if (this.disabledChats.delete(userId)) { this.disabledChats.add(chatId); }
    if (this.firstTimePrivateChats.delete(userId)) { this.firstTimePrivateChats.add(chatId); }
  }

  /** Reserve before any await, including failed/uncertain delivery; explicit /help bypasses this gate. */
  claimPrompt(chatId: string, cooldownMs = 5 * 60 * 1000): boolean {
    const key = this.privateChatIds.get(chatId) ?? chatId;
    if (!this.isEnabled(key)) { return false; }
    const now = Date.now();
    for (const [id, time] of this.automaticPrompts) {
      if (now - time >= 24 * 60 * 60 * 1000) { this.automaticPrompts.delete(id); }
    }
    const previous = this.automaticPrompts.get(key);
    if (previous !== undefined && now - previous < cooldownMs) { return false; }
    if (previous === undefined && this.automaticPrompts.size >= this.maxChats) { return false; }
    this.automaticPrompts.set(key, now);
    return true;
  }

  private deliver(chatId: string, text: string, chatType: ChatType): Promise<void> {
    return this.sendWelcomeMessage ? this.sendWelcomeMessage(chatId, text, chatType) : this.sendMessage(chatId, text);
  }

  /**
   * Handle bot being added to a group chat.
   * Sends welcome message with help.
   *
   * @param chatId - The group chat ID (address only; classification is by chatType)
   * @param chatType - The chat type from the triggering event
   */
  async handleBotAddedToGroup(chatId: string, chatType: ChatType): Promise<void> {
    if (!isGroupChat(chatType)) {
      logger.warn({ chatId, chatType }, 'handleBotAddedToGroup called with non-group chat type');
      return;
    }
    if (!this.claimPrompt(chatId, 24 * 60 * 60 * 1000)) { return; }

    logger.info({ chatId }, 'Bot added to group, sending welcome message');

    try {
      const text = this.generateWelcomeMessage(chatId, chatType);
      if (!text) { return; }
      await this.deliver(chatId, text, chatType);
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
   * @param chatId - The group chat ID (address only; classification is by chatType)
   * @param chatType - The chat type from the triggering event
   * @param userIds - Array of user open_ids who joined (optional, for future use)
   */
  async handleUserJoinedGroup(chatId: string, chatType: ChatType, userIds?: string[]): Promise<void> {
    if (!isGroupChat(chatType)) {
      logger.warn({ chatId, chatType }, 'handleUserJoinedGroup called with non-group chat type');
      return;
    }
    if (!this.claimPrompt(chatId, 24 * 60 * 60 * 1000)) { return; }

    logger.info({ chatId, userCount: userIds?.length }, 'Users joined group, sending help message');

    try {
      const message = this.generateHelpMessage
        ? this.generateHelpMessage(chatId, chatType)
        : this.generateWelcomeMessage(chatId, chatType);
      if (!message) { return; }
      await this.deliver(chatId, message, chatType);
      logger.info({ chatId }, 'Help message sent to group for new users');
    } catch (error) {
      logger.error({ err: error, chatId }, 'Failed to send help message to group');
    }
  }

  /**
   * Handle first private chat with a user.
   * Sends welcome message with help if this is the first time.
   *
   * @param chatId - The private chat ID / user open_id (address only; classification is by chatType)
   * @param chatType - The chat type from the triggering event
   * @returns 'sent' if welcome was just sent, 'already_sent' if already sent before,
   *          'failed' if an error occurred, 'skipped' if not a private chat.
   */
  async handleFirstPrivateChat(
    chatId: string,
    chatType: ChatType
  ): Promise<'sent' | 'already_sent' | 'failed' | 'skipped'> {
    if (!isPrivateChat(chatType)) {
      logger.debug({ chatId, chatType }, 'handleFirstPrivateChat called with non-private chat type');
      return 'skipped';
    }
    chatId = this.privateChatIds.get(chatId) ?? chatId;

    // Check if this is the first time
    if (this.firstTimePrivateChats.has(chatId)) {
      logger.debug({ chatId }, 'Already sent welcome to this private chat');
      return 'already_sent';
    }
    if (this.firstTimePrivateChats.size >= this.maxChats || !this.claimPrompt(chatId)) { return 'skipped'; }

    // Mark as sent
    this.firstTimePrivateChats.add(chatId);

    logger.info({ chatId }, 'First private chat, sending welcome message');

    try {
      const text = this.generateWelcomeMessage(chatId, chatType);
      if (!text) { this.firstTimePrivateChats.delete(chatId); return 'skipped'; }
      await this.deliver(chatId, text, chatType);
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
  handleP2PChatEntered(
    chatId: string,
    chatType: ChatType
  ): Promise<'sent' | 'already_sent' | 'failed' | 'skipped'> {
    return this.handleFirstPrivateChat(chatId, chatType);
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
