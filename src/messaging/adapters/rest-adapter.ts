/**
 * REST Channel Adapter - JSON output for REST API.
 *
 * Converts UniversalMessage to JSON format for REST API responses.
 * Handles UUID-format chatIds.
 *
 * @see Issue #480
 */

import { createLogger } from '../../utils/logger.js';
import { BaseChannelAdapter, type SendResult } from '../channel-adapter.js';
import {
  REST_CAPABILITIES,
  type UniversalMessage,
} from '../universal-message.js';

const logger = createLogger('RESTAdapter');

/**
 * UUID format regex.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * REST Channel Adapter.
 * Outputs messages as JSON for REST API responses.
 */
export class RESTAdapter extends BaseChannelAdapter {
  readonly id = 'rest';
  readonly name = 'REST Adapter';
  readonly capabilities = REST_CAPABILITIES;

  /**
   * Message storage for REST polling.
   * Maps chatId to array of messages.
   */
  private messageStore: Map<string, UniversalMessage[]> = new Map();

  /**
   * Handle UUID-format chatIds.
   */
  canHandle(chatId: string): boolean {
    return UUID_REGEX.test(chatId);
  }

  /**
   * Convert to JSON-serializable format.
   */
  convert(message: UniversalMessage): Record<string, unknown> {
    const { chatId, threadId, content, metadata } = message;

    const result: Record<string, unknown> = {
      chatId,
      threadId,
      content,
      timestamp: metadata?.timestamp ?? Date.now(),
    };

    if (metadata?.level) {
      result.level = metadata.level;
    }

    return result;
  }

  /**
   * Store message for REST polling.
   */
  send(message: UniversalMessage): Promise<SendResult> {
    const { chatId } = message;
    const messageId = `rest-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    try {
      // Store message for REST polling
      if (!this.messageStore.has(chatId)) {
        this.messageStore.set(chatId, []);
      }

      const messages = this.messageStore.get(chatId)!;
      messages.push({
        ...message,
        metadata: {
          ...message.metadata,
          messageId,
          timestamp: Date.now(),
        },
      });

      // Keep only last 100 messages per chat
      if (messages.length > 100) {
        messages.shift();
      }

      logger.debug({
        chatId,
        messageId,
        contentType: message.content.type,
        queueSize: messages.length,
      }, 'REST message queued');

      return Promise.resolve(this.successResult(messageId, { queued: true }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, chatId }, 'REST send failed');
      return Promise.resolve(this.errorResult(errorMessage));
    }
  }

  /**
   * Get pending messages for a chat.
   * Used by REST API for polling.
   */
  getMessages(chatId: string): UniversalMessage[] {
    return this.messageStore.get(chatId) ?? [];
  }

  /**
   * Clear messages for a chat.
   */
  clearMessages(chatId: string): void {
    this.messageStore.delete(chatId);
  }

  /**
   * Get message count for a chat.
   */
  getMessageCount(chatId: string): number {
    return this.messageStore.get(chatId)?.length ?? 0;
  }
}

/**
 * Global REST adapter instance for REST API access.
 */
let globalRESTAdapter: RESTAdapter | null = null;

/**
 * Get the global REST adapter instance.
 */
export function getRESTAdapter(): RESTAdapter | null {
  return globalRESTAdapter;
}

/**
 * Set the global REST adapter instance.
 */
export function setRESTAdapter(adapter: RESTAdapter | null): void {
  globalRESTAdapter = adapter;
}

/**
 * Factory function to create REST adapter.
 */
export function createRESTAdapter(): RESTAdapter {
  const adapter = new RESTAdapter();
  setRESTAdapter(adapter);
  return adapter;
}
