/**
 * Trigger Mode Manager.
 *
 * Manages trigger mode state for group chats.
 * Issue #511: Group chat passive mode control
 * Issue #694: Extracted from feishu-channel.ts
 * Issue #2069: Declarative passive mode via chat config files
 * Issue #2052: Auto-disable passive mode for 2-member group chats
 * Issue #2193: Renamed from PassiveModeManager to TriggerModeManager
 *
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('TriggerMode');

/**
 * A record with trigger mode configuration, used for initialization.
 * The `passiveMode` field is retained for backward compatibility with
 * persisted data (Issue #2193).
 */
export interface TriggerModeRecord {
  /** The chat ID */
  chatId: string;
  /**
   * Trigger mode setting.
   * When `true`, trigger mode is enabled (bot responds to all messages).
   * When `false` or undefined, default behavior applies (bot only responds to @mentions).
   *
   * Retained as `passiveMode` for backward compatibility with persisted records.
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
 * State can be initialized declaratively from persisted records (e.g., TempChatRecord)
 * via `initFromRecords()`, ensuring trigger mode settings survive restarts.
 */
export class TriggerModeManager {
  /**
   * Trigger mode state storage.
   * Key: chatId, Value: true if trigger mode is enabled (bot responds to all messages)
   */
  private triggerEnabled: Map<string, boolean> = new Map();

  /**
   * Auto-detected small groups (≤2 members: bot + 1 user).
   * Once detected, trigger mode is permanently enabled for these chats,
   * even if more members join later (Issue #2052).
   */
  private smallGroups: Set<string> = new Set();

  /**
   * Check if trigger mode is enabled for a specific chat.
   * When trigger mode is enabled, the bot responds to all messages in group chats.
   *
   * Also returns true for auto-detected small groups (Issue #2052):
   * 2-member group chats (bot + 1 user) are treated as 1-on-1 conversations.
   *
   * @param chatId - Chat ID to check
   * @returns true if trigger mode is enabled (bot responds to all messages)
   */
  isTriggerEnabled(chatId: string): boolean {
    return this.triggerEnabled.get(chatId) === true || this.smallGroups.has(chatId);
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
   * Set trigger mode state for a specific chat.
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
    // Deduplicate: small groups might also be in triggerEnabled
    const all = new Set([...manual, ...auto]);
    return Array.from(all);
  }

  /**
   * Initialize trigger mode state from persisted records.
   *
   * Issue #2069: Loads declarative trigger mode configuration from
   * TempChatRecord or similar sources. This ensures that trigger mode
   * settings survive restarts and are applied at startup.
   *
   * Records with `passiveMode: false` are loaded as trigger mode enabled
   * (passive mode disabled = trigger mode enabled, Issue #2193).
   * Records with `passiveMode: true` or undefined use the default behavior
   * (trigger mode disabled), so they don't need explicit loading.
   *
   * @param records - Array of records with chatId and optional passiveMode
   * @returns Number of chats that had trigger mode enabled
   */
  initFromRecords(records: TriggerModeRecord[]): number {
    let loaded = 0;
    for (const record of records) {
      if (record.passiveMode === false) {
        this.triggerEnabled.set(record.chatId, true);
        loaded++;
      }
    }
    if (loaded > 0) {
      logger.info({ count: loaded }, 'Loaded trigger mode state from records');
    }
    return loaded;
  }
}

/**
 * @deprecated Use TriggerModeManager instead. Kept for backward compatibility during transition (Issue #2193).
 */
export const PassiveModeManager = TriggerModeManager;

/**
 * @deprecated Use TriggerModeRecord instead. Kept for backward compatibility during transition (Issue #2193).
 */
export type PassiveModeRecord = TriggerModeRecord;
