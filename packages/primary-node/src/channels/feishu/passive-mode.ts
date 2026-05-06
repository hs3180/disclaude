/**
 * Trigger Mode Manager.
 *
 * Manages trigger mode state for group chats.
 * Issue #511: Group chat passive mode control
 * Issue #694: Extracted from feishu-channel.ts
 * Issue #2069: Declarative passive mode via chat config files
 * Issue #2052: Auto-disable passive mode for 2-member group chats
 * Issue #2193: Renamed from PassiveModeManager to TriggerModeManager
 * Issue #3345: Added 'auto' triggerMode for intelligent group size detection
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
 * Issue #3345: `triggerMode` now supports 'auto'.
 */
export interface TriggerModeRecord {
  /** The chat ID */
  chatId: string;
  /**
   * Trigger mode enum setting (Issue #2291, #3345).
   * - `'mention'`: Bot only responds to @mentions
   * - `'always'`: Bot responds to all messages
   * - `'auto'`: Intelligent — responds to all when group has ≤2 members, mention-only otherwise
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
 * In the default state (trigger mode disabled), the bot only responds when
 * mentioned (@bot). When trigger mode is enabled, the bot responds to all messages.
 *
 * Issue #3345: Added 'auto' mode — the new default for group chats.
 * In 'auto' mode, the manager delegates trigger decisions to `shouldTriggerForAutoMode()`,
 * which checks if the group is small (≤2 members) and returns the effective behavior.
 *
 * State can be initialized declaratively from persisted records (e.g., TempChatRecord)
 * via `initFromRecords()`, ensuring trigger mode settings survive restarts.
 */
export class TriggerModeManager {
  /**
   * Per-chat trigger mode setting (enum-based).
   * Key: chatId, Value: the explicitly set trigger mode.
   * If a chatId is not in this map, it uses the default ('auto' for group chats).
   */
  private modeSettings: Map<string, TriggerMode> = new Map();

  /**
   * Trigger mode state storage (legacy boolean).
   * Key: chatId, Value: true if trigger mode is enabled (bot responds to all messages)
   * @deprecated Kept for backward compatibility with code that uses boolean API.
   */
  private triggerEnabled: Map<string, boolean> = new Map();

  /**
   * Auto-detected small groups (≤2 members: bot + 1 user).
   * Used by 'auto' mode to decide whether to respond.
   * Once detected, trigger mode is permanently enabled for these chats,
   * even if more members join later (Issue #2052).
   */
  private smallGroups: Set<string> = new Set();

  /**
   * Check if trigger mode is effectively enabled for a specific chat.
   * When trigger mode is enabled, the bot responds to all messages in group chats.
   *
   * Also returns true for auto-detected small groups (Issue #2052):
   * 2-member group chats (bot + 1 user) are treated as 1-on-1 conversations.
   *
   * For 'auto' mode, returns true only if the group is small.
   *
   * @param chatId - Chat ID to check
   * @returns true if trigger mode is enabled (bot responds to all messages)
   */
  isTriggerEnabled(chatId: string): boolean {
    const mode = this.getEffectiveMode(chatId);
    if (mode === 'always') {return true;}
    if (mode === 'auto') {return this.smallGroups.has(chatId);}
    return false; // 'mention'
  }

  /**
   * Get the effective trigger mode for a chat, resolving 'auto' to actual behavior.
   *
   * @param chatId - Chat ID to check
   * @returns The effective mode: 'mention' or 'always'
   */
  private getEffectiveMode(chatId: string): TriggerMode {
    const mode = this.modeSettings.get(chatId);
    if (mode) {return mode;}
    // Legacy boolean API: if triggerEnabled is set, map to mode
    if (this.triggerEnabled.get(chatId) === true) {return 'always';}
    // Default is 'auto' for group chats (Issue #3345)
    return 'auto';
  }

  /**
   * Get the configured trigger mode for a chat (enum-based interface).
   * Returns the explicit mode, or 'auto' as default (Issue #3345).
   *
   * @param chatId - Chat ID to check
   * @returns The configured trigger mode
   */
  getMode(chatId: string): TriggerMode {
    const mode = this.modeSettings.get(chatId);
    if (mode) {return mode;}
    // Legacy boolean API: if triggerEnabled is set, map to mode
    if (this.triggerEnabled.get(chatId) === true) {return 'always';}
    // Default is 'auto' (Issue #3345)
    return 'auto';
  }

