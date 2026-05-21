/**
 * Input MessageRouter — routes incoming Messages to AgentPool by chatId.
 *
 * This is the unified input routing layer for all messages entering the system.
 * Both UserMessage (from chat channels) and SystemMessage (from scheduler/webhook/IPC)
 * are routed through this single router to the appropriate ChatAgent.
 *
 * Design: Fully decoupled from Project system. Routes by chatId only.
 *
 * Issue #3580: Message types (UserMessage + SystemMessage) and MessageRouter
 * Part of RFC #3329: Message — Unified Agent Input Abstraction (Phase 1)
 */

import { createLogger, type Logger } from '../utils/logger.js';
import { isUserMessage, isSystemMessage, type Message, type UserMessage, type SystemMessage } from '../types/message.js';
import type { FileRef } from '../types/file.js';

const defaultLogger = createLogger('InputMessageRouter');

// ============================================================================
// Agent Handler Interface
// ============================================================================

/**
 * Interface for handling routed messages.
 *
 * Decouples the router from concrete AgentPool implementation.
 * The handler is responsible for getting/creating agents and
 * delivering messages to them.
 */
export interface IAgentMessageHandler {
  /**
   * Handle a user message by getting/creating an agent and delivering it.
   *
   * @param chatId - Target chat ID
   * @param payload - Message text
   * @param messageId - Unique message identifier
   * @param senderOpenId - Optional sender open_id
   * @param attachments - Optional file attachments
   * @param chatHistoryContext - Optional chat history context
   */
  handleUserMessage(
    chatId: string,
    payload: string,
    messageId: string,
    senderOpenId?: string,
    attachments?: FileRef[],
    chatHistoryContext?: string,
    chatType?: string,
    threadContext?: string
  ): Promise<void>;

  /**
   * Handle a system message by getting/creating an agent and delivering it.
   *
   * @param chatId - Target chat ID
   * @param payload - Message text
   * @param messageId - Unique message identifier
   */
  handleSystemMessage(
    chatId: string,
    payload: string,
    messageId: string
  ): Promise<void>;
}

// ============================================================================
// Routing Error
// ============================================================================

/**
 * Error thrown when message routing fails.
 */
export class MessageRoutingError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'MessageRoutingError';
  }
}

// ============================================================================
// MessageRouter
// ============================================================================

/**
 * Configuration for MessageRouter.
 */
export interface MessageRouterConfig {
  /** Handler for delivering messages to agents */
  handler: IAgentMessageHandler;
  /** Optional logger */
  logger?: Logger;
}

/**
 * Input MessageRouter — routes incoming Messages to agents by chatId.
 *
 * All messages carry chatId. The router extracts it and delegates to
 * the IAgentMessageHandler which manages agent lifecycle and delivery.
 *
 * @example
 * ```typescript
 * const router = new MessageRouter({
 *   handler: {
 *     handleUserMessage(chatId, payload, messageId, senderOpenId, attachments, ctx) {
 *       const agent = agentPool.getOrCreateChatAgent(chatId);
 *       agent.processMessage(chatId, payload, messageId, senderOpenId, attachments, ctx);
 *     },
 *     handleSystemMessage(chatId, payload, messageId) {
 *       const agent = agentPool.getOrCreateChatAgent(chatId);
 *       agent.processMessage(chatId, payload, messageId);
 *     },
 *   },
 * });
 *
 * // Route a user message
 * await router.route({
 *   id: 'msg-1',
 *   source: 'user',
 *   payload: 'Hello!',
 *   chatId: 'oc_xxx',
 *   messageId: 'feishu-msg-id',
 *   createdAt: new Date().toISOString(),
 * });
 * ```
 */
export class MessageRouter {
  private readonly handler: IAgentMessageHandler;
  private readonly log: Logger;

  constructor(config: MessageRouterConfig) {
    this.handler = config.handler;
    this.log = config.logger ?? defaultLogger;
  }

  /**
   * Route a message to the appropriate agent by chatId.
   *
   * Extracts chatId from the message and delegates to the handler.
   * Throws MessageRoutingError if chatId is missing or source is unknown.
   *
   * @param message - The message to route
   */
  async route(message: Message): Promise<void> {
    // Validate chatId
    if (!message.chatId) {
      throw new MessageRoutingError('Message missing chatId — cannot route');
    }

    this.log.debug(
      { chatId: message.chatId, source: message.source, messageId: message.id },
      'Routing message'
    );

    try {
      if (isUserMessage(message)) {
        await this.routeUserMessage(message);
      } else if (isSystemMessage(message)) {
        await this.routeSystemMessage(message);
      } else {
        throw new MessageRoutingError(
          `Unknown message source: ${(message as Message).source}`
        );
      }
    } catch (err) {
      if (err instanceof MessageRoutingError) {
        throw err;
      }
      throw new MessageRoutingError(
        `Failed to route message ${message.id} to chatId ${message.chatId}`,
        err
      );
    }
  }

  private async routeUserMessage(message: UserMessage): Promise<void> {
    await this.handler.handleUserMessage(
      message.chatId,
      message.payload,
      message.messageId,
      message.senderOpenId,
      message.attachments,
      message.chatHistoryContext,
      message.chatType,
      message.threadContext
    );
  }

  private async routeSystemMessage(message: SystemMessage): Promise<void> {
    await this.handler.handleSystemMessage(
      message.chatId,
      message.payload,
      message.id
    );
  }
}
