/**
 * Chat Channel Registry - Tracks chatId to channel type mappings.
 *
 * This module provides a central registry for tracking which channel
 * each chatId belongs to. This enables the MCP tools to route messages
 * to the correct channel adapter.
 *
 * @see Issue #445
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('ChatChannelRegistry');

/**
 * Channel type identifiers.
 */
export type ChannelType = 'feishu' | 'cli' | 'rest' | 'unknown';

/**
 * Chat metadata stored in the registry.
 */
export interface ChatMetadata {
  /** Channel type this chat belongs to */
  channelType: ChannelType;
  /** Original channel ID */
  channelId?: string;
  /** Timestamp when the chat was registered */
  registeredAt: number;
  /** Additional metadata */
  extra?: Record<string, unknown>;
}

/**
 * Chat Channel Registry - Singleton class.
 *
 * Tracks the mapping between chatId and channel type.
 * Used by MCP tools to determine how to send messages.
 *
 * Architecture:
 * ```
 * ChatChannelRegistry
 *     ├── register(chatId, channelType) - Register a new chat
 *     ├── lookup(chatId) - Get channel type for a chat
 *     └── detectChannelType(chatId) - Auto-detect from chatId format
 * ```
 */
export class ChatChannelRegistry {
  private static instance: ChatChannelRegistry | null = null;
  private registry: Map<string, ChatMetadata> = new Map();

  private constructor() {
    logger.debug('ChatChannelRegistry initialized');
  }

  /**
   * Get the singleton instance.
   */
  static getInstance(): ChatChannelRegistry {
    if (!ChatChannelRegistry.instance) {
      ChatChannelRegistry.instance = new ChatChannelRegistry();
    }
    return ChatChannelRegistry.instance;
  }

  /**
   * Reset the singleton instance (for testing).
   */
  static resetInstance(): void {
    ChatChannelRegistry.instance = null;
  }

  /**
   * Register a chatId with its channel type.
   *
   * @param chatId - The chat/conversation ID
   * @param channelType - The channel type
   * @param extra - Optional additional metadata
   */
  register(chatId: string, channelType: ChannelType, extra?: Record<string, unknown>): void {
    const existing = this.registry.get(chatId);
    if (existing) {
      logger.debug(
        { chatId, oldType: existing.channelType, newType: channelType },
        'Updating chat channel type'
      );
    }

    this.registry.set(chatId, {
      channelType,
      registeredAt: Date.now(),
      extra,
    });

    logger.debug({ chatId, channelType }, 'Chat registered');
  }

  /**
   * Look up the channel type for a chatId.
   *
   * @param chatId - The chat/conversation ID
   * @returns The channel type, or 'unknown' if not found
   */
  lookup(chatId: string): ChannelType {
    const metadata = this.registry.get(chatId);
    if (metadata) {
      return metadata.channelType;
    }

    // Auto-detect if not explicitly registered
    return this.detectChannelType(chatId);
  }

  /**
   * Get full metadata for a chatId.
   *
   * @param chatId - The chat/conversation ID
   * @returns The chat metadata, or undefined if not found
   */
  getMetadata(chatId: string): ChatMetadata | undefined {
    return this.registry.get(chatId);
  }

  /**
   * Unregister a chatId.
   *
   * @param chatId - The chat/conversation ID
   */
  unregister(chatId: string): void {
    this.registry.delete(chatId);
    logger.debug({ chatId }, 'Chat unregistered');
  }

  /**
   * Clear all registrations.
   */
  clear(): void {
    this.registry.clear();
    logger.debug('All chats unregistered');
  }

  /**
   * Get all chats of a specific channel type.
   *
   * @param channelType - The channel type to filter by
   * @returns Array of chatIds
   */
  getChatsByType(channelType: ChannelType): string[] {
    const chats: string[] = [];
    for (const [chatId, metadata] of this.registry) {
      if (metadata.channelType === channelType) {
        chats.push(chatId);
      }
    }
    return chats;
  }

  /**
   * Auto-detect channel type from chatId format.
   *
   * Detection rules:
   * - Starts with 'cli-': CLI channel
   * - Starts with 'rest-': REST channel
   * - Looks like UUID (8-4-4-4-12 format): Likely REST channel (UUID generated)
   * - Starts with 'oc_': Feishu group chat
   * - Otherwise: Unknown (treated as Feishu for backward compatibility)
   *
   * @param chatId - The chat/conversation ID
   * @returns The detected channel type
   */
  detectChannelType(chatId: string): ChannelType {
    // CLI mode detection
    if (chatId.startsWith('cli-')) {
      return 'cli';
    }

    // REST channel detection (explicit prefix)
    if (chatId.startsWith('rest-')) {
      return 'rest';
    }

    // UUID format detection (REST channel typically generates UUIDs)
    // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(chatId)) {
      // This is likely a REST-generated chatId
      // But we should check if it's registered as Feishu first
      // Since it wasn't found in registry, assume REST
      logger.debug(
        { chatId },
        'Detected UUID-format chatId, assuming REST channel'
      );
      return 'rest';
    }

    // Feishu chat ID patterns
    // - Group chats: oc_xxxxxxxxxxxxxxxx
    // - Private chats: ou_xxxxxxxxxxxxxxxx (user ID)
    if (chatId.startsWith('oc_') || chatId.startsWith('ou_')) {
      return 'feishu';
    }

    // Default: For backward compatibility, treat unknown as Feishu
    // This maintains existing behavior for Feishu chats that don't match patterns
    logger.debug(
      { chatId },
      'Unknown chatId format, defaulting to Feishu for backward compatibility'
    );
    return 'feishu';
  }

  /**
   * Check if a chatId belongs to a specific channel type.
   *
   * @param chatId - The chat/conversation ID
   * @param channelType - The channel type to check
   * @returns True if the chat belongs to the specified channel type
   */
  isChannelType(chatId: string, channelType: ChannelType): boolean {
    return this.lookup(chatId) === channelType;
  }

  /**
   * Get statistics about the registry.
   */
  getStats(): { total: number; byType: Record<ChannelType, number> } {
    const byType: Record<ChannelType, number> = {
      feishu: 0,
      cli: 0,
      rest: 0,
      unknown: 0,
    };

    for (const metadata of this.registry.values()) {
      byType[metadata.channelType]++;
    }

    return {
      total: this.registry.size,
      byType,
    };
  }
}

/**
 * Global registry instance.
 * Exported for convenience, but prefer using ChatChannelRegistry.getInstance().
 */
export const chatChannelRegistry = ChatChannelRegistry.getInstance();
