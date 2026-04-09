/**
 * Trigger Mode Manager.
 *
 * Manages trigger mode state for group chats.
 * Issue #511: Group chat passive mode control
 * Issue #694: Extracted from feishu-channel.ts
 * Issue #2069: Declarative passive mode via chat config files
 * Issue #2193: Renamed from PassiveModeManager to TriggerModeManager (boolean → enum)
 *
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('TriggerMode');

/**
 * Trigger mode values.
 * - 'mention': Bot only responds when @mentioned (default)
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
   */
  triggerMode?: TriggerMode;
}

/**
 * Trigger Mode Manager.
 *
 * Controls when the bot responds in group chats:
 * - 'mention' mode: Bot only responds when @mentioned (default)
 * - 'always' mode: Bot responds to all messages
 *
 * State can be initialized declaratively from persisted records (e.g., TempChatRecord)
 * via `initFromRecords()`, ensuring trigger mode settings survive restarts.
 */
export class TriggerModeManager {
  /**
   * Trigger mode state storage.
   * Key: chatId, Value: TriggerMode ('mention' | 'always')
   */
  private triggerModes: Map<string, TriggerMode> = new Map();

  /**
   * Get the trigger mode for a specific chat.
   *
   * @param chatId - Chat ID to check
   * @returns The trigger mode ('mention' or 'always'), defaults to 'mention'
   */
  getTriggerMode(chatId: string): TriggerMode {
    return this.triggerModes.get(chatId) ?? 'mention';
  }

  /**
   * Set trigger mode for a specific chat.
   *
   * @param chatId - Chat ID to configure
   * @param mode - Trigger mode ('mention' or 'always')
   */
  setTriggerMode(chatId: string, mode: TriggerMode): void {
    if (mode === 'always') {
      this.triggerModes.set(chatId, 'always');
      logger.info({ chatId }, 'Trigger mode set to always for chat');
    } else {
      this.triggerModes.delete(chatId);
      logger.info({ chatId }, 'Trigger mode set to mention (default) for chat');
    }
  }

  /**
   * Get all chats with 'always' trigger mode.
   *
   * @returns Array of chat IDs with always mode
   */
  getAlwaysModeChats(): string[] {
    return Array.from(this.triggerModes.keys());
  }

  /**
   * Initialize trigger mode state from persisted records.
   *
   * Only records with `triggerMode: 'always'` are loaded.
   * Records with `triggerMode: 'mention'` or undefined use the default behavior.
   *
   * @param records - Array of records with chatId and optional triggerMode
   * @returns Number of chats loaded with 'always' mode
   */
  initFromRecords(records: TriggerModeRecord[]): number {
    let loaded = 0;
    for (const record of records) {
      if (record.triggerMode === 'always') {
        this.triggerModes.set(record.chatId, 'always');
        loaded++;
      }
    }
    if (loaded > 0) {
      logger.info({ count: loaded }, 'Loaded trigger mode state from records');
    }
    return loaded;
  }
}
