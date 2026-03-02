/**
 * Message Service - Unified message routing and delivery.
 *
 * This service provides a single interface for sending messages to any channel.
 * It automatically detects the target channel based on chatId format and routes
 * to the appropriate adapter.
 *
 * Architecture:
 * ```
 *   MCP Tools / Exec Node
 *           │
 *           ▼
 *   ┌───────────────────┐
 *   │  MessageService   │
 *   │  - Route by chatId│
 *   │  - Capability neg.│
 *   │  - Format convert │
 *   └─────────┬─────────┘
 *             │
 *   ┌─────────┼─────────┐
 *   ▼         ▼         ▼
 * Feishu    CLI      REST
 * Adapter  Adapter  Adapter
 * ```
 *
 * @see Issue #480
 */

import { createLogger } from '../utils/logger.js';
import type { IChannelAdapter, SendResult } from './channel-adapter.js';
import type {
  UniversalMessage,
  MessageContent,
  ChannelCapabilities,
  CardContent,
} from './universal-message.js';

const logger = createLogger('MessageService');

/**
 * Message Service configuration.
 */
export interface MessageServiceConfig {
  /** Adapters to register */
  adapters?: IChannelAdapter[];
  /** Default adapter to use when no match found */
  defaultAdapter?: IChannelAdapter;
  /** Enable fallback to all adapters when no match */
  enableBroadcast?: boolean;
}

/**
 * Result of sending a message through MessageService.
 */
export interface MessageServiceResult {
  /** Overall success status */
  success: boolean;
  /** Results from each adapter */
  results: Array<{
    adapterId: string;
    result: SendResult;
  }>;
  /** Combined error messages */
  error?: string;
}

/**
 * Message Service - Unified message routing and delivery.
 *
 * Provides a single interface for sending messages to any channel.
 * Automatically detects the target channel based on chatId format.
 */
export class MessageService {
  private adapters: Map<string, IChannelAdapter> = new Map();
  private defaultAdapter: IChannelAdapter | null = null;
  private enableBroadcast: boolean;

  constructor(config: MessageServiceConfig = {}) {
    this.enableBroadcast = config.enableBroadcast ?? false;

    // Register adapters
    if (config.adapters) {
      for (const adapter of config.adapters) {
        this.registerAdapter(adapter);
      }
    }

    // Set default adapter
    if (config.defaultAdapter) {
      this.defaultAdapter = config.defaultAdapter;
      this.registerAdapter(config.defaultAdapter);
    }
  }

  /**
   * Register a channel adapter.
   */
  registerAdapter(adapter: IChannelAdapter): void {
    this.adapters.set(adapter.id, adapter);
    logger.debug({ adapterId: adapter.id, adapterName: adapter.name }, 'Adapter registered');
  }

  /**
   * Unregister a channel adapter.
   */
  unregisterAdapter(adapterId: string): boolean {
    return this.adapters.delete(adapterId);
  }

  /**
   * Get all registered adapters.
   */
  getAdapters(): IChannelAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Get adapter by ID.
   */
  getAdapter(adapterId: string): IChannelAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  /**
   * Get capabilities for a specific chatId.
   */
  getCapabilities(chatId: string): ChannelCapabilities | null {
    const adapter = this.findAdapter(chatId);
    return adapter?.capabilities ?? null;
  }

  /**
   * Send a universal message.
   * Routes to the appropriate adapter based on chatId.
   */
  async send(message: UniversalMessage): Promise<MessageServiceResult> {
    const { chatId, content } = message;

    logger.debug({
      chatId,
      contentType: content.type,
      hasThreadId: !!message.threadId,
    }, 'Sending message');

    // Find adapter for this chatId
    const adapter = this.findAdapter(chatId);

    if (adapter) {
      // Check if content type is supported
      if (!adapter.capabilities.supportedContentTypes.includes(content.type)) {
        // Try to convert unsupported content
        const convertedMessage = this.convertContent(message, adapter);
        if (convertedMessage) {
          const result = await adapter.send(convertedMessage);
          return {
            success: result.success,
            results: [{ adapterId: adapter.id, result }],
            error: result.error,
          };
        }

        return {
          success: false,
          results: [{ adapterId: adapter.id, result: { success: false, error: `Content type '${content.type}' not supported by adapter '${adapter.id}'` } }],
          error: `Content type '${content.type}' not supported`,
        };
      }

      const result = await adapter.send(message);
      return {
        success: result.success,
        results: [{ adapterId: adapter.id, result }],
        error: result.error,
      };
    }

    // No adapter found
    if (this.defaultAdapter) {
      const result = await this.defaultAdapter.send(message);
      return {
        success: result.success,
        results: [{ adapterId: this.defaultAdapter.id, result }],
        error: result.error,
      };
    }

    // Broadcast mode: send to all adapters
    if (this.enableBroadcast) {
      return this.broadcast(message);
    }

    logger.warn({ chatId }, 'No adapter found for chatId');
    return {
      success: false,
      results: [],
      error: `No adapter found for chatId: ${chatId}`,
    };
  }

