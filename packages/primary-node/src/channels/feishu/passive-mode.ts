/**
 * Passive Mode Manager.
 *
 * Manages passive mode state for group chats.
 * Issue #511: Group chat passive mode control
 * Issue #694: Extracted from feishu-channel.ts
 * Issue #2018: Support temp chat auto-disable (explicit setting detection)
 *
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('PassiveMode');

/**
 * Passive Mode Manager.
 *
 * In passive mode, the bot only responds when mentioned (@bot).
 * This can be disabled per chat to make the bot respond to all messages.
 *
 * State tracking:
 * - `true`  → passive mode explicitly DISABLED (bot responds to all)
 * - `false` → passive mode explicitly ENABLED (bot only responds to @mention)
 * - absent  → no explicit setting (caller may apply defaults, e.g. temp chats)
 */
export class PassiveModeManager {
  /**
   * Passive mode state storage.
   * Key: chatId, Value: true=disabled, false=enabled, absent=default
   */
  private passiveModeState: Map<string, boolean> = new Map();

  /**
   * Check if passive mode is disabled for a specific chat.
   * When passive mode is disabled, the bot responds to all messages in group chats.
   *
   * @param chatId - Chat ID to check
   * @returns true if passive mode is disabled (bot responds to all messages)
   */
  isPassiveModeDisabled(chatId: string): boolean {
    return this.passiveModeState.get(chatId) === true;
  }

  /**
   * Check if passive mode has been explicitly configured for a chat.
   * Used by callers to determine whether to apply default behavior (e.g. temp chat auto-disable).
   *
   * @param chatId - Chat ID to check
   * @returns true if an explicit setting exists for this chat
   */
  hasExplicitSetting(chatId: string): boolean {
    return this.passiveModeState.has(chatId);
  }

  /**
   * Set passive mode state for a specific chat.
   *
   * @param chatId - Chat ID to configure
   * @param disabled - true to disable passive mode (respond to all messages)
   */
  setPassiveModeDisabled(chatId: string, disabled: boolean): void {
    this.passiveModeState.set(chatId, disabled);
    if (disabled) {
      logger.info({ chatId }, 'Passive mode disabled for chat');
    } else {
      logger.info({ chatId }, 'Passive mode enabled for chat');
    }
  }

  /**
   * Get all chats with passive mode disabled.
   *
   * @returns Array of chat IDs with passive mode disabled
   */
  getPassiveModeDisabledChats(): string[] {
    return Array.from(this.passiveModeState.entries())
      .filter(([, v]) => v === true)
      .map(([k]) => k);
  }
}
