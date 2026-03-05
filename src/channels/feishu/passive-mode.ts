/**
 * Passive Mode Manager for Feishu Channel.
 *
 * Manages passive mode state per chat for group chat message filtering.
 * When passive mode is disabled for a chat, the bot responds to all messages.
 * When passive mode is enabled (default), the bot only responds when mentioned.
 *
 * Issue #511: Group chat passive mode control
 */

import { createLogger } from '../../utils/logger.js';

const logger = createLogger('PassiveModeManager');

/**
 * Manages passive mode state for Feishu group chats.
 *
 * In passive mode (default), the bot only responds when:
 * - The bot is @mentioned
 * - A direct command is sent (/passive, etc.)
 *
 * When passive mode is disabled, the bot responds to all messages.
 */
export class PassiveModeManager {
  /**
   * Passive mode state storage.
   * Key: chatId, Value: true if passive mode is disabled (bot responds to all messages)
   */
  private readonly passiveModeDisabled: Map<string, boolean> = new Map();

  /**
   * Check if passive mode is disabled for a specific chat.
   * When passive mode is disabled, the bot responds to all messages in group chats.
   *
   * @param chatId - Chat ID to check
   * @returns true if passive mode is disabled (bot responds to all messages)
   */
  isDisabled(chatId: string): boolean {
    return this.passiveModeDisabled.get(chatId) === true;
  }

  /**
   * Set passive mode state for a specific chat.
   *
   * @param chatId - Chat ID to configure
   * @param disabled - true to disable passive mode (respond to all messages)
   */
  setDisabled(chatId: string, disabled: boolean): void {
    if (disabled) {
      this.passiveModeDisabled.set(chatId, true);
      logger.info({ chatId }, 'Passive mode disabled for chat');
    } else {
      this.passiveModeDisabled.delete(chatId);
      logger.info({ chatId }, 'Passive mode enabled for chat');
    }
  }

  /**
   * Get all chats with passive mode disabled.
   *
   * @returns Array of chat IDs with passive mode disabled
   */
  getDisabledChats(): string[] {
    return Array.from(this.passiveModeDisabled.keys());
  }
}
