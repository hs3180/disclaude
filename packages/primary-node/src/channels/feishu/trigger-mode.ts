/**
 * Trigger Mode Manager.
 *
 * Manages trigger mode state for group chats.
 * Issue #2193: Renamed from passiveMode to triggerMode with enum semantics.
 * Issue #511: Original group chat passive mode control
 * Issue #694: Extracted from feishu-channel.ts
 * Issue #2069: Declarative trigger mode via chat config files
 *
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('TriggerMode');

/**
 * Trigger mode for bot responses in group chats.
 *
 * - `'mention'`: Bot only responds when @mentioned (default).
 *   Previously known as "passive mode enabled".
 * - `'always'`: Bot responds to all messages.
 *   Previously known as "passive mode disabled".
 *
 * Future extensions may add modes like `'regex'`, `'schedule'`, etc.
 */
export type TriggerMode = 'mention' | 'always';

/** Default trigger mode for all chats. */
export const DEFAULT_TRIGGER_MODE: TriggerMode = 'mention';

/**
 * A record with trigger mode configuration, used for initialization.
 * Supports backward compatibility with legacy `passiveMode` boolean field.
 */
export interface TriggerModeRecord {
  /** The chat ID */
  chatId: string;
  /**
   * Trigger mode setting.
   * - `'always'`: Bot responds to all messages.
   * - `'mention'` or undefined: Bot only responds when @mentioned (default).
   */
  triggerMode?: TriggerMode;
  /**
   * @deprecated Use `triggerMode` instead. Kept for backward compatibility.
   * When `false`, equivalent to `triggerMode: 'always'`.
   * When `true` or undefined, uses default trigger mode.
   */
  passiveMode?: boolean;
}

/**
 * Trigger Mode Manager.
 *
 * Manages per-chat trigger mode overrides. By default, all chats use
 * `'mention'` mode (bot only responds when @mentioned). Individual chats
 * can be configured to use `'always'` mode (respond to all messages).
 *
 * State can be initialized declaratively from persisted records (e.g., TempChatRecord)
 * via `initFromRecords()`, ensuring trigger mode settings survive restarts.
 */
export class TriggerModeManager {
  /**
   * Trigger mode overrides storage.
   * Key: chatId, Value: trigger mode (only stores non-default modes).
   */
  private triggerModeOverrides: Map<string, TriggerMode> = new Map();

  /**
   * Get the trigger mode for a specific chat.
   *
   * @param chatId - Chat ID to check
   * @returns The trigger mode ('mention' or 'always')
   */
  getTriggerMode(chatId: string): TriggerMode {
    return this.triggerModeOverrides.get(chatId) ?? DEFAULT_TRIGGER_MODE;
  }

  /**
   * Check if the trigger mode is 'always' for a specific chat.
   * Convenience method equivalent to `getTriggerMode(chatId) === 'always'`.
   *
   * @param chatId - Chat ID to check
   * @returns true if trigger mode is 'always' (bot responds to all messages)
   */
  isAlwaysMode(chatId: string): boolean {
    return this.getTriggerMode(chatId) === 'always';
  }

  /**
   * Set trigger mode for a specific chat.
   *
   * @param chatId - Chat ID to configure
   * @param mode - The trigger mode to set
   */
  setTriggerMode(chatId: string, mode: TriggerMode): void {
    if (mode === DEFAULT_TRIGGER_MODE) {
      // Remove override for default mode
      this.triggerModeOverrides.delete(chatId);
      logger.info({ chatId, mode }, 'Trigger mode reset to default');
    } else {
      this.triggerModeOverrides.set(chatId, mode);
      logger.info({ chatId, mode }, 'Trigger mode set');
    }
  }

  /**
   * Get all chats with non-default trigger mode.
   *
   * @returns Array of chat IDs with non-default trigger modes
   */
  getTriggerModeOverrideChats(): string[] {
    return Array.from(this.triggerModeOverrides.keys());
  }

  /**
   * Initialize trigger mode state from persisted records.
   *
   * Loads declarative trigger mode configuration from TempChatRecord
   * or similar sources. Ensures trigger mode settings survive restarts.
   *
   * Only records with non-default trigger mode are loaded into overrides.
   * Supports backward compatibility with legacy `passiveMode` boolean field.
   *
   * @param records - Array of records with chatId and optional triggerMode/passiveMode
   * @returns Number of chats that had trigger mode overrides loaded
   */
  initFromRecords(records: TriggerModeRecord[]): number {
    let loaded = 0;
    for (const record of records) {
      let mode: TriggerMode | undefined;

      // New field takes precedence
      if (record.triggerMode) {
        mode = record.triggerMode;
      } else if (record.passiveMode === false) {
        // Backward compat: passiveMode: false → triggerMode: 'always'
        mode = 'always';
      }

      if (mode && mode !== DEFAULT_TRIGGER_MODE) {
        this.triggerModeOverrides.set(record.chatId, mode);
        loaded++;
      }
    }
    if (loaded > 0) {
      logger.info({ count: loaded }, 'Loaded trigger mode state from records');
    }
    return loaded;
  }
}
