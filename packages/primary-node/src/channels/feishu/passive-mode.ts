/**
 * Passive Mode Manager.
 *
 * Manages passive mode state for group chats.
 * Issue #511: Group chat passive mode control
 * Issue #694: Extracted from feishu-channel.ts
 * Issue #2052: File-based persistence + small group auto-detection
 *
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '@disclaude/core';

const logger = createLogger('PassiveMode');

/**
 * Persistent state file format.
 */
interface PassiveModeState {
  /** Map of chatId → true (passive mode disabled) */
  disabledChats: Record<string, boolean>;
  /** Set of chatIds that have been checked for small group detection */
  smallGroupChecked: string[];
}

/**
 * Options for PassiveModeManager.
 */
export interface PassiveModeManagerOptions {
  /**
   * Path to the persistent state file.
   * If provided, state is loaded on init() and saved on every change.
   * If omitted, state is in-memory only (backward compatible).
   */
  configPath?: string;
}

/**
 * Passive Mode Manager.
 *
 * In passive mode, the bot only responds when mentioned (@bot).
 * This can be disabled per chat to make the bot respond to all messages.
 *
 * Supports optional file-based persistence so state survives restarts.
 */
export class PassiveModeManager {
  /**
   * Passive mode state storage.
   * Key: chatId, Value: true if passive mode is disabled (bot responds to all messages)
   */
  private passiveModeDisabled: Map<string, boolean> = new Map();

  /**
   * Track which chats have been checked for small group detection.
   * Prevents redundant API calls on repeated bot.added events.
   */
  private smallGroupChecked: Set<string> = new Set();

  /**
   * Path to the persistent state file (optional).
   */
  private configPath?: string;

  /**
   * Whether the manager has been initialized.
   */
  private initialized = false;

  constructor(options: PassiveModeManagerOptions = {}) {
    this.configPath = options.configPath;
  }

  /**
   * Initialize the manager by loading state from the persistent file.
   * Must be called before use if configPath was provided.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    if (!this.configPath) {
      return;
    }

    try {
      await fsPromises.mkdir(path.dirname(this.configPath), { recursive: true });
      const content = await fsPromises.readFile(this.configPath, 'utf-8');
      const state: PassiveModeState = JSON.parse(content);

      if (state.disabledChats) {
        for (const [chatId, disabled] of Object.entries(state.disabledChats)) {
          if (disabled) {
            this.passiveModeDisabled.set(chatId, true);
          }
        }
      }

      if (state.smallGroupChecked) {
        for (const chatId of state.smallGroupChecked) {
          this.smallGroupChecked.add(chatId);
        }
      }

      logger.info(
        { chatCount: this.passiveModeDisabled.size, checkedCount: this.smallGroupChecked.size },
        'Passive mode state loaded from file',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug('No existing passive mode state file, starting fresh');
      } else {
        logger.error({ err: error }, 'Failed to load passive mode state');
      }
    }
  }

  /**
   * Persist current state to the config file.
   * Only writes if configPath was provided.
   */
  private async persist(): Promise<void> {
    if (!this.configPath) {
      return;
    }

    try {
      const state: PassiveModeState = {
        disabledChats: Object.fromEntries(this.passiveModeDisabled),
        smallGroupChecked: Array.from(this.smallGroupChecked),
      };
      await fsPromises.writeFile(this.configPath, JSON.stringify(state, null, 2), 'utf-8');
    } catch (error) {
      logger.error({ err: error }, 'Failed to persist passive mode state');
    }
  }

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
   * If configPath is set, the change is persisted to disk (fire-and-forget).
   *
   * Kept synchronous for backward compatibility with existing callers
   * (FeishuChannel wrapper and wired-descriptors adapter).
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
    // Fire-and-forget persistence (best-effort)
    this.persist().catch(() => { /* handled inside persist() */ });
  }

  /**
   * Get all chats with passive mode disabled.
   *
   * @returns Array of chat IDs with passive mode disabled
   */
  getPassiveModeDisabledChats(): string[] {
    return Array.from(this.passiveModeDisabled.keys());
  }

  // =========================================================================
  // Small Group Detection (Issue #2052)
  // =========================================================================

  /**
   * Check if a chat has already been checked for small group detection.
   *
   * @param chatId - Chat ID to check
   * @returns true if the chat has already been checked
   */
  isSmallGroupChecked(chatId: string): boolean {
    return this.smallGroupChecked.has(chatId);
  }

  /**
   * Mark a chat as checked for small group detection.
   * Persists the state if configPath is set (fire-and-forget).
   *
   * @param chatId - Chat ID to mark as checked
   */
  markSmallGroupChecked(chatId: string): void {
    this.smallGroupChecked.add(chatId);
    // Fire-and-forget persistence (best-effort)
    this.persist().catch(() => { /* handled inside persist() */ });
  }
}
