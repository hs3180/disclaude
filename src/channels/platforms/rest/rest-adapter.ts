/**
 * REST Platform Adapter Implementation.
 *
 * Implements IPlatformAdapter interface for REST-based communication.
 * Provides HTTP-based message sending for testing and external integrations.
 */

import type { Logger } from 'pino';
import type { IPlatformAdapter, IMessageSender } from '../../adapters/types.js';

/**
 * REST Platform Adapter Configuration.
 */
export interface RestPlatformAdapterConfig {
  /** Base URL for the REST API */
  baseUrl?: string;
  /** API key for authentication (optional) */
  apiKey?: string;
  /** Logger instance */
  logger: Logger;
  /** Custom message sender (optional, for testing) */
  messageSender?: IMessageSender;
}

/**
 * REST Message Sender.
 *
 * Sends messages via HTTP REST API.
 * Supports both sync and async modes.
 */
export class RestMessageSender implements IMessageSender {
  private baseUrl: string;
  private apiKey?: string;
  private logger: Logger;

  constructor(config: RestPlatformAdapterConfig) {
    this.baseUrl = config.baseUrl || 'http://localhost:3000';
    this.apiKey = config.apiKey;
    this.logger = config.logger;
  }

  async sendText(chatId: string, text: string, threadId?: string): Promise<void> {
    this.logger.debug({ chatId, text: text.substring(0, 50), threadId }, 'REST: Sending text message');
    // REST channel handles message routing internally
    // This is mainly for logging and future HTTP callback support
  }

  async sendCard(
    chatId: string,
    card: Record<string, unknown>,
    description?: string,
    threadId?: string
  ): Promise<void> {
    this.logger.debug({ chatId, description, threadId }, 'REST: Sending card message');
    // REST channel handles message routing internally
  }

  async sendFile(chatId: string, filePath: string, threadId?: string): Promise<void> {
    this.logger.debug({ chatId, filePath, threadId }, 'REST: Sending file');
    // REST channel handles file transfer internally
  }

  async addReaction?(messageId: string, emoji: string): Promise<boolean> {
    this.logger.debug({ messageId, emoji }, 'REST: Adding reaction (not supported)');
    return false;
  }
}

/**
 * REST Platform Adapter.
 *
 * Implements IPlatformAdapter for REST-based communication.
 * This adapter is primarily used for:
 * - HTTP API integrations
 * - Testing and development
 * - External system connections
 *
 * Note: REST adapter does not support file handling natively.
 * File operations should be handled through the REST channel's
 * built-in mechanisms.
 */
export class RestPlatformAdapter implements IPlatformAdapter {
  readonly platformId = 'rest';
  readonly platformName = 'REST API';

  readonly messageSender: IMessageSender;
  // REST adapter does not support file handling
  readonly fileHandler = undefined;

  private logger: Logger;
  private baseUrl: string;

  constructor(config: RestPlatformAdapterConfig) {
    this.logger = config.logger;
    this.baseUrl = config.baseUrl || 'http://localhost:3000';

    // Use custom message sender if provided (for testing)
    // Otherwise create default REST message sender
    this.messageSender = config.messageSender ?? new RestMessageSender(config);
  }

  /**
   * Get the base URL for this adapter.
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }
}
