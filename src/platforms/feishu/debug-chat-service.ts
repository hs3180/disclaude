/**
 * DebugChatService - Manages debug chat configuration.
 *
 * Provides a simple way to configure which chat receives debug-level messages.
 * Uses singleton pattern - only one debug chat per instance.
 * Stores configuration in workspace/debug-chat.json.
 *
 * @see Issue #487 - Debug chat configuration commands
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('DebugChatService');

/**
 * Debug chat configuration.
 */
interface DebugChatConfig {
  /** Chat ID for debug messages */
  chatId: string;
}

/**
 * DebugChatService configuration.
 */
export interface DebugChatServiceConfig {
  /** Storage file path (default: workspace/debug-chat.json) */
  filePath?: string;
}

/**
 * Service for managing debug chat configuration.
 *
 * Features:
 * - Set/get/clear debug chat
 * - Persistent storage
 * - Singleton pattern (one debug chat per instance)
 */
export class DebugChatService {
  private filePath: string;
  private config: DebugChatConfig | null;

  constructor(config: DebugChatServiceConfig = {}) {
    this.filePath = config.filePath || path.join(process.cwd(), 'workspace', 'debug-chat.json');
    this.config = this.load();
  }

  /**
   * Load configuration from file.
   */
  private load(): DebugChatConfig | null {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        const data = JSON.parse(content) as DebugChatConfig;
        if (data.chatId) {
          logger.info({ chatId: data.chatId }, 'Debug chat config loaded');
          return data;
        }
      }
    } catch (error) {
      logger.warn({ err: error }, 'Failed to load debug chat config, starting fresh');
    }
    return null;
  }

  /**
   * Save configuration to file.
   */
  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (this.config) {
        fs.writeFileSync(this.filePath, JSON.stringify(this.config, null, 2));
      } else {
        // Remove file if no config
        if (fs.existsSync(this.filePath)) {
          fs.unlinkSync(this.filePath);
        }
      }
      logger.debug({ config: this.config }, 'Debug chat config saved');
    } catch (error) {
      logger.error({ err: error }, 'Failed to save debug chat config');
    }
  }

  /**
   * Set the debug chat.
   * This will replace any existing debug chat.
   *
   * @param chatId - Chat ID to set as debug chat
   * @returns Previous chat ID if there was one
   */
  setDebugChat(chatId: string): string | null {
    const previousChatId = this.config?.chatId || null;
    this.config = { chatId };
    this.save();
    logger.info({ chatId, previousChatId }, 'Debug chat set');
    return previousChatId;
  }

  /**
   * Get the current debug chat ID.
   *
   * @returns Debug chat ID or null if not set
   */
  getDebugChat(): string | null {
    return this.config?.chatId || null;
  }

  /**
   * Clear the debug chat configuration.
   *
   * @returns The previous chat ID if there was one
   */
  clearDebugChat(): string | null {
    const previousChatId = this.config?.chatId || null;
    this.config = null;
    this.save();
    logger.info({ previousChatId }, 'Debug chat cleared');
    return previousChatId;
  }

  /**
   * Check if a chat is the debug chat.
   *
   * @param chatId - Chat ID to check
   * @returns Whether this is the debug chat
   */
  isDebugChat(chatId: string): boolean {
    return this.config?.chatId === chatId;
  }

  /**
   * Get the storage file path.
   */
  getFilePath(): string {
    return this.filePath;
  }
}

// Singleton instance for convenience
let defaultInstance: DebugChatService | undefined;

/**
 * Get the default DebugChatService instance.
 */
export function getDebugChatService(): DebugChatService {
  if (!defaultInstance) {
    defaultInstance = new DebugChatService();
  }
  return defaultInstance;
}
