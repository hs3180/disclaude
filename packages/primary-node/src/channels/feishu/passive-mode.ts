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
   * If a chatId is not in this map, it uses the default ('auto').
   */
  private modeSettings: Map<string, TriggerMode> = new Map();

  /**
   * Auto-detected small groups (≤2 members: bot + 1 user).
   * Used by 'auto' mode to decide whether to respond.
   * Issue #3592: Groups are re-verified; if membership grows beyond 2,
   * the small group marking is removed.
   */
  private smallGroups: Set<string> = new Set();

  /**
   * Get the configured trigger mode for a chat.
   * Returns the explicit mode, or 'auto' as default (Issue #3345).
   *
   * @param chatId - Chat ID to check
   * @returns The configured trigger mode
   */
  getMode(chatId: string): TriggerMode {
    return this.modeSettings.get(chatId) ?? 'auto';
  }

  /**
   * Set the trigger mode for a chat.
   *
   * @param chatId - Chat ID to configure
   * @param mode - The trigger mode to set
   */
  setMode(chatId: string, mode: TriggerMode): void {
    this.modeSettings.set(chatId, mode);
    logger.info({ chatId, mode }, 'Trigger mode set for chat');
  }

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
    const mode = this.getMode(chatId);
    if (mode === 'always') {return true;}
    if (mode === 'auto') {return this.smallGroups.has(chatId);}
    return false; // 'mention'
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
   * @param chatId - Chat ID to mark
   */
  markAsSmallGroup(chatId: string): void {
    if (!this.smallGroups.has(chatId)) {
      this.smallGroups.add(chatId);
      logger.info({ chatId }, 'Auto-enabled trigger mode for small group (≤2 members)');
    }
  }

  /**
   * Remove small group marking, disabling auto trigger mode.
   * Called when a previously-small group grows beyond 2 members (Issue #3592).
   *
   * @param chatId - Chat ID to unmark
   */
  unmarkSmallGroup(chatId: string): void {
    if (this.smallGroups.has(chatId)) {
      this.smallGroups.delete(chatId);
      logger.info({ chatId }, 'Auto-disabled trigger mode: group grew beyond 2 members');
    }
  }

  /**
   * Set trigger mode state for a specific chat (legacy boolean API).
   *
   * Maps boolean to enum internally: enabled→'always', disabled→remove (revert to 'auto').
   *
   * @param chatId - Chat ID to configure
   * @param enabled - true to enable trigger mode (respond to all messages)
   *
   * @deprecated Use setMode() instead (Issue #3345).
   */
  setTriggerEnabled(chatId: string, enabled: boolean): void {
    if (enabled) {
      this.modeSettings.set(chatId, 'always');
      logger.info({ chatId }, 'Trigger mode enabled for chat');
    } else {
      this.modeSettings.delete(chatId);
      logger.info({ chatId }, 'Trigger mode disabled for chat');
    }
  }

  /**
   * Get all chats with trigger mode enabled.
   * Includes both manually enabled (mode='always') and auto-detected small groups.
   *
   * @returns Array of chat IDs with trigger mode enabled
   */
  getTriggerEnabledChats(): string[] {
    const alwaysChats = Array.from(this.modeSettings.entries())
      .filter(([, mode]) => mode === 'always')
      .map(([chatId]) => chatId);
    const auto = Array.from(this.smallGroups.keys());
    // Deduplicate
    const all = new Set([...alwaysChats, ...auto]);
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
          loaded++;
        }
        // 'auto' and 'mention' don't force-enable
      } else if (record.passiveMode === false) {
        // Legacy: passiveMode:false means trigger mode enabled
        this.modeSettings.set(record.chatId, 'always');
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
