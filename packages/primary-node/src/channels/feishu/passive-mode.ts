/**
 * Passive Mode Manager.
 *
 * Manages passive mode state for group chats.
 * Issue #511: Group chat passive mode control
 * Issue #694: Extracted from feishu-channel.ts
 * Issue #2052: Auto-disable passive mode for 2-member group chats
 *
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('PassiveMode');

/** Member count threshold for "small group" (bot + 1 user = 2 members). */
const SMALL_GROUP_MEMBER_COUNT = 2;

/**
 * Passive Mode Manager.
 *
 * In passive mode, the bot only responds when mentioned (@bot).
 * This can be disabled per chat to make the bot respond to all messages.
 *
 * Issue #2052: 2-member group chats (bot + 1 user) auto-disable passive mode,
 * since they are functionally equivalent to private conversations.
 */
export class PassiveModeManager {
  /**
   * Passive mode state storage.
   * Key: chatId, Value: true if passive mode is disabled (bot responds to all messages)
   */
  private passiveModeDisabled: Map<string, boolean> = new Map();

  /**
   * Chats that have been checked for small-group detection.
   * Once checked, the result is final — we don't re-check on member changes
   * to avoid disruptive behavior changes (Issue #2052 edge cases).
   */
  private smallGroupChecked: Set<string> = new Set();

  /**
   * Check if passive mode is disabled for a specific chat.
   * When passive mode is disabled, the bot responds to all messages in group chats.
   *
   * @param chatId - Chat ID to check
   * @returns true if passive mode is disabled (bot responds to all messages)
   */
  isPassiveModeDisabled(chatId: string): boolean {
    return this.passiveModeDisabled.get(chatId) === true;
  }

  /**
   * Set passive mode state for a specific chat.
   *
   * @param chatId - Chat ID to configure
   * @param disabled - true to disable passive mode (respond to all messages)
   */
  setPassiveModeDisabled(chatId: string, disabled: boolean): void {
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
  getPassiveModeDisabledChats(): string[] {
    return Array.from(this.passiveModeDisabled.keys());
  }

  /**
   * Check if a chat has already been evaluated for small-group detection.
   *
   * @param chatId - Chat ID to check
   * @returns true if the chat has already been checked
   */
  isSmallGroupChecked(chatId: string): boolean {
    return this.smallGroupChecked.has(chatId);
  }

  /**
   * Mark a chat as checked for small-group detection.
   * Once marked, the chat will not be re-checked (sticky decision).
   *
   * @param chatId - Chat ID to mark as checked
   */
  markSmallGroupChecked(chatId: string): void {
    this.smallGroupChecked.add(chatId);
  }

  /**
   * Handle small-group detection result.
   * If the group has exactly 2 members (bot + 1 user), auto-disable passive mode.
   *
   * @param chatId - Chat ID
   * @param memberCount - Number of members in the group
   * @returns true if passive mode was auto-disabled for this small group
   */
  handleSmallGroupDetection(chatId: string, memberCount: number): boolean {
    this.markSmallGroupChecked(chatId);

    if (memberCount <= SMALL_GROUP_MEMBER_COUNT) {
      if (!this.isPassiveModeDisabled(chatId)) {
        this.setPassiveModeDisabled(chatId, true);
        logger.info(
          { chatId, memberCount },
          'Auto-disabled passive mode for 2-member group chat (Issue #2052)',
        );
      }
      return true;
    }

    logger.debug({ chatId, memberCount }, 'Group chat has more than 2 members, keeping passive mode');
    return false;
  }
}
