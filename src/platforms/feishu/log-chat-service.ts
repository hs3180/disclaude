/**
 * Log Chat Service - Manages debug log chat configuration.
 *
 * Provides functionality to set, clear, and show the debug log chat
 * where Bot sends debug-level messages.
 *
 * Data is persisted to workspace/log-chat.json
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('LogChatService');

/**
 * Log chat configuration structure.
 */
export interface LogChatConfig {
  /** Target chat ID for debug messages */
  chatId: string;

  /** Optional topic/description for the log chat */
  topic?: string;

  /** When the configuration was set */
  setAt?: string;

  /** Who set the configuration (open_id) */
  setBy?: string;
}

/**
 * LogChatService - Manages debug log chat configuration.
 *
 * Features:
 * - Set log chat for debug messages
 * - Clear log chat configuration
 * - Show current configuration
 * - Persistent storage to JSON file
 */
export class LogChatService {
  private configPath: string;
  private config: LogChatConfig | null = null;
  private initialized = false;

  constructor(workspacePath: string = 'workspace') {
    this.configPath = path.join(workspacePath, 'log-chat.json');
  }

  /**
   * Initialize the service by loading existing configuration.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const data = await fs.readFile(this.configPath, 'utf-8');
      this.config = JSON.parse(data) as LogChatConfig;
      logger.info({ config: this.config }, 'Log chat configuration loaded');
    } catch (error) {
      // File doesn't exist or is invalid - start with empty config
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err: error }, 'Failed to load log chat configuration, starting fresh');
      }
      this.config = null;
    }

    this.initialized = true;
  }

  /**
   * Save configuration to file.
   */
  private async save(): Promise<void> {
    // Ensure workspace directory exists
    const workspaceDir = path.dirname(this.configPath);
    await fs.mkdir(workspaceDir, { recursive: true });

    if (this.config) {
      await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
      logger.info({ config: this.config }, 'Log chat configuration saved');
    } else {
      // Remove config file if no config
      try {
        await fs.unlink(this.configPath);
        logger.info('Log chat configuration file removed');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }

  /**
   * Set the log chat.
   *
   * @param chatId - Target chat ID for debug messages
   * @param topic - Optional topic/description
   * @param setBy - Optional user who set the configuration
   * @returns Success message
   */
  async setLogChat(chatId: string, topic?: string, setBy?: string): Promise<string> {
    await this.init();

    this.config = {
      chatId,
      topic: topic || '调试日志',
      setAt: new Date().toISOString(),
      setBy,
    };

    await this.save();

    return `✅ **调试日志群已设置**

Chat ID: \`${chatId}\`
主题: ${this.config.topic}
时间: ${this.config.setAt ? new Date(this.config.setAt).toLocaleString('zh-CN') : '未知'}

Bot 将向该群发送调试级别的消息。`;
  }

  /**
   * Clear the log chat configuration.
   *
   * @returns Success message
   */
  async clearLogChat(): Promise<string> {
    await this.init();

    if (!this.config) {
      return `⚠️ **未设置调试日志群**

当前没有配置调试日志群。`;
    }

    const oldConfig = { ...this.config };
    this.config = null;
    await this.save();

    return `✅ **调试日志群已清除**

已移除: \`${oldConfig.chatId}\` (${oldConfig.topic || '无主题'})

Bot 将不再发送调试消息到该群。`;
  }

  /**
   * Show the current log chat configuration.
   *
   * @returns Configuration details or "not set" message
   */
  async showLogChat(): Promise<string> {
    await this.init();

    if (!this.config) {
      return `📋 **调试日志群配置**

当前状态: 未设置

使用 \`/set-log-chat <chatId> [topic]\` 设置调试日志群。`;
    }

    return `📋 **调试日志群配置**

**状态**: ✅ 已设置
**Chat ID**: \`${this.config.chatId}\`
**主题**: ${this.config.topic || '无'}
**设置时间**: ${this.config.setAt ? new Date(this.config.setAt).toLocaleString('zh-CN') : '未知'}
${this.config.setBy ? `**设置者**: \`${this.config.setBy}\`` : ''}

使用 \`/clear-log-chat\` 清除配置。`;
  }

  /**
   * Get the current log chat ID.
   *
   * @returns Chat ID or null if not set
   */
  async getLogChatId(): Promise<string | null> {
    await this.init();
    return this.config?.chatId || null;
  }

  /**
   * Check if log chat is configured.
   *
   * @returns true if log chat is set
   */
  async hasLogChat(): Promise<boolean> {
    await this.init();
    return this.config !== null;
  }

  /**
   * Get the full configuration.
   *
   * @returns Current config or null
   */
  async getConfig(): Promise<LogChatConfig | null> {
    await this.init();
    return this.config ? { ...this.config } : null;
  }
}

// Singleton instance
let logChatService: LogChatService | null = null;

/**
 * Get the singleton LogChatService instance.
 */
export function getLogChatService(workspacePath?: string): LogChatService {
  if (!logChatService) {
    logChatService = new LogChatService(workspacePath);
  }
  return logChatService;
}

/**
 * Reset the singleton (for testing).
 */
export function resetLogChatService(): void {
  logChatService = null;
}
