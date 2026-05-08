/**
 * Trigger Mode Manager.
 *
 * Manages trigger mode state for group chats.
 * Issue #511: Group chat passive mode control
 * Issue #694: Extracted from feishu-channel.ts
 * Issue #2069: Declarative passive mode via chat config files
 * Issue #2052: Auto-disable passive mode for 2-member group chats
 * Issue #2193: Renamed from PassiveModeManager to TriggerModeManager
 * Issue #3345: Added 'auto' mode with intelligent group size detection
 *
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

import { createLogger, type TriggerMode } from '@disclaude/core';

const logger = createLogger('TriggerMode');

/**
 * A record with trigger mode configuration, used for initialization.
 * The `passiveMode` field is retained for backward compatibility with
 * persisted data (Issue #2193).
 * Issue #2291: Added `triggerMode` enum field.
 * Issue #3345: `triggerMode` now supports `'auto'` value.
 */
export interface TriggerModeRecord {
  /** The chat ID */
  chatId: string;
  /**
   * Trigger mode enum setting (Issue #2291, #3345).
   * - `'mention'`: Bot only responds to @mentions
   * - `'always'`: Bot responds to all messages
   * - `'auto'`: Automatically switches based on group size (default for group chats)
   *
   * When present, takes precedence over `passiveMode`.
   */
  triggerMode?: TriggerMode;
  /**
   * Trigger mode setting (legacy boolean).
   * When `true`, trigger mode is enabled (bot responds to all messages).
   * When `false` or undefined, default behavior applies (bot only responds to @mentions).
   *
   * @deprecated Use `triggerMode` instead (Issue #2291).
   * Retained for backward compatibility with persisted records.
   * The value is inverted internally: `passiveMode: false` → trigger mode enabled.
   */
  passiveMode?: boolean;
}

/**
 * Trigger Mode Manager (Issue #2193: renamed from PassiveModeManager).
 *
 * Manages per-chat trigger mode state. Supports three modes:
 * - `'auto'` (default): Automatically responds to all messages in small groups (≤2 members)
 *   and only @mentions in larger groups.
 * - `'mention'`: Bot only responds when mentioned (@bot).
 * - `'always'`: Bot responds to all messages regardless of group size.
 *
 * State can be initialized declaratively from persisted records (e.g., TempChatRecord)
 * via `initFromRecords()`, ensuring trigger mode settings survive restarts.
 */
export class TriggerModeManager {
  /**
   * Per-chat trigger mode storage.
   * Key: chatId, Value: the explicit trigger mode set for this chat.
   * Chats not in this map use the default mode ('auto').
   */
  private chatModes: Map<string, TriggerMode> = new Map();

  /**
   * Auto-detected small groups (≤2 members: bot + 1 user).
   * Used by 'auto' mode to determine effective behavior.
   * Once detected as small group, stays marked even if more members join later,
   * to avoid disruptive behavior changes (Issue #2052).
   */
  private smallGroups: Set<string> = new Set();

  /**
   * Get the configured trigger mode for a specific chat.
   * Returns the explicit mode if set, or 'auto' (the default) otherwise.
   *
   * @param chatId - Chat ID to query
   * @returns The configured TriggerMode for this chat
   */
  getMode(chatId: string): TriggerMode {
    return this.chatModes.get(chatId) ?? 'auto';
  }

  /**
   * Set the trigger mode for a specific chat.
   *
   * @param chatId - Chat ID to configure
   * @param mode - The trigger mode to set
   */
  setMode(chatId: string, mode: TriggerMode): void {
    this.chatModes.set(chatId, mode);
    logger.info({ chatId, mode }, 'Trigger mode set for chat');
  }

  /**
   * Check if trigger mode is effectively enabled for a specific chat.
   *
   * This resolves the effective behavior considering the configured mode
   * and auto-detection state:
   * - `'always'` → always enabled
   * - `'mention'` → never enabled (mention-only)
   * - `'auto'` → enabled if small group detected, disabled otherwise
   *
   * @param chatId - Chat ID to check
   * @returns true if the bot should respond to all messages (trigger enabled)
   */
  isTriggerEnabled(chatId: string): boolean {
    const mode = this.getMode(chatId);
    switch (mode) {
      case 'always':
        return true;
      case 'mention':
        return false;
      case 'auto':
        return this.smallGroups.has(chatId);
    }
  }

