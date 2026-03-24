/**
 * Unified channel handler utilities.
 *
 * Issue #1555: Extract and unify the duplicated PilotCallbacks / MessageHandler
 * creation logic from cli.ts into shared utilities. This reduces channel setup
 * from ~160 lines per channel to a single factory call.
 *
 * @module utils/channel-handlers
 */

import {
  createLogger,
  type IChannel,
  type IncomingMessage,
  type FileRef,
  type MessageHandler,
  createInboundAttachment,
} from '@disclaude/core';
import type { PilotCallbacks } from '@disclaude/worker-node';
import type { PrimaryAgentPool } from '../primary-agent-pool.js';

const logger = createLogger('ChannelHandlers');

/**
 * Options for createChannelCallbacks.
 */
export interface ChannelCallbacksOptions {
  /**
   * Whether to include onDone callback that sends a 'done' message.
   * Set to true for sync-mode channels (e.g., REST) that need completion signaling.
   * Defaults to false.
   */
  enableDoneSignal?: boolean;
}

/**
 * Create a PilotCallbacks factory for the given channel.
 *
 * Returns a function that produces PilotCallbacks instances. Each call creates
 * a fresh callbacks object that delegates all operations to the channel's
 * sendMessage method.
 *
 * @param channel - The channel to create callbacks for
 * @param options - Callback behavior options
 * @returns A factory function that produces PilotCallbacks
 *
 * @example
 * ```typescript
 * const callbacksFactory = createChannelCallbacks(restChannel, { enableDoneSignal: true });
 * const callbacks = callbacksFactory();
 * await callbacks.sendMessage('chat-1', 'Hello');
 * ```
 */
export function createChannelCallbacks(
  channel: IChannel,
  options?: ChannelCallbacksOptions,
): () => PilotCallbacks {
  return () => ({
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
      card: Record<string, unknown>,
      description?: string,
      parentMessageId?: string,
    ) => {
      await channel.sendMessage({
        chatId,
        type: 'card',
        card,
        description,
        threadId: parentMessageId,
      });
    },
    sendFile: async (chatId: string, filePath: string) => {
      logger.warn({ chatId, filePath }, 'File sending not fully implemented for this channel');
    },
    ...(options?.enableDoneSignal
      ? {
          onDone: async (chatId: string, parentMessageId?: string) => {
            logger.info({ chatId }, 'Task completed');
            await channel.sendMessage({
              chatId,
              type: 'done',
              threadId: parentMessageId,
            });
          },
        }
      : {}),
  });
}

/**
 * Options for createChannelMessageHandler.
 */
export interface ChannelMessageHandlerOptions {
  /**
   * Send 'done' signal after errors (for sync-mode channels like REST).
   * When true, a 'done' type message is sent after an error message.
   * Defaults to false.
   */
  sendDoneOnError?: boolean;
}

/**
 * Create a unified message handler for the given channel.
 *
 * Consolidates message processing logic (agent pool lookup, file ref conversion,
 * error handling) into a single function. Both REST and Feishu channels share
 * the same processing pattern; differences are parameterized by options.
 *
 * @param channel - The channel this handler processes messages for
 * @param agentPool - The agent pool to get/create chat agents from
 * @param options - Handler behavior options
 * @returns A MessageHandler suitable for ChannelManager.setupHandlers()
 *
 * @example
 * ```typescript
 * const handler = createChannelMessageHandler(restChannel, agentPool, {
 *   sendDoneOnError: true,
 * });
 * channelManager.setupHandlers(restChannel, handler, controlHandler);
 * ```
 */
export function createChannelMessageHandler(
  channel: IChannel,
  agentPool: PrimaryAgentPool,
  options?: ChannelMessageHandlerOptions,
): MessageHandler {
  return async (message: IncomingMessage): Promise<void> => {
    const { chatId, content, messageId, userId, metadata, attachments } = message;
    logger.info(
      { chatId, messageId, contentLength: content.length, hasAttachments: !!attachments },
      `Processing message from ${channel.name}`,
    );

    const callbacks = createChannelCallbacks(channel, {
      enableDoneSignal: options?.sendDoneOnError,
    })();
    const agent = agentPool.getOrCreateChatAgent(chatId, callbacks);

    // Extract context
    const senderOpenId = userId;
    const chatHistoryContext = metadata?.chatHistoryContext as string | undefined;

    // Convert MessageAttachment[] to FileRef[] for agent processing.
    // Works for all channels: if no attachments, fileRefs is undefined.
    const fileRefs: FileRef[] | undefined = attachments?.map((att) =>
      createInboundAttachment(
        att.fileName,
        chatId,
        message.messageType as 'image' | 'file' | 'media',
        {
          localPath: att.filePath,
          mimeType: att.mimeType,
          size: att.size,
          messageId: message.messageId,
        },
      ),
    );

    try {
      agent.processMessage(chatId, content, messageId, senderOpenId, fileRefs, chatHistoryContext);
    } catch (error) {
      logger.error({ err: error, chatId, messageId }, 'Failed to process message');
      const errorMsg = error instanceof Error ? error.message : String(error);
      await channel.sendMessage({
        chatId,
        type: 'text',
        text: `❌ Error: ${errorMsg}`,
      });
      if (options?.sendDoneOnError) {
        await channel.sendMessage({ chatId, type: 'done' });
      }
    }
  };
}
