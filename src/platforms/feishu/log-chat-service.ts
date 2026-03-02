/**
 * LogChatService - Manages the unified log chat for monitoring all bot messages.
 *
 * This service stores the log chat ID in the workspace directory (not in config file)
 * following the "minimum configuration" principle.
 *
 * Features:
 * - Stores log chat ID in workspace/log-chat.json
 * - Provides methods to get/set log chat ID
 * - Optional auto-creation of log chat via ChatOps
 *
 * @see Issue #347 - Dynamic admin mode setup and auto-create log chat
 */

import fs from 'fs';
import path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';
import { Config } from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';
import { createDiscussionChat } from './chat-ops.js';

const logger = createLogger('LogChatService');

/**
 * Log chat state stored in workspace.
 */
interface LogChatState {
  /** Log chat ID */
  chatId: string;
  /** When the log chat was created/set */
  createdAt: string;
  /** Topic/name of the log chat */
  topic?: string;
}

/**
 * Configuration for LogChatService.
 */
export interface LogChatServiceConfig {
  /** Feishu API client (required for auto-create) */
  client?: lark.Client;
  /** Custom workspace directory (defaults to Config.getWorkspaceDir()) */
  workspaceDir?: string;
}

/**
 * LogChatService - Manages the unified log chat for message monitoring.
 *
 * Usage:
 * ```typescript
 * const logChatService = new LogChatService({ client });
 *
 * // Get existing log chat ID
 * const chatId = await logChatService.getLogChatId();
 *
 * // Set log chat ID (when user configures it)
 * await logChatService.setLogChatId('oc_xxxx');
 *
 * // Or create a new log chat
 * const newChatId = await logChatService.createLogChat(['ou_user1']);
 * ```
 */
export class LogChatService {
  private readonly client?: lark.Client;
  private readonly workspaceDir: string;
  private readonly stateFilePath: string;
  private cachedState?: LogChatState;

  constructor(config: LogChatServiceConfig = {}) {
    this.client = config.client;
    this.workspaceDir = config.workspaceDir || Config.getWorkspaceDir();
    this.stateFilePath = path.join(this.workspaceDir, 'log-chat.json');
  }

  /**
   * Get the log chat ID.
   *
   * @returns The log chat ID, or undefined if not set
   */
  async getLogChatId(): Promise<string | undefined> {
    const state = await this.loadState();
    return state?.chatId;
  }

  /**
   * Set the log chat ID.
   *
   * This is used when the user manually configures an existing chat as log chat.
   *
   * @param chatId - The chat ID to use as log chat
   * @param topic - Optional topic/name for the log chat
   */
  async setLogChatId(chatId: string, topic?: string): Promise<void> {
    const state: LogChatState = {
      chatId,
      createdAt: new Date().toISOString(),
      topic,
    };

    await this.saveState(state);
    logger.info({ chatId, topic }, 'Log chat ID set');
  }

  /**
   * Create a new log chat and set it as the log chat.
   *
   * This requires the Feishu client to be configured.
   *
   * @param members - Initial members to add to the chat (open_ids)
   * @param topic - Optional topic for the chat (default: "Pilot Log")
   * @returns The created chat ID
   */
  async createLogChat(members: string[], topic = 'Pilot Log'): Promise<string> {
    if (!this.client) {
      throw new Error('Feishu client is required to create log chat');
    }

    const chatId = await createDiscussionChat(this.client, {
      topic,
      members,
    });

    await this.setLogChatId(chatId, topic);
    logger.info({ chatId, topic, memberCount: members.length }, 'Log chat created');

    return chatId;
  }

  /**
   * Check if log chat is configured.
   */
  async hasLogChat(): Promise<boolean> {
    const chatId = await this.getLogChatId();
    return chatId !== undefined;
  }

  /**
   * Clear the log chat configuration.
   */
  async clearLogChat(): Promise<void> {
    if (fs.existsSync(this.stateFilePath)) {
      await fs.promises.unlink(this.stateFilePath);
      this.cachedState = undefined;
      logger.info('Log chat configuration cleared');
    }
  }

  /**
   * Load state from file.
   */
  private async loadState(): Promise<LogChatState | undefined> {
    // Return cached state if available
    if (this.cachedState) {
      return this.cachedState;
    }

    // Check if file exists
    if (!fs.existsSync(this.stateFilePath)) {
      return undefined;
    }

    try {
      const content = await fs.promises.readFile(this.stateFilePath, 'utf-8');
      const state = JSON.parse(content) as LogChatState;
      this.cachedState = state;
      return state;
    } catch (error) {
      logger.error({ err: error, path: this.stateFilePath }, 'Failed to load log chat state');
      return undefined;
    }
  }

  /**
   * Save state to file.
   */
  private async saveState(state: LogChatState): Promise<void> {
    // Ensure workspace directory exists
    if (!fs.existsSync(this.workspaceDir)) {
      await fs.promises.mkdir(this.workspaceDir, { recursive: true });
    }

    try {
      await fs.promises.writeFile(
        this.stateFilePath,
        JSON.stringify(state, null, 2),
        'utf-8'
      );
      this.cachedState = state;
    } catch (error) {
      logger.error({ err: error, path: this.stateFilePath }, 'Failed to save log chat state');
      throw error;
    }
  }
}