  /**
   * Update an existing message.
   */
  async update(
    chatId: string,
    messageId: string,
    content: MessageContent
  ): Promise<MessageServiceResult> {
    const adapter = this.findAdapter(chatId);

    if (!adapter?.update) {
      return {
        success: false,
        results: [],
        error: 'Message update not supported',
      };
    }

    const result = await adapter.update(messageId, content);
    return {
      success: result.success,
      results: [{ adapterId: adapter.id, result }],
      error: result.error,
    };
  }

  /**
   * Send a text message (convenience method).
   */
  sendText(chatId: string, text: string, threadId?: string): Promise<MessageServiceResult> {
    return this.send({
      chatId,
      threadId,
      content: { type: 'text', text },
    });
  }

  /**
   * Send a card message (convenience method).
   */
  sendCard(
    chatId: string,
    card: Omit<CardContent, 'type'>,
    threadId?: string
  ): Promise<MessageServiceResult> {
    return this.send({
      chatId,
      threadId,
      content: { type: 'card', ...card },
    });
  }

  /**
   * Find adapter for a chatId.
   */
  private findAdapter(chatId: string): IChannelAdapter | undefined {
    for (const adapter of this.adapters.values()) {
      if (adapter.canHandle(chatId)) {
        return adapter;
      }
    }
    return undefined;
  }

  /**
   * Broadcast message to all adapters.
   */
  private async broadcast(message: UniversalMessage): Promise<MessageServiceResult> {
    const results: Array<{ adapterId: string; result: SendResult }> = [];
    let hasSuccess = false;
    const errors: string[] = [];

    for (const adapter of this.adapters.values()) {
      try {
        // Skip adapters that don't support the content type
        if (!adapter.capabilities.supportedContentTypes.includes(message.content.type)) {
          const convertedMessage = this.convertContent(message, adapter);
          if (!convertedMessage) {
            continue;
          }
        }

        const result = await adapter.send(message);
        results.push({ adapterId: adapter.id, result });

        if (result.success) {
          hasSuccess = true;
        } else if (result.error) {
          errors.push(`${adapter.id}: ${result.error}`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        results.push({
          adapterId: adapter.id,
          result: { success: false, error: errorMessage },
        });
        errors.push(`${adapter.id}: ${errorMessage}`);
      }
    }

    return {
      success: hasSuccess,
      results,
      error: errors.length > 0 ? errors.join('; ') : undefined,
    };
  }

  /**
   * Convert content to a supported format.
   */
  private convertContent(
    message: UniversalMessage,
    adapter: IChannelAdapter
  ): UniversalMessage | null {
    const { content } = message;
    const supportedTypes = adapter.capabilities.supportedContentTypes;

    // Card to markdown conversion
    if (content.type === 'card' && supportedTypes.includes('markdown')) {
      return {
        ...message,
        content: this.cardToMarkdown(content),
      };
    }

    // Card to text conversion
    if (content.type === 'card' && supportedTypes.includes('text')) {
      return {
        ...message,
        content: this.cardToText(content),
      };
    }

    // Markdown to text conversion
    if (content.type === 'markdown' && supportedTypes.includes('text')) {
      return {
        ...message,
        content: { type: 'text', text: content.text },
      };
    }

    return null;
  }

  /**
   * Convert card content to markdown.
   */
  private cardToMarkdown(card: CardContent): { type: 'markdown'; text: string } {
    const lines: string[] = [];

    lines.push(`## ${card.title}`);
    if (card.subtitle) {
      lines.push(`*${card.subtitle}*`);
    }
    lines.push('');

    for (const section of card.sections) {
      if (section.type === 'text' || section.type === 'markdown') {
        lines.push(section.content ?? '');
      } else if (section.type === 'divider') {
        lines.push('---');
      } else if (section.type === 'actions' && section.actions) {
        const actionTexts = section.actions.map(a => `[${a.label}]`);
        lines.push(actionTexts.join(' | '));
      }
      lines.push('');
    }

    return { type: 'markdown', text: lines.join('\n').trim() };
  }

  /**
   * Convert card content to plain text.
   */
  private cardToText(card: CardContent): { type: 'text'; text: string } {
    const lines: string[] = [];

    lines.push(card.title);
    if (card.subtitle) {
      lines.push(card.subtitle);
    }
    lines.push('');

    for (const section of card.sections) {
      if (section.type === 'text' || section.type === 'markdown') {
        // Strip markdown formatting
        const content = section.content?.replace(/[*_`#]/g, '') ?? '';
        lines.push(content);
      } else if (section.type === 'divider') {
        lines.push('─'.repeat(40));
      } else if (section.type === 'actions' && section.actions) {
        const actionTexts = section.actions.map(a => a.label);
        lines.push(`Actions: ${actionTexts.join(', ')}`);
      }
    }

    return { type: 'text', text: lines.join('\n').trim() };
  }
}

/**
 * Global message service instance.
 * Set by the application during initialization.
 */
let globalMessageService: MessageService | null = null;

/**
 * Get the global message service instance.
 */
export function getMessageService(): MessageService | null {
  return globalMessageService;
}

/**
 * Set the global message service instance.
 */
export function setMessageService(service: MessageService | null): void {
  globalMessageService = service;
}

/**
 * Create a message service with standard adapters.
 */
export function createMessageService(config: MessageServiceConfig = {}): MessageService {
  const service = new MessageService(config);
  setMessageService(service);
  return service;
}
