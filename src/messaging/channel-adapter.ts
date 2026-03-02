/**
 * Channel Adapter Interface - Platform-specific message conversion.
 *
 * A Channel Adapter is responsible for:
 * 1. Converting UniversalMessage to platform-specific format
 * 2. Sending the converted message to the platform
 * 3. Declaring platform capabilities
 *
 * @see Issue #480
 */

import type {
  UniversalMessage,
  MessageContent,
  ChannelCapabilities,
} from './universal-message.js';

/**
 * Result of a send operation.
 */
export interface SendResult {
  /** Whether the send was successful */
  success: boolean;
  /** Platform-specific message ID (for updates/replies) */
  messageId?: string;
  /** Error message if failed */
  error?: string;
  /** Platform-specific response data */
  data?: Record<string, unknown>;
}

/**
 * Channel Adapter interface.
 *
 * All platform adapters must implement this interface.
 * The MessageService uses this interface to route messages to different platforms.
 */
export interface IChannelAdapter {
  /**
   * Unique adapter identifier.
   * Used for routing and logging.
   */
  readonly id: string;

  /**
   * Human-readable adapter name.
   */
  readonly name: string;

  /**
   * Channel capabilities.
   * Used for capability negotiation.
   */
  readonly capabilities: ChannelCapabilities;

  /**
   * Check if this adapter can handle the given chatId.
   * Used by MessageService to route messages.
   *
   * @param chatId - Chat ID to check
   * @returns true if this adapter handles the chatId
   */
  canHandle(chatId: string): boolean;

  /**
   * Convert universal message to platform-specific format.
   *
   * @param message - Universal message to convert
   * @returns Platform-specific message object
   */
  convert(message: UniversalMessage): unknown;

  /**
   * Send a universal message through this channel.
   *
   * @param message - Universal message to send
   * @returns Send result with success status and message ID
   */
  send(message: UniversalMessage): Promise<SendResult>;

  /**
   * Update an existing message (if supported).
   *
   * @param messageId - Message ID to update
   * @param content - New content
   * @returns Send result
   */
  update?(messageId: string, content: MessageContent): Promise<SendResult>;
}

/**
 * Base class for channel adapters.
 * Provides common utilities and default implementations.
 */
export abstract class BaseChannelAdapter implements IChannelAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly capabilities: ChannelCapabilities;

  /**
   * Default implementation: Override in subclass.
   */
  abstract canHandle(chatId: string): boolean;

  /**
   * Default implementation: Override in subclass.
   */
  abstract convert(message: UniversalMessage): unknown;

  /**
   * Default implementation: Override in subclass.
   */
  abstract send(message: UniversalMessage): Promise<SendResult>;

  /**
   * Default implementation: Not supported.
   */
  async update?(_messageId: string, _content: MessageContent): Promise<SendResult> {
    return {
      success: false,
      error: 'Message update not supported by this adapter',
    };
  }

  /**
   * Check if a content type is supported by this adapter.
   */
  protected isContentTypeSupported(contentType: string): boolean {
    return this.capabilities.supportedContentTypes.includes(
      contentType as MessageContent['type']
    );
  }

  /**
   * Create an error result.
   */
  protected errorResult(error: string, data?: Record<string, unknown>): SendResult {
    return { success: false, error, data };
  }

  /**
   * Create a success result.
   */
  protected successResult(messageId?: string, data?: Record<string, unknown>): SendResult {
    return { success: true, messageId, data };
  }
}

/**
 * Channel adapter factory function type.
 */
export type ChannelAdapterFactory = () => IChannelAdapter;
