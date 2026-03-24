/**
 * Unified Channel Handler Factory.
 *
 * Provides capability-aware utilities for creating PilotCallbacks and
 * message handlers that work with any IChannel implementation.
 *
 * Instead of each channel (REST, Feishu, WeChat) having its own duplicated
 * callback creation and message handler logic in cli.ts, these utilities
 * use `IChannel.getCapabilities()` to determine the correct behavior:
 *
 * - `supportsCard` → enable/disable sendCard forwarding
 * - `supportsFile` → enable/disable sendFile forwarding + attachment conversion
 * - `supportsThread` → pass threadId to outgoing messages
 *
 * @module handlers/channel-handler-factory
 * @see Issue #1555 - Unified Channel Handler Injection (Phase 2)
 */

import {
  createLogger,
  type IChannel,
  type IncomingMessage,
  type FileRef,
  type ControlHandler,
  createInboundAttachment,
} from '@disclaude/core';
import type { PilotCallbacks, ChatAgent } from '@disclaude/worker-node';

const logger = createLogger('ChannelHandlerFactory');

/**
 * Interface for agent pool operations used by the channel handler factory.
 *
 * This is a minimal interface that the handler factory needs from the agent pool,
 * allowing both the real PrimaryAgentPool and test mocks to satisfy it.
 */
export interface IAgentPool {
  getOrCreateChatAgent(chatId: string, callbacks: PilotCallbacks): ChatAgent;
}

/**
 * Options for creating channel callbacks and message handlers.
 */
export interface ChannelHandlerOptions {
  /**
   * Whether to send a 'done' type message when the agent completes.
   * Used by REST channel for sync mode signaling.
   *
   * When true:
   * - `onDone` callback sends a 'done' type message to the channel
   * - Error handler also sends a 'done' signal after the error message
   *
   * When false:
   * - `onDone` callback only logs completion
   * - Error handler only sends the error text message
   *
   * Default: false
   */
  sendDoneSignal?: boolean;
}

/**
 * Create PilotCallbacks for any IChannel.
 *
 * Generates a PilotCallbacks object that adapts to the channel's capabilities:
 * - `sendMessage`: Always forwards text messages to the channel
 * - `sendCard`: Forwards if channel supports cards, otherwise logs a warning
 * - `sendFile`: Forwards if channel supports files, otherwise logs a warning
 * - `onDone`: Logs completion; optionally sends a 'done' signal
 *
 * @param channel - The channel to create callbacks for
 * @param options - Optional configuration for behavior customization
 * @returns PilotCallbacks bound to the given channel
 */
export function createChannelCallbacks(
  channel: IChannel,
  options: ChannelHandlerOptions = {}
): PilotCallbacks {
  const capabilities = channel.getCapabilities();
  const { sendDoneSignal = false } = options;

  return {
    sendMessage: async (chatId: string, text: string, parentMessageId?: string) => {
      await channel.sendMessage({
        chatId,
        type: 'text',
        text,
        threadId: parentMessageId,
      });
    },

    sendCard: capabilities.supportsCard
      ? async (chatId: string, card: Record<string, unknown>, description?: string, parentMessageId?: string) => {
          await channel.sendMessage({
            chatId,
            type: 'card',
            card,
            description,
            threadId: parentMessageId,
          });
        }
      : async (_chatId: string, _card: Record<string, unknown>) => {
          logger.warn({ channelId: channel.id }, 'Card messages not supported by this channel');
        },

    sendFile: capabilities.supportsFile
      ? async (chatId: string, filePath: string) => {
          await channel.sendMessage({
            chatId,
            type: 'file',
            filePath,
          });
        }
      : async (chatId: string, filePath: string) => {
          logger.warn({ chatId, filePath, channelId: channel.id }, 'File sending not supported by this channel');
        },

    onDone: sendDoneSignal
      ? async (chatId: string, parentMessageId?: string) => {
          logger.info({ chatId }, 'Task completed');
          await channel.sendMessage({
            chatId,
            type: 'done',
            threadId: parentMessageId,
          });
        }
      : async (chatId: string) => {
          logger.info({ chatId }, 'Task completed');
        },
  };
}

/**
 * Create a unified message handler for any IChannel.
 *
 * The handler follows a consistent flow for all channels:
 * 1. Extracts message data (chatId, content, messageId, userId, metadata, attachments)
 * 2. Logs the incoming message
 * 3. Gets or creates a ChatAgent from the pool
 * 4. Converts attachments to FileRef[] if channel supports files and message has attachments
 * 5. Processes the message through the agent
 * 6. Handles errors with channel-appropriate error messages
 *
 * @param channel - The channel to create the handler for
 * @param agentPool - The agent pool for getting/creating ChatAgent instances
 * @param options - Optional configuration for behavior customization
 * @returns Message handler function suitable for `channel.onMessage()`
 */
export function createMessageHandler(
  channel: IChannel,
  agentPool: IAgentPool,
  options: ChannelHandlerOptions = {}
): (message: IncomingMessage) => Promise<void> {
  const capabilities = channel.getCapabilities();
  const callbacks = createChannelCallbacks(channel, {
    sendDoneSignal: options.sendDoneSignal ?? false,
  });
  const sendDoneSignal = options.sendDoneSignal ?? false;

  return async (message: IncomingMessage): Promise<void> => {
    const { chatId, content, messageId, userId, metadata, attachments } = message;

    logger.info(
      { chatId, messageId, contentLength: content.length, hasAttachments: !!attachments, channelId: channel.id },
      `Processing message from ${channel.name} channel`
    );

    const agent = agentPool.getOrCreateChatAgent(chatId, callbacks);

    // Extract context
    const senderOpenId = userId;
    const chatHistoryContext = metadata?.chatHistoryContext as string | undefined;

    // Convert attachments to FileRef[] if channel supports files and message has attachments
    const fileRefs: FileRef[] | undefined =
      capabilities.supportsFile && attachments && attachments.length > 0
        ? attachments.map((att) =>
            createInboundAttachment(att.fileName, chatId, message.messageType as 'image' | 'file' | 'media', {
              localPath: att.filePath,
              mimeType: att.mimeType,
              size: att.size,
              messageId: message.messageId,
            })
          )
        : undefined;

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

      // Send 'done' signal for sync mode channels (e.g., REST)
      if (sendDoneSignal) {
        await channel.sendMessage({
          chatId,
          type: 'done',
        });
      }
    }
  };
}

/**
 * Set up all handlers for a channel (message + control).
 *
 * Convenience function that wires up both the unified message handler
 * and the shared control handler for a channel.
 *
 * @param channel - The channel to set up handlers for
 * @param agentPool - The agent pool for getting/creating ChatAgent instances
 * @param controlHandler - The shared control handler for commands
 * @param options - Optional configuration for both callbacks and message handler
 */
export function setupChannelHandlers(
  channel: IChannel,
  agentPool: IAgentPool,
  controlHandler: ControlHandler,
  options: ChannelHandlerOptions = {}
): void {
  const messageHandler = createMessageHandler(channel, agentPool, options);
  channel.onMessage(messageHandler);
  channel.onControl(controlHandler);
  logger.debug({ channelId: channel.id }, 'Channel handlers set up');
}