  /**
   * Set the trigger mode for a chat (enum-based interface).
   *
   * @param chatId - Chat ID to configure
   * @param mode - The trigger mode to set
   */
  setMode(chatId: string, mode: TriggerMode): void {
    this.modeSettings.set(chatId, mode);
    // Keep legacy boolean in sync
    this.triggerEnabled.delete(chatId);
    logger.info({ chatId, mode }, 'Trigger mode set for chat');
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
   * Mark a chat as a small group, auto-enabling trigger mode.
   *
   * Once marked, trigger mode stays enabled even if members join later,
   * to avoid disruptive behavior changes (Issue #2052).
   *
   * @param chatId - Chat ID to mark
   */
  markAsSmallGroup(chatId: string): void {
    if (!this.smallGroups.has(chatId)) {
      this.smallGroups.add(chatId);
      logger.info({ chatId }, 'Auto-enabled trigger mode for small group (≤2 members)');
    }
  }

  /**
   * Set trigger mode state for a specific chat (legacy boolean API).
   *
   * @param chatId - Chat ID to configure
   * @param enabled - true to enable trigger mode (respond to all messages)
   */
  setTriggerEnabled(chatId: string, enabled: boolean): void {
    if (enabled) {
      this.triggerEnabled.set(chatId, true);
      logger.info({ chatId }, 'Trigger mode enabled for chat');
    } else {
      this.triggerEnabled.delete(chatId);
      logger.info({ chatId }, 'Trigger mode disabled for chat');
    }
  }

  /**
   * Get all chats with trigger mode enabled.
   * Includes both manually enabled and auto-detected small groups.
   *
   * @returns Array of chat IDs with trigger mode enabled
   */
  getTriggerEnabledChats(): string[] {
    const manual = Array.from(this.triggerEnabled.keys());
    const auto = Array.from(this.smallGroups.keys());
    // Also include chats with mode 'always'
    const alwaysChats = Array.from(this.modeSettings.entries())
      .filter(([, mode]) => mode === 'always')
      .map(([chatId]) => chatId);
    // Deduplicate
    const all = new Set([...manual, ...auto, ...alwaysChats]);
    return Array.from(all);
  }

  /**
   * Initialize trigger mode state from persisted records.
   *
   * Issue #2069: Loads declarative trigger mode configuration from
   * TempChatRecord or similar sources. This ensures that trigger mode
   * settings survive restarts and are applied at startup.
   *
   * Issue #2291: Now supports both `triggerMode` enum and legacy `passiveMode` boolean.
   * Issue #3345: Supports 'auto' mode — records with `triggerMode: 'auto'` use default behavior.
   *
   * Migration (Issue #3345):
   * - Old records without `triggerMode` are treated as `'auto'` (new default).
   * - Records with `triggerMode: 'auto'` are loaded but not force-enabled.
   *
   * @param records - Array of records with chatId and optional triggerMode/passiveMode
   * @returns Number of chats that had trigger mode force-enabled ('always' or legacy passiveMode:false)
   */
  initFromRecords(records: TriggerModeRecord[]): number {
    let loaded = 0;
    for (const record of records) {
      if (record.triggerMode !== undefined) {
        // Issue #3345: Store the mode setting for all enum values
        this.modeSettings.set(record.chatId, record.triggerMode);
        if (record.triggerMode === 'always') {
          this.triggerEnabled.set(record.chatId, true);
          loaded++;
        }
        // 'auto' and 'mention' don't force-enable
      } else if (record.passiveMode === false) {
        // Legacy: passiveMode:false means trigger mode enabled
        this.triggerEnabled.set(record.chatId, true);
        loaded++;
      }
      // Issue #3345: Records without triggerMode or passiveMode
      // are treated as 'auto' (default) — no forced enable.
    }
    if (loaded > 0) {
      logger.info({ count: loaded }, 'Loaded trigger mode state from records');
    }
    return loaded;
  }
}
