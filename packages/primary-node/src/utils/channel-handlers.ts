/**
 * Shared Channel Handler Utilities.
 *
 * Issue #1555 Phase 2: Extracted from wired-descriptors.ts to make
 * channel handler creation reusable across all channel types.
 *
 * These utilities encapsulate the common patterns for:
 * - Creating ChatAgentCallbacks from any IChannel instance
 * - Processing incoming messages through the agent pool
 *
 * New channels (WeChat, etc.) should use these utilities instead of
 * duplicating handler registration logic.
 *
 * @module utils/channel-handlers
 */

import {
  type IChannel,
  type IncomingMessage,
  type FileRef,
  type ChannelApiHandlers,
  type FeishuCard,
} from '@disclaude/core';
import type { ChatAgentCallbacks } from '../agents/types.js';
import type { Logger } from 'pino';
import type { WiredContext } from '../channel-lifecycle-manager.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating channel callbacks.
 */
export interface ChannelCallbacksOptions {
  /** Whether to send a 'done' signal on task completion (REST sync mode) */
  sendDoneSignal?: boolean;

  /**
   * Optional callback to retrieve chat history for a given chat.
   * Wired to MessageLogger.getChatHistory() for channels that support message logging.
   * @param chatId - Platform-specific chat identifier
   * @returns Chat history context string or undefined if not available
   *
   * @see Issue #1863 - Wire getChatHistory callback for session restoration
   */
  getChatHistory?: (chatId: string) => Promise<string | undefined>;
}

/**
 * Options for creating a default message handler.
 */
export interface MessageHandlerOptions {
  /** Display name for logging */
  channelName: string;
  /** Whether to send a 'done' signal on error (REST sync mode) */
  sendDoneSignal?: boolean;
  /**
   * Extract file attachments from the message.
   * If provided, attachments are converted to FileRef[] for agent processing.
   */
  extractAttachments?: (message: IncomingMessage) => FileRef[] | undefined;
}

// ============================================================================
// createChannelCallbacksFactory
// ============================================================================

/**
 * Create a ChatAgentCallbacks factory for a channel.
 *
 * Wraps channel.sendMessage() into the ChatAgentCallbacks interface.
 * The returned factory captures the channel via closure.
 *
 * @param channel - The channel instance to send messages through
 * @param logger - Logger instance for warnings
 * @param options - Options for channel-specific behavior
 * @returns A factory function that takes a chatId and returns ChatAgentCallbacks
 *
 * @example
 * ```typescript
 * const callbacksFactory = createChannelCallbacksFactory(channel, logger, {
 *   sendDoneSignal: true,
 * });
 * const callbacks = callbacksFactory('chat-123');
 * await callbacks.sendMessage('chat-123', 'Hello!');
 * ```
 */
export function createChannelCallbacksFactory(
  channel: IChannel,
  logger: Logger,
  options?: ChannelCallbacksOptions
): (chatId: string) => ChatAgentCallbacks {
  return (_chatId: string): ChatAgentCallbacks => ({
    sendMessage: async (chatId: string, text: string, parentMessageId?: string) => {
      await channel.sendMessage({
        chatId,
        type: 'text',
        text,
        threadId: parentMessageId,
      });
    },
    sendCard: async (
      chatId: string,
      card: FeishuCard,
      description?: string,
      parentMessageId?: string
    ) => {
      await channel.sendMessage({
        chatId,
        type: 'card',
        card,
        description,
        threadId: parentMessageId,
      });
    },
    // eslint-disable-next-line require-await
    sendFile: async (chatId: string, filePath: string) => {
      logger.warn({ chatId, filePath }, 'File sending not fully implemented');
    },
    onDone: options?.sendDoneSignal
      ? async (chatId: string, parentMessageId?: string) => {
          logger.info({ chatId }, 'Task completed');
          await channel.sendMessage({
            chatId,
            type: 'done',
            threadId: parentMessageId,
          });
        }
      : // eslint-disable-next-line require-await
        async (chatId: string) => {
          logger.info({ chatId }, 'Task completed');
        },
    // Issue #1863: Wire getChatHistory callback for session restoration
    getChatHistory: options?.getChatHistory,
  });
}

// ============================================================================
// createDefaultMessageHandler
// ============================================================================

/**
 * Create a default message handler using the shared processing pattern.
 *
 * Pattern: extract data → get/create agent → optional attachment conversion → process → error handling
 *
 * @param channel - The channel instance (for error response)
 * @param context - Wired context with agentPool and callbacks factory
 * @param options - Channel-specific options
 * @returns A message handler function for processing incoming messages
 *
 * @example
 * ```typescript
 * const handler = createDefaultMessageHandler(channel, wiredContext, {
 *   channelName: 'Feishu channel',
 *   extractAttachments: (msg) => msg.attachments?.map(convertAttachment),
 * });
 * channel.onMessage(handler);
 * ```
 */
