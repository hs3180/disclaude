/**
 * Message Service - Unified message routing and format conversion.
 *
 * This service integrates channel adapters and provides a unified interface
 * for sending messages to any channel type.
 *
 * Issue #515: Universal Message Format + Channel Adapters (Phase 2)
 *
 * @example
 * ```typescript
 * const messageService = new MessageService({
 *   adapters: [new FeishuAdapter(), new CliAdapter(), new RestAdapter()],
 * });
 *
 * // Send a message - automatically routed to the correct adapter
 * await messageService.send({
 *   chatId: 'oc_xxx',
 *   content: { type: 'text', text: 'Hello!' }
 * });
 *
 * // Query capabilities
 * const caps = messageService.getCapabilities('oc_xxx');
 * console.log(caps.supportsCard); // true for Feishu
 * ```
 */

import { createLogger, type UniversalMessage, type SendResult, type CardContent } from '@disclaude/core';
import { cardToText, getFallbackContentType, type IChannelAdapter, type ChannelCapabilities } from './channel-adapter.js';

const logger = createLogger('MessageService');

/**
 * Message Service options.
 */
export interface MessageServiceOptions {
  /** Channel adapters to register */
  adapters: IChannelAdapter[];
  /** Whether to auto-fallback to text for unsupported content types */
  autoFallback?: boolean;
}

/**
 * Message Service - Routes messages to appropriate channel adapters.
 *
 * Features:
 * - Automatic channel detection and routing
 * - Capability negotiation
 * - Format fallback for unsupported content types
 * - Unified send interface
 */
export class MessageService {
  private adapters: Map<string, IChannelAdapter> = new Map();
  private autoFallback: boolean;

  constructor(options: MessageServiceOptions) {
    this.autoFallback = options.autoFallback ?? true;

    // Register adapters
    for (const adapter of options.adapters) {
      this.registerAdapter(adapter);
    }

    logger.info({ adapterCount: this.adapters.size }, 'MessageService initialized');
  }

  /**
   * Register a channel adapter.
   */
  registerAdapter(adapter: IChannelAdapter): void {
    this.adapters.set(adapter.name, adapter);
    logger.debug({ adapterName: adapter.name }, 'Adapter registered');
  }

  /**
   * Get the adapter for a chatId.
   * @returns The adapter or undefined if no adapter can handle it
   */
  getAdapter(chatId: string): IChannelAdapter | undefined {
    for (const adapter of this.adapters.values()) {
      if (adapter.canHandle(chatId)) {
        return adapter;
      }
    }
    return undefined;
  }

  /**
   * Get capabilities for a chatId.
   */
  getCapabilities(chatId: string): ChannelCapabilities {
    const adapter = this.getAdapter(chatId);
    return adapter?.capabilities ?? {
      supportsCard: false,
      supportsThread: false,
      supportsFile: false,
      supportsMarkdown: false,
      maxMessageLength: 4096,
      supportedContentTypes: ['text'],
      supportsUpdate: false,
      supportsDelete: false,
      supportsMention: false,
      supportsReactions: false,
    };
  }

  /**
   * Check if a content type is supported for a chatId.
   */
  isContentTypeSupported(chatId: string, contentType: string): boolean {
    const capabilities = this.getCapabilities(chatId);
    return capabilities.supportedContentTypes.includes(contentType);
  }

  /**
   * Send a message to the appropriate channel.
   *
   * Automatically:
   * 1. Detects the channel from chatId
   * 2. Checks if content type is supported
   * 3. Falls back to text if needed
   * 4. Sends via the appropriate adapter
   */
  async send(message: UniversalMessage): Promise<SendResult> {
    const adapter = this.getAdapter(message.chatId);

    if (!adapter) {
      logger.warn({ chatId: message.chatId }, 'No adapter found for chatId');
      return {
        success: false,
        error: `No adapter can handle chatId: ${message.chatId}`,
      };
    }

    // Check content type support
    const contentType = message.content.type;
    const isSupported = this.isContentTypeSupported(message.chatId, contentType);

    let messageToSend = message;

    // If content type is not supported
    if (!isSupported) {
      if (!this.autoFallback) {
        // Auto fallback disabled - return error
        return {
          success: false,
          error: `Content type '${contentType}' not supported by adapter '${adapter.name}'`,
        };
      }

      // Try to fallback to a supported format
      const fallbackType = getFallbackContentType(adapter.capabilities, contentType);

      if (fallbackType === 'text' && contentType === 'card') {
        // Convert card to text
        logger.debug({ chatId: message.chatId }, 'Falling back card to text');
        messageToSend = {
          ...message,
          content: {
            type: 'text',
            text: cardToText(message.content as CardContent),
          },
        };
      } else if (fallbackType === 'text' && contentType === 'markdown') {
        // Markdown can be sent as text (with formatting lost)
        logger.debug({ chatId: message.chatId }, 'Falling back markdown to text');
        messageToSend = {
          ...message,
          content: {
            type: 'text',
            text: message.content.text,
          },
        };
      } else if (!fallbackType) {
        return {
          success: false,
          error: `Content type '${contentType}' not supported and no fallback available`,
        };
      }
    }

    logger.debug(
      {
        chatId: message.chatId,
        adapterName: adapter.name,
        contentType: messageToSend.content.type,
      },
      'Sending message'
    );

    return await adapter.send(messageToSend);
  }

  /**
   * Update an existing message.
   */
  async update(messageId: string, message: UniversalMessage): Promise<SendResult> {
    const adapter = this.getAdapter(message.chatId);

    if (!adapter) {
      return {
        success: false,
        error: `No adapter can handle chatId: ${message.chatId}`,
      };
    }

    if (!adapter.update) {
      return {
        success: false,
        error: `Adapter '${adapter.name}' does not support message updates`,
      };
    }

    return await adapter.update(messageId, message);
  }

  /**
   * Delete a message.
   */
  async delete(chatId: string, messageId: string): Promise<boolean> {
    const adapter = this.getAdapter(chatId);

    if (!adapter) {
      logger.warn({ chatId }, 'No adapter found for chatId');
      return false;
    }

    if (!adapter.delete) {
      logger.warn({ adapterName: adapter.name }, 'Adapter does not support message deletion');
      return false;
    }

    return await adapter.delete(messageId);
  }

  /**
   * Broadcast a message to all registered adapters.
   */
  async broadcast(message: UniversalMessage): Promise<Map<string, SendResult>> {
    const results = new Map<string, SendResult>();

    for (const [name, adapter] of this.adapters) {
      try {
        const result = await adapter.send(message);
        results.set(name, result);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        results.set(name, {
          success: false,
          error: errorMessage,
        });
      }
    }

    return results;
  }

  /**
   * Get all registered adapter names.
   */
  getAdapterNames(): string[] {
    return Array.from(this.adapters.keys());
  }
}

// ============================================================================
// Global Instance Management
// ============================================================================

let globalMessageService: MessageService | null = null;

/**
 * Initialize the global message service.
 */
export function initMessageService(options: MessageServiceOptions): MessageService {
  globalMessageService = new MessageService(options);
  logger.info('Global MessageService initialized');
  return globalMessageService;
}

/**
 * Get the global message service.
 * @throws Error if not initialized
 */
export function getMessageService(): MessageService {
  if (!globalMessageService) {
    throw new Error('MessageService not initialized. Call initMessageService first.');
  }
  return globalMessageService;
}

/**
 * Reset the global message service (for testing).
 */
export function resetMessageService(): void {
  globalMessageService = null;
}
