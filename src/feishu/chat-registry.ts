/**
 * Chat Registry - Manages chatId storage and lookup.
 *
 * Stores mappings of chatId to user metadata for proactive messaging.
 * Persists data to a JSON file in the workspace directory.
 */

import fs from 'fs/promises';
import path from 'path';
import { Config } from '../config/index.js';

/**
 * Chat metadata stored in the registry.
 */
export interface ChatInfo {
  /** Feishu chat ID */
  chatId: string;
  /** User ID who interacted with the bot */
  userId?: string;
  /** Chat name (if available) */
  chatName?: string;
  /** First interaction timestamp */
  firstSeenAt: string;
  /** Last interaction timestamp */
  lastSeenAt: string;
  /** Whether this chat is enabled for proactive messaging */
  enabled: boolean;
}

/**
 * Chat Registry - Manages registered chats for proactive messaging.
 *
 * Usage:
 * ```typescript
 * const registry = new ChatRegistry();
 * await registry.init();
 *
 * // Register a chat
 * await registry.register('oc_xxx', { userId: 'ou_xxx', chatName: 'My Chat' });
 *
 * // Get all enabled chats
 * const chats = await registry.getEnabledChats();
 *
 * // Check if chat exists
 * const info = await registry.get('oc_xxx');
 * ```
 */
export class ChatRegistry {
  private registryPath: string;
  private chats: Map<string, ChatInfo> = new Map();
  private initialized = false;

  constructor() {
    const workspaceDir = Config.getWorkspaceDir();
    this.registryPath = path.join(workspaceDir, 'chat-registry.json');
  }

  /**
   * Initialize the registry by loading from file.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const data = await fs.readFile(this.registryPath, 'utf-8');
      const parsed = JSON.parse(data) as ChatInfo[];
      for (const chat of parsed) {
        this.chats.set(chat.chatId, chat);
      }
      console.log(`[ChatRegistry] Loaded ${this.chats.size} chats from registry`);
    } catch {
      // File doesn't exist or is invalid, start fresh
      console.log('[ChatRegistry] No existing registry found, starting fresh');
    }

    this.initialized = true;
  }

  /**
   * Save the registry to file.
   */
  private async save(): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.registryPath);
      await fs.mkdir(dir, { recursive: true });

      const data = JSON.stringify(Array.from(this.chats.values()), null, 2);
      await fs.writeFile(this.registryPath, data, 'utf-8');
    } catch (error) {
      console.error('[ChatRegistry] Failed to save registry:', error);
    }
  }

  /**
   * Register or update a chat.
   *
   * @param chatId - Feishu chat ID
   * @param options - Optional metadata
   */
  async register(
    chatId: string,
    options?: { userId?: string; chatName?: string; enabled?: boolean }
  ): Promise<ChatInfo> {
    await this.init();

    const now = new Date().toISOString();
    const existing = this.chats.get(chatId);

    const chatInfo: ChatInfo = {
      chatId,
      userId: options?.userId ?? existing?.userId,
      chatName: options?.chatName ?? existing?.chatName,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      enabled: options?.enabled ?? existing?.enabled ?? true,
    };

    this.chats.set(chatId, chatInfo);
    await this.save();

    return chatInfo;
  }

  /**
   * Get chat info by ID.
   *
   * @param chatId - Feishu chat ID
   * @returns Chat info or undefined if not found
   */
  async get(chatId: string): Promise<ChatInfo | undefined> {
    await this.init();
    return this.chats.get(chatId);
  }

  /**
   * Get all registered chats.
   *
   * @returns Array of all chat info
   */
  async getAll(): Promise<ChatInfo[]> {
    await this.init();
    return Array.from(this.chats.values());
  }

  /**
   * Get all chats enabled for proactive messaging.
   *
   * @returns Array of enabled chat info
   */
  async getEnabledChats(): Promise<ChatInfo[]> {
    await this.init();
    return Array.from(this.chats.values()).filter((chat) => chat.enabled);
  }

  /**
   * Enable or disable a chat for proactive messaging.
   *
   * @param chatId - Feishu chat ID
   * @param enabled - Whether to enable or disable
   */
  async setEnabled(chatId: string, enabled: boolean): Promise<boolean> {
    await this.init();

    const chat = this.chats.get(chatId);
    if (!chat) {
      return false;
    }

    chat.enabled = enabled;
    await this.save();
    return true;
  }

  /**
   * Remove a chat from the registry.
   *
   * @param chatId - Feishu chat ID
   * @returns true if chat was removed, false if not found
   */
  async remove(chatId: string): Promise<boolean> {
    await this.init();

    const existed = this.chats.delete(chatId);
    if (existed) {
      await this.save();
    }
    return existed;
  }

  /**
   * Check if a chat is registered.
   *
   * @param chatId - Feishu chat ID
   * @returns true if chat is registered
   */
  async has(chatId: string): Promise<boolean> {
    await this.init();
    return this.chats.has(chatId);
  }

  /**
   * Clear the registry (useful for testing).
   */
  async clear(): Promise<void> {
    this.chats.clear();
    await this.save();
  }
}

// Singleton instance
export const chatRegistry = new ChatRegistry();
