/**
 * Trigger Mode Manager.
 *
 * Manages trigger mode state for group chats.
 * Controls how the bot responds: only when @mentioned ('mention') or to all messages ('always').
 *
 * Issue #511: Group chat trigger mode control
 * Issue #694: Extracted from feishu-channel.ts
 * Issue #2069: Declarative trigger mode via chat config files
 * Issue #2193: Renamed from PassiveModeManager, changed from boolean to enum
 *
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('TriggerMode');

/**
 * Trigger mode values.
 * - 'mention': Bot only responds when @mentioned (default for group chats)
 * - 'always': Bot responds to all messages
 */
export type TriggerMode = 'mention' | 'always';

/**
 * A record with trigger mode configuration, used for initialization.
 */
export interface TriggerModeRecord {
  /** The chat ID */
  chatId: string;
  /**
   * Trigger mode setting.
   * When 'always', bot responds to all messages.
   * When 'mention' or undefined, bot only responds to @mentions (default).
   */
  triggerMode?: TriggerMode;
}

/**
 * Trigger Mode Manager.
 *
 * Controls how the bot triggers in group chats:
 * - 'mention': Bot only responds when @mentioned (default)
 * - 'always': Bot responds to all messages
 *
 * State can be initialized declaratively from persisted records (e.g., TempChatRecord)
 * via `initFromRecords()`, ensuring trigger mode settings survive restarts.
 */
export class TriggerModeManager {
  /**
   * Trigger mode state storage.
   * Key: chatId, Value: true if trigger mode is 'always' (bot responds to all messages)
   */
  private alwaysModeChats: Set<string> = new Set();

  /**
   * Get the trigger mode for a specific chat.
   *
   * @param chatId - Chat ID to check
   * @returns The trigger mode ('always' if bot responds to all messages, 'mention' if only @mentions)
   */
  getTriggerMode(chatId: string): TriggerMode {
    return this.alwaysModeChats.has(chatId) ? 'always' : 'mention';
  }

  /**
   * Set the trigger mode for a specific chat.
   *
   * @param chatId - Chat ID to configure
   * @param mode - Trigger mode ('always' to respond to all, 'mention' for @mention only)
   */
  setTriggerMode(chatId: string, mode: TriggerMode): void {
    if (mode === 'always') {
      this.alwaysModeChats.add(chatId);
      logger.info({ chatId, mode: 'always' }, 'Trigger mode set to always for chat');
    } else {
      this.alwaysModeChats.delete(chatId);
      logger.info({ chatId, mode: 'mention' }, 'Trigger mode set to mention for chat');
    }
  }

  /**
   * Check if trigger mode is 'always' for a specific chat.
   * Backward-compatible helper: equivalent to getTriggerMode() === 'always'.
   *
   * @param chatId - Chat ID to check
   * @returns true if bot responds to all messages
   */
  isAlwaysMode(chatId: string): boolean {
    return this.alwaysModeChats.has(chatId);
  }

  /**
   * Get all chats with trigger mode set to 'always'.
   *
   * @returns Array of chat IDs with 'always' trigger mode
   */
  getAlwaysModeChats(): string[] {
    return Array.from(this.alwaysModeChats);
  }

  /**
   * Initialize trigger mode state from persisted records.
   *
   * Issue #2069/2193: Loads declarative trigger mode configuration from
   * TempChatRecord or similar sources. This ensures that trigger mode
   * settings survive restarts and are applied at startup.
   *
   * Only records with `triggerMode: 'always'` are loaded.
   * Records with `triggerMode: 'mention'` or undefined use the default behavior.
   *
   * Also handles legacy `passiveMode: boolean` records for backward compatibility:
   * - `passiveMode: false` (disabled passive) → triggerMode 'always'
   * - `passiveMode: true` or undefined → ignored (default 'mention')
   *
   * @param records - Array of records with chatId and optional triggerMode/passiveMode
   * @returns Number of chats that had trigger mode set to 'always'
   */
  initFromRecords(records: TriggerModeRecord[]): number {
    let loaded = 0;
    for (const record of records) {
      // Handle new triggerMode field
      if (record.triggerMode === 'always') {
        this.alwaysModeChats.add(record.chatId);
        loaded++;
      }
    }
    if (loaded > 0) {
      logger.info({ count: loaded }, 'Loaded trigger mode state from records');
    }
    return loaded;
  }
}
