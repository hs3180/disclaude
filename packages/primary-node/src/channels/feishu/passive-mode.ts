/**
 * Passive Mode Manager.
 *
 * Manages passive mode state for group chats.
 * Issue #511: Group chat passive mode control
 * Issue #694: Extracted from feishu-channel.ts
 * Issue #2069: Declarative passive mode via chat config files
 *
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('PassiveMode');

/**
 * A record with passive mode configuration, used for initialization.
 */
export interface PassiveModeRecord {
  /** The chat ID */
  chatId: string;
  /**
   * Passive mode setting.
   * When `false`, passive mode is disabled (bot responds to all messages).
   * When `true` or undefined, default behavior applies (passive mode enabled).
   */
  passiveMode?: boolean;
}

/**
 * Passive Mode Manager.
 *
 * In passive mode, the bot only responds when mentioned (@bot).
 * This can be disabled per chat to make the bot respond to all messages.
 *
 * State can be initialized declaratively from persisted records (e.g., TempChatRecord)
 * via `initFromRecords()`, ensuring passive mode settings survive restarts.
 */
export class PassiveModeManager {
  /**
   * Passive mode state storage.
   * Key: chatId, Value: true if passive mode is disabled (bot responds to all messages)
   */
  private passiveModeDisabled: Map<string, boolean> = new Map();

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
   * Initialize passive mode state from persisted records.
   *
   * Issue #2069: Loads declarative passive mode configuration from
   * TempChatRecord or similar sources. This ensures that passive mode
   * settings survive restarts and are applied at startup.
   *
   * Only records with `passiveMode: false` are loaded (passive mode disabled).
   * Records with `passiveMode: true` or undefined use the default behavior
   * (passive mode enabled), so they don't need explicit loading.
   *
   * @param records - Array of records with chatId and optional passiveMode
   * @returns Number of chats that had passive mode disabled
   */
  initFromRecords(records: PassiveModeRecord[]): number {
    let loaded = 0;
    for (const record of records) {
      if (record.passiveMode === false) {
        this.passiveModeDisabled.set(record.chatId, true);
        loaded++;
      }
    }
    if (loaded > 0) {
      logger.info({ count: loaded }, 'Loaded passive mode state from records');
    }
    return loaded;
  }
}
