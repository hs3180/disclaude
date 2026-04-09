/**
 * Trigger Mode Manager.
 *
 * Manages trigger mode state for group chats.
 * Issue #511: Group chat passive mode control
 * Issue #694: Extracted from feishu-channel.ts
 * Issue #2069: Declarative trigger mode via chat config files
 * Issue #2193: Renamed from PassiveModeManager to TriggerModeManager
 *
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('TriggerMode');

/**
 * Trigger mode values.
 * - `mention`: Bot only responds when @mentioned (default)
 * - `always`: Bot responds to all messages
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
   * When `'always'`, bot responds to all messages without requiring @mention.
   * When `'mention'` or undefined, default behavior applies (only respond to @mentions).
   */
  triggerMode?: TriggerMode;
}

/**
 * Legacy passive mode record for migration.
 * @internal Used only for migrating old `passiveMode` boolean records.
 */
export interface LegacyPassiveModeRecord {
  /** The chat ID */
  chatId: string;
  /**
   * Legacy passive mode setting.
   * - `true` or `undefined`: passive mode enabled (only respond to @mentions) → `triggerMode: 'mention'`
   * - `false`: passive mode disabled (respond to all) → `triggerMode: 'always'`
   */
  passiveMode?: boolean;
}

/**
 * Migrate a legacy passive mode boolean to a TriggerMode enum value.
 *
 * @param passiveMode - The legacy boolean value
 * @returns The corresponding TriggerMode value
 */
export function migratePassiveMode(passiveMode?: boolean): TriggerMode {
  // passiveMode: false (passive disabled = respond to all) → 'always'
  // passiveMode: true or undefined (passive enabled = only @mention) → 'mention'
  return passiveMode === false ? 'always' : 'mention';
}

/**
 * Trigger Mode Manager.
 *
 * Controls how the bot responds in group chats:
 * - `mention`: Bot only responds when @mentioned (default)
 * - `always`: Bot responds to all messages
 *
 * State can be initialized declaratively from persisted records (e.g., TempChatRecord)
 * via `initFromRecords()`, ensuring trigger mode settings survive restarts.
 */
export class TriggerModeManager {
  /**
   * Trigger mode state storage.
   * Key: chatId, Value: trigger mode ('mention' | 'always')
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
   * @param mode - The trigger mode to set
   */
  setTriggerMode(chatId: string, mode: TriggerMode): void {
    if (mode === 'mention') {
      this.triggerModes.delete(chatId);
      logger.info({ chatId, mode: 'mention' }, 'Trigger mode set to mention for chat');
    } else {
      this.triggerModes.set(chatId, mode);
      logger.info({ chatId, mode: 'always' }, 'Trigger mode set to always for chat');
    }
  }

  /**
   * Get all chats with non-default trigger mode (i.e., 'always').
   *
   * @returns Array of chat IDs with trigger mode set to 'always'
   */
  getAlwaysTriggerChats(): string[] {
    return Array.from(this.triggerModes.entries())
      .filter(([, mode]) => mode === 'always')
      .map(([chatId]) => chatId);
  }

  /**
   * Initialize trigger mode state from persisted records.
   *
   * Issue #2069: Loads declarative trigger mode configuration from
   * TempChatRecord or similar sources. This ensures that trigger mode
   * settings survive restarts and are applied at startup.
   *
   * Only records with `triggerMode: 'always'` are explicitly stored.
   * Records with `triggerMode: 'mention'` or undefined use the default behavior.
   *
   * Also handles migration from legacy `passiveMode` boolean records.
   *
   * @param records - Array of records with chatId and optional triggerMode
   * @returns Number of chats that had non-default trigger mode
   */
  initFromRecords(records: TriggerModeRecord[]): number {
    let loaded = 0;
    for (const record of records) {
      const mode = record.triggerMode;
      if (mode === 'always') {
        this.triggerModes.set(record.chatId, 'always');
        loaded++;
      }
      // 'mention' or undefined uses default, no need to store
    }
    if (loaded > 0) {
      logger.info({ count: loaded }, 'Loaded trigger mode state from records');
    }
    return loaded;
  }
}