export function createDefaultMessageHandler(
  channel: IChannel,
  context: WiredContext,
  options: MessageHandlerOptions
): (message: IncomingMessage) => Promise<void> {
  return async (message: IncomingMessage) => {
    const { chatId, content, messageId, userId, metadata, messageType } = message;
    context.logger.info(
      { chatId, messageId, messageType, contentLength: content.length, hasAttachments: !!message.attachments },
      `Processing message from ${options.channelName}`
    );

    const callbacks = context.callbacks(chatId);
    const agent = context.agentPool.getOrCreateChatAgent(chatId, callbacks);

    // Extract context
    const senderOpenId = userId;
    const chatHistoryContext = metadata?.chatHistoryContext as string | undefined;

    // Convert attachments if the channel supports them
    const fileRefs = options.extractAttachments?.(message);

    try {
      void agent.processMessage(chatId, content, messageId, senderOpenId, fileRefs, chatHistoryContext);
    } catch (error) {
      context.logger.error({ err: error, chatId, messageId }, 'Failed to process message');
      const errorMsg = error instanceof Error ? error.message : String(error);
      await channel.sendMessage({
        chatId,
        type: 'text',
        text: `❌ Error: ${errorMsg}`,
      });
      if (options.sendDoneSignal) {
        await channel.sendMessage({ chatId, type: 'done' });
      }
    }
  };
}

// ============================================================================
// createChannelApiHandlers
// ============================================================================

/**
 * Options for creating channel API handlers.
 */
export interface ChannelApiHandlersOptions {
  /**
   * Logger instance for warnings.
   */
  logger: Logger;
  /**
   * Channel display name for logging.
   */
  channelName: string;
}

/**
 * Create common ChannelApiHandlers from a channel instance.
 *
 * Extracts the shared IPC handler pattern (sendMessage, sendCard, uploadFile)
 * that was previously duplicated in each channel descriptor's setup() method.
 * Callers can spread the result and add channel-specific handlers
 * (sendInteractive, listTempChats, etc.) on top.
 *
 * This unifies the IPC handler creation with the same `channel.sendMessage()`
 * delegation pattern used by `createChannelCallbacksFactory`.
 *
 * @see createChannelCallbacksFactory — for ChatAgentCallbacks (worker-to-channel),
 *      this function creates ChannelApiHandlers (MCP server-to-channel).
 *
 * @param channel - The channel instance to send messages through
 * @param options - Options for handler creation
 * @returns Partial ChannelApiHandlers with sendMessage, sendCard, uploadFile
 *
 * @example
 * ```typescript
 * const baseHandlers = createChannelApiHandlers(feishuChannel, { logger, channelName: 'Feishu' });
 * const fullHandlers: ChannelApiHandlers = {
 *   ...baseHandlers,
 *   sendInteractive: async (chatId, params) => { ... },
 *   listTempChats: () => { ... },
 * };
 * context.primaryNode.registerFeishuHandlers(fullHandlers);
 * ```
 */
export function createChannelApiHandlers(
  channel: IChannel,
  options: ChannelApiHandlersOptions
): Pick<ChannelApiHandlers, 'sendMessage' | 'sendCard' | 'uploadFile'> {
  const { logger, channelName } = options;

  return {
    sendMessage: async (chatId: string, text: string, threadId?: string, mentions?: Array<{ openId: string; name?: string }>) => {
      try {
        await channel.sendMessage({ chatId, type: 'text', text, threadId, mentions });
      } catch (error) {
        logger.error({ err: error, chatId, channel: channelName, handler: 'sendMessage' }, 'IPC handler failed');
        throw error;
      }
    },

    sendCard: async (
      chatId: string,
      card: FeishuCard,
      threadId?: string,
      description?: string
    ) => {
      try {
        await channel.sendMessage({ chatId, type: 'card', card, threadId, description });
      } catch (error) {
        logger.error({ err: error, chatId, channel: channelName, handler: 'sendCard' }, 'IPC handler failed');
        throw error;
      }
    },

    uploadFile: async (chatId: string, filePath: string, threadId?: string) => {
      logger.debug(
        { chatId, filePath, channel: channelName },
        'uploadFile: using channel.sendMessage — file metadata may be incomplete'
      );
      try {
        await channel.sendMessage({ chatId, type: 'file', filePath, threadId });
      } catch (error) {
        logger.error({ err: error, chatId, channel: channelName, handler: 'uploadFile' }, 'IPC handler failed');
        throw error;
      }
      // NOTE: fileKey and fileSize are synthetic placeholders.
      // channel.sendMessage() does not return real file metadata.
      // Callers should not rely on these fields for business logic.
      return {
        fileKey: '',    // synthetic — not available via sendMessage
        fileType: 'file',
        fileName: filePath.split('/').pop() || 'file',
        fileSize: 0,    // synthetic — not available via sendMessage
      };
    },
  };
}