  /**
   * Check if a chat has been identified as a small group.
   *
   * @param chatId - Chat ID to check
   * @returns true if the chat is a small group (≤2 members)
   */
  isSmallGroup(chatId: string): boolean {
    return this.smallGroups.has(chatId);
  }

  /**
   * Mark a chat as a small group, enabling trigger mode in 'auto' mode.
   *
   * Once marked, small group status persists even if more members join later,
   * to avoid disruptive behavior changes (Issue #2052).
   *
   * @param chatId - Chat ID to mark
   */
  markAsSmallGroup(chatId: string): void {
    if (!this.smallGroups.has(chatId)) {
      this.smallGroups.add(chatId);
      logger.info({ chatId }, 'Auto-detected small group (≤2 members)');
    }
  }

  /**
   * Set trigger mode state for a specific chat (legacy boolean API).
   *
   * @param chatId - Chat ID to configure
   * @param enabled - true to enable trigger mode (respond to all messages)
   * @deprecated Use `setMode()` instead for full enum support.
   */
  setTriggerEnabled(chatId: string, enabled: boolean): void {
    this.setMode(chatId, enabled ? 'always' : 'mention');
  }

  /**
   * Get all chats with trigger mode effectively enabled.
   * Includes chats in 'always' mode and 'auto' mode chats that are small groups.
   *
   * @returns Array of chat IDs with trigger mode enabled
   */
  getTriggerEnabledChats(): string[] {
    const enabled: string[] = [];
    // Collect chats from chatModes that are effectively enabled
    for (const [chatId] of this.chatModes) {
      if (this.isTriggerEnabled(chatId)) {
        enabled.push(chatId);
      }
    }
    // Also collect small groups that might not be in chatModes yet
    // (they were auto-detected but haven't had an explicit mode set)
    for (const chatId of this.smallGroups) {
      if (!enabled.includes(chatId) && this.isTriggerEnabled(chatId)) {
        enabled.push(chatId);
      }
    }
    return enabled;
  }

  /**
   * Initialize trigger mode state from persisted records.
   *
   * Issue #2069: Loads declarative trigger mode configuration from
   * TempChatRecord or similar sources. This ensures that trigger mode
   * settings survive restarts and are applied at startup.
   *
   * Issue #2291: Now supports both `triggerMode` enum and legacy `passiveMode` boolean.
   * Issue #3345: `triggerMode` now supports `'auto'` value.
   * - Records with `triggerMode` set are loaded directly.
   * - Legacy records with `passiveMode: false` are treated as `'always'`.
   * - Legacy records with `passiveMode: true` or undefined are treated as `'mention'`.
   * - Records with no explicit mode get `'auto'` (the new default).
   * - `triggerMode` takes precedence over `passiveMode` when both are present.
   *
   * @param records - Array of records with chatId and optional triggerMode/passiveMode
   * @returns Number of chats that had a non-default mode loaded
   */
  initFromRecords(records: TriggerModeRecord[]): number {
    let loaded = 0;
    for (const record of records) {
      let mode: TriggerMode | undefined;

      if (record.triggerMode !== undefined) {
        // Issue #2291: Use triggerMode enum
        mode = record.triggerMode;
      } else if (record.passiveMode === false) {
        // Legacy: passiveMode: false means trigger mode was enabled → 'always'
        mode = 'always';
      } else if (record.passiveMode === true) {
        // Legacy: passiveMode: true means trigger mode was disabled → 'mention'
        mode = 'mention';
      }
      // If neither triggerMode nor passiveMode is set, leave as default ('auto')

      if (mode !== undefined) {
        this.chatModes.set(record.chatId, mode);
        loaded++;
      }
    }
    if (loaded > 0) {
      logger.info({ count: loaded }, 'Loaded trigger mode state from records');
    }
    return loaded;
  }
}
