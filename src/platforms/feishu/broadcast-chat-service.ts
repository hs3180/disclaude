/**
 * Broadcast Chat Service.
 *
 * Manages broadcast chat configurations using MD file format.
 * Broadcast chats are chats where the bot only sends messages but does not respond to user messages.
 *
 * Features:
 * - MD file format for easy reading and editing
 * - Dynamic add/remove broadcast chats
 * - Cached loading for performance
 */

import fs from 'fs';
import path from 'path';
import { Config } from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('BroadcastChatService');

/**
 * Broadcast chat configuration.
 */
export interface BroadcastChat {
  /** Chat ID (e.g., oc_xxx) */
  chatId: string;
  /** Human-readable name */
  name: string;
  /** Description of the broadcast chat's purpose */
  description?: string;
  /** When this chat was added as a broadcast chat */
  addedAt: string;
}

/**
 * Broadcast Chat Service Configuration.
 */
export interface BroadcastChatServiceConfig {
  /** Workspace directory for storing the MD file */
  workspaceDir?: string;
}

/**
 * Broadcast Chat Service.
 *
 * Manages broadcast chat configurations stored in MD file format.
 * The file is stored in the workspace directory.
 */
export class BroadcastChatService {
  private readonly filePath: string;
  private cache: BroadcastChat[] | null = null;
  private lastLoadTime: number = 0;
  private readonly CACHE_TTL = 5000; // 5 seconds cache

  constructor(config: BroadcastChatServiceConfig = {}) {
    const workspaceDir = config.workspaceDir || Config.getWorkspaceDir();
    this.filePath = path.join(workspaceDir, 'broadcast-chats.md');
    logger.debug({ filePath: this.filePath }, 'BroadcastChatService initialized');
  }

  /**
   * Load broadcast chats from the MD file.
   * Uses caching to avoid frequent file reads.
   */
  loadBroadcastChats(): BroadcastChat[] {
    const now = Date.now();

    // Return cached data if still valid
    if (this.cache !== null && (now - this.lastLoadTime) < this.CACHE_TTL) {
      return this.cache;
    }

    // Check if file exists
    if (!fs.existsSync(this.filePath)) {
      logger.debug('Broadcast chats file not found, returning empty list');
      this.cache = [];
      this.lastLoadTime = now;
      return this.cache;
    }

    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      this.cache = this.parseMdContent(content);
      this.lastLoadTime = now;
      logger.debug({ count: this.cache.length }, 'Loaded broadcast chats');
      return this.cache;
    } catch (error) {
      logger.error({ err: error, filePath: this.filePath }, 'Failed to load broadcast chats');
      return [];
    }
  }

  /**
   * Check if a chat is a broadcast chat.
   * @param chatId - The chat ID to check
   */
  isBroadcastChat(chatId: string): boolean {
    const chats = this.loadBroadcastChats();
    return chats.some(chat => chat.chatId === chatId);
  }

  /**
   * Add a chat to the broadcast list.
   * @param chatId - The chat ID to add
   * @param name - Human-readable name for the chat
   * @param description - Optional description
   */
  addBroadcastChat(chatId: string, name: string, description?: string): boolean {
    const chats = this.loadBroadcastChats();

    // Check if already exists
    if (chats.some(chat => chat.chatId === chatId)) {
      logger.debug({ chatId }, 'Chat already in broadcast list');
      return false;
    }

    const newChat: BroadcastChat = {
      chatId,
      name,
      description,
      addedAt: new Date().toISOString(),
    };

    chats.push(newChat);
    this.saveBroadcastChats(chats);
    logger.info({ chatId, name }, 'Added broadcast chat');
    return true;
  }

  /**
   * Remove a chat from the broadcast list.
   * @param chatId - The chat ID to remove
   */
  removeBroadcastChat(chatId: string): boolean {
    const chats = this.loadBroadcastChats();
    const index = chats.findIndex(chat => chat.chatId === chatId);

    if (index === -1) {
      logger.debug({ chatId }, 'Chat not found in broadcast list');
      return false;
    }

    chats.splice(index, 1);
    this.saveBroadcastChats(chats);
    logger.info({ chatId }, 'Removed broadcast chat');
    return true;
  }

  /**
   * Parse MD content to extract broadcast chats.
   */
  private parseMdContent(content: string): BroadcastChat[] {
    const chats: BroadcastChat[] = [];

    // Find the broadcast list section between markers
    const listMatch = content.match(/<!-- BROADCAST_LIST_START -->([\s\S]*?)<!-- BROADCAST_LIST_END -->/);
    if (!listMatch) {
      return chats;
    }

    const [, listContent] = listMatch;

    // Parse each chat entry
    // Format:
    // ### Name
    // - **Chat ID**: `oc_xxx`
    // - **描述**: description
    // - **添加时间**: timestamp
    const chatRegex = /### (.+?)\n- \*\*Chat ID\*\*: `([^`]+)`(?:\n- \*\*描述\*\*: (.+?))?\n- \*\*添加时间\*\*: (.+?)(?=\n\n### |\n*$)/g;

    let match;
    while ((match = chatRegex.exec(listContent)) !== null) {
      chats.push({
        name: match[1].trim(),
        chatId: match[2].trim(),
        description: match[3]?.trim() || undefined,
        addedAt: match[4].trim(),
      });
    }

    return chats;
  }

  /**
   * Save broadcast chats to the MD file.
   */
  private saveBroadcastChats(chats: BroadcastChat[]): void {
    const content = this.generateMdContent(chats);

    // Ensure workspace directory exists
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(this.filePath, content, 'utf-8');
    this.cache = chats;
    this.lastLoadTime = Date.now();
    logger.debug({ filePath: this.filePath, count: chats.length }, 'Saved broadcast chats');
  }

  /**
   * Generate MD content from broadcast chats.
   */
  private generateMdContent(chats: BroadcastChat[]): string {
    const lines: string[] = [
      '# 广播群配置',
      '',
      '此文件由 disclaude 自动管理。广播群中的用户消息将被忽略，只发送不处理。',
      '',
      '## 广播群列表',
      '',
      '<!-- BROADCAST_LIST_START -->',
    ];

    if (chats.length === 0) {
      lines.push('（暂无广播群）');
    } else {
      for (const chat of chats) {
        lines.push(`### ${chat.name}`);
        lines.push(`- **Chat ID**: \`${chat.chatId}\``);
        if (chat.description) {
          lines.push(`- **描述**: ${chat.description}`);
        }
        lines.push(`- **添加时间**: ${chat.addedAt}`);
        lines.push('');
      }
    }

    lines.push('<!-- BROADCAST_LIST_END -->');
    lines.push('');
    lines.push('## 如何添加广播群');
    lines.push('');
    lines.push('使用以下命令添加广播群：');
    lines.push('```');
    lines.push('/add-broadcast <chatId> <name> [description]');
    lines.push('```');
    lines.push('');
    lines.push('使用以下命令移除广播群：');
    lines.push('```');
    lines.push('/remove-broadcast <chatId>');
    lines.push('```');

    return lines.join('\n');
  }

  /**
   * Clear the cache to force reload.
   */
  clearCache(): void {
    this.cache = null;
    this.lastLoadTime = 0;
  }
}

// Export singleton instance (uses default Config.getWorkspaceDir())
export const broadcastChatService = new BroadcastChatService();
