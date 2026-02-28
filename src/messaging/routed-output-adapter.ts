/**
 * Routed output adapter for level-based message routing.
 *
 * This adapter wraps a MessageRouter to provide OutputAdapter interface.
 * It maps AgentMessageType to MessageLevel and routes messages accordingly.
 *
 * @see Issue #266
 */

import type { AgentMessageType } from '../types/agent.js';
import type { OutputAdapter, MessageMetadata } from '../utils/output-adapter.js';
import { mapAgentMessageTypeToLevel, type IMessageRouter, type RoutedMessageMetadata } from './types.js';

/**
 * Options for RoutedOutputAdapter.
 */
export interface RoutedOutputAdapterOptions {
  /** Message router instance */
  router: IMessageRouter;
  /** Default chat ID for messages (used when router has no admin configured) */
  defaultChatId?: string;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Output adapter that routes messages based on their level.
 *
 * Features:
 * - Maps AgentMessageType to MessageLevel
 * - Routes to admin/user chats via MessageRouter
 * - Throttles progress messages
 * - Tracks if user-visible messages were sent
 */
export class RoutedOutputAdapter implements OutputAdapter {
  private readonly router: IMessageRouter;
  // Reserved for future use when router has no admin configured
  private readonly defaultChatId?: string;
  // Reserved for debug logging
  private readonly debug: boolean;

  // Throttle state for progress messages
  private progressThrottleMap = new Map<string, number>();
  private readonly throttleIntervalMs = 2000;

  // Track if user-visible message was sent
  private userMessageSent = false;

  constructor(options: RoutedOutputAdapterOptions) {
    this.router = options.router;
    this.defaultChatId = options.defaultChatId;
    this.debug = options.debug ?? false;
  }

  /** Get the default chat ID (reserved for future use) */
  getDefaultChatId(): string | undefined {
    return this.defaultChatId;
  }

  /** Check if debug mode is enabled */
  isDebugEnabled(): boolean {
    return this.debug;
  }

  /**
   * Write content with message type routing.
   */
  async write(
    content: string,
    messageType: AgentMessageType = 'text',
    metadata?: MessageMetadata
  ): Promise<void> {
    // Skip empty content
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      return;
    }

    // Map message type to level
    const level = mapAgentMessageTypeToLevel(messageType, content);

    // Throttle progress messages
    if (messageType === 'tool_progress') {
      const toolName = metadata?.toolName ?? 'unknown';
      if (!this.shouldSendProgress(toolName)) {
        return;
      }
    }

    // Build routed message
    const routedMessage = {
      content: trimmedContent,
      level,
      metadata: this.buildMetadata(metadata, messageType),
    };

    // Track if user will see this message
    if (this.router.getTargets(level).includes(this.router.getUserChatId())) {
      this.userMessageSent = true;
    }

    // Route the message
    await this.router.route(routedMessage);
  }

  /**
   * Check if any user-visible message was sent.
   */
  hasSentUserMessage(): boolean {
    return this.userMessageSent;
  }

  /**
   * Reset tracking for a new task.
   */
  resetTracking(): void {
    this.userMessageSent = false;
    this.progressThrottleMap.clear();
  }

  /**
   * Build routed message metadata.
   */
  private buildMetadata(
    metadata?: MessageMetadata,
    messageType?: AgentMessageType
  ): RoutedMessageMetadata | undefined {
    if (!metadata && !messageType) {
      return undefined;
    }

    return {
      toolName: metadata?.toolName,
      originalType: messageType,
    };
  }

  /**
   * Check if a progress message should be sent (throttling).
   */
  private shouldSendProgress(toolName: string): boolean {
    const key = `progress:${toolName}`;
    const now = Date.now();
    const lastSent = this.progressThrottleMap.get(key);

    if (lastSent === undefined || now - lastSent >= this.throttleIntervalMs) {
      this.progressThrottleMap.set(key, now);
      return true;
    }

    return false;
  }
}

/**
 * Create a simple output adapter that only sends to user chat.
 * This is for backward compatibility when no admin chat is configured.
 */
export class SimpleUserOutputAdapter implements OutputAdapter {
  private readonly sendText: (chatId: string, text: string) => Promise<void>;
  private readonly chatId: string;

  constructor(
    sendText: (chatId: string, text: string) => Promise<void>,
    chatId: string
  ) {
    this.sendText = sendText;
    this.chatId = chatId;
  }

  async write(content: string, _messageType?: AgentMessageType): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) {
      return;
    }
    await this.sendText(this.chatId, trimmed);
  }
}
