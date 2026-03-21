/**
 * REST Channel Adapter - Converts UMF to JSON for REST API responses.
 *
 * This adapter handles message conversion for REST API channel.
 * It keeps messages in JSON format for programmatic access.
 *
 * Issue #515: Universal Message Format + Channel Adapters (Phase 2)
 */

import { createLogger, type UniversalMessage, type SendResult } from '@disclaude/core';
import type { IChannelAdapter, ChannelCapabilities } from '../channel-adapter.js';

const logger = createLogger('RestAdapter');

/**
 * REST message format - The JSON structure returned to REST clients.
 */
export interface RestMessage {
  /** Message ID */
  id: string;
  /** Chat ID */
  chatId: string;
  /** Thread ID if part of a thread */
  threadId?: string;
  /** Message content (UMF format) */
  content: UniversalMessage['content'];
  /** Timestamp */
  timestamp: number;
  /** Metadata */
  metadata?: UniversalMessage['metadata'];
}

/**
 * REST Adapter - Keeps messages in JSON format for REST clients.
 *
 * Note: This adapter doesn't actually "send" messages anywhere.
 * Instead, it converts messages to a format that can be polled or
 * streamed by REST clients. The actual delivery mechanism is handled
 * by the REST channel implementation.
 */
export class RestAdapter implements IChannelAdapter {
  readonly name = 'rest';
  readonly capabilities: ChannelCapabilities = {
    supportsCard: true,
    supportsThread: false,
    supportsFile: false,
    supportsMarkdown: true,
    maxMessageLength: Infinity,
    supportedContentTypes: ['text', 'markdown', 'card', 'file', 'done'],
    supportsUpdate: false,
    supportsDelete: false,
    supportsMention: false,
    supportsReactions: false,
  };

  // Message store for REST polling (in-memory, for demo purposes)
  // In a real implementation, this would be replaced with a proper message queue
  private messageStore: Map<string, RestMessage[]> = new Map();

  /**
   * Check if this adapter can handle the given chatId.
   * REST chat IDs are UUID format.
   */
  canHandle(chatId: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chatId);
  }

  /**
   * Convert Universal Message to REST JSON format.
   */
  convert(message: UniversalMessage): RestMessage {
    return {
      id: this.generateMessageId(),
      chatId: message.chatId,
      threadId: message.threadId,
      content: message.content,
      timestamp: Date.now(),
      metadata: message.metadata,
    };
  }

  /**
   * Generate a unique message ID.
   */
  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Store a message for REST polling.
   *
   * Note: In a real implementation, this would push to a message queue
   * or notify connected WebSocket clients.
   */
  send(message: UniversalMessage): Promise<SendResult> {
    try {
      const restMessage = this.convert(message);

      // Store the message for this chat
      const chatMessages = this.messageStore.get(message.chatId) || [];
      chatMessages.push(restMessage);
      this.messageStore.set(message.chatId, chatMessages);

      logger.debug(
        {
          chatId: message.chatId,
          messageId: restMessage.id,
          contentType: message.content.type,
        },
        'REST message stored'
      );

      return Promise.resolve({
        success: true,
        messageId: restMessage.id,
        platformData: restMessage as unknown as Record<string, unknown>,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, chatId: message.chatId }, 'Failed to store REST message');
      return Promise.resolve({
        success: false,
        error: errorMessage,
      });
    }
  }

  /**
   * Get all messages for a chat (for polling).
   */
  getMessages(chatId: string): RestMessage[] {
    return this.messageStore.get(chatId) || [];
  }

  /**
   * Get messages since a specific message ID.
   */
  getMessagesSince(chatId: string, sinceId: string): RestMessage[] {
    const messages = this.messageStore.get(chatId) || [];
    const index = messages.findIndex((m) => m.id === sinceId);
    if (index === -1) {
      return messages;
    }
    return messages.slice(index + 1);
  }

  /**
   * Clear messages for a chat.
   */
  clearMessages(chatId: string): void {
    this.messageStore.delete(chatId);
  }
}

/**
 * Global REST adapter instance for message polling.
 */
let globalRestAdapter: RestAdapter | null = null;

/**
 * Get the global REST adapter instance.
 */
export function getRestAdapter(): RestAdapter {
  if (!globalRestAdapter) {
    globalRestAdapter = new RestAdapter();
  }
  return globalRestAdapter;
}

/**
 * Reset the global REST adapter (for testing).
 */
export function resetRestAdapter(): void {
  globalRestAdapter = null;
}

/**
 * Create a new REST adapter instance.
 */
export function createRestAdapter(): RestAdapter {
  return new RestAdapter();
}
