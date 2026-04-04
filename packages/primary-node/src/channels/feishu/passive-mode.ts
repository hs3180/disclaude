/**
 * Passive Mode Manager.
 *
 * Manages passive mode state for group chats.
 * Issue #511: Group chat passive mode control
 * Issue #694: Extracted from feishu-channel.ts
 * Issue #2018: File-based persistence + temp chat passive mode defaults
 *
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '@disclaude/core';

const logger = createLogger('PassiveMode');

/**
 * Options for PassiveModeManager.
 */
export interface PassiveModeManagerOptions {
  /**
   * Path to the passive mode state file for persistence.
   * When provided, state is loaded from file on init and saved on changes.
   * Format: JSON object mapping chatId → true (passive mode disabled).
   *
   * Issue #2018: Enables cross-process communication between Node.js
   * (PassiveModeManager) and bash scripts (chats-activation.sh).
   */
  configPath?: string;
}

/**
 * Passive Mode Manager.
 *
 * In passive mode, the bot only responds when mentioned (@bot).
 * This can be disabled per chat to make the bot respond to all messages.
 *
 * When a `configPath` is provided, state is persisted to a JSON file,
 * enabling:
 * - State survival across process restarts
 * - Cross-process communication (bash scripts can write passive mode state)
 * - Issue #2018: Temp chats default to passive mode disabled
 */
export class PassiveModeManager {
  /**
   * Passive mode state storage.
   * Key: chatId, Value: true if passive mode is disabled (bot responds to all messages)
   */
  private passiveModeDisabled: Map<string, boolean> = new Map();

  /**
   * Path to the persistence file (optional).
   */
  private configPath?: string;

  /**
   * Whether the manager has been initialized (loaded from file).
   */
  private initialized = false;

  constructor(options: PassiveModeManagerOptions = {}) {
    this.configPath = options.configPath;
  }

  /**
   * Initialize the manager by loading state from the persistence file.
   *
   * Called during channel startup (doStart) to ensure state is available
   * before messages are processed. Safe to call multiple times (idempotent).
   *
   * @returns Promise that resolves when initialization is complete
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
      const content = fs.readFileSync(this.configPath, 'utf-8');
      const data = JSON.parse(content) as Record<string, boolean>;

      for (const [chatId, disabled] of Object.entries(data)) {
        if (typeof chatId === 'string' && disabled === true) {
          this.passiveModeDisabled.set(chatId, true);
        }
      }

      logger.info(
        { chatCount: this.passiveModeDisabled.size, configPath: this.configPath },
        'Loaded passive mode state from file',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug({ configPath: this.configPath }, 'No passive mode state file found, starting fresh');
      } else {
        logger.error({ err: error, configPath: this.configPath }, 'Failed to load passive mode state file');
      }
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
   *
   * When persistence is enabled, changes are saved to the config file
   * so they survive restarts and are visible to other processes.
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

    // Persist to file if configured
    this.saveToFile();
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
   * Save current passive mode state to the persistence file.
   *
   * Writes atomically via tmpfile + rename to prevent corruption.
   * Errors are logged but do not throw (graceful degradation).
   */
  private saveToFile(): void {
    if (!this.configPath) {
      return;
    }

    try {
      const data: Record<string, boolean> = {};
      for (const chatId of this.passiveModeDisabled.keys()) {
        data[chatId] = true;
      }

      // Ensure directory exists
      const dir = path.dirname(this.configPath);
      fs.mkdirSync(dir, { recursive: true });

      // Atomic write via tmpfile + rename
      const tmpfile = this.configPath + '.tmp';
      fs.writeFileSync(tmpfile, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpfile, this.configPath);

      logger.debug(
        { chatCount: data.length, configPath: this.configPath },
        'Saved passive mode state to file',
      );
    } catch (error) {
      logger.error({ err: error, configPath: this.configPath }, 'Failed to save passive mode state');
    }
  }
}
