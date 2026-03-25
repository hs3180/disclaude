/**
 * Wired Channel Descriptors - Channel-specific wiring for REST and Feishu.
 *
 * Issue #1594 Phase 2: Each descriptor encapsulates the full wiring lifecycle
 * for its channel type, including PilotCallbacks creation, message handling,
 * and post-registration setup (passive mode, IPC handlers).
 *
 * These descriptors replace the ~220 lines of channel-specific code in cli.ts.
 *
 * @module channels/wired-descriptors
 */

import {
  createInboundAttachment,
  type IChannel,
  type IncomingMessage,
  type FileRef,
  type FeishuApiHandlers,
} from '@disclaude/core';
import type { PilotCallbacks } from '@disclaude/worker-node';
import type { Logger } from 'pino';
import { RestChannel, type RestChannelConfig } from './rest-channel.js';
import { FeishuChannel, type FeishuChannelConfig } from './feishu-channel.js';
import type {
  ChannelSetupContext,
  WiredContext,
  WiredChannelDescriptor,
} from '../channel-lifecycle-manager.js';
import {
  buildInteractiveCard,
  buildActionPrompts,
  validateInteractiveParams,
} from '../platforms/feishu/card-builders/index.js';

// ============================================================================
// Shared Helpers
// ============================================================================

/**
 * Create a PilotCallbacks factory for a channel.
 *
 * Wraps channel.sendMessage() into the PilotCallbacks interface.
 * The returned factory captures the channel via closure.
 *
 * @param channel - The channel instance to send messages through
 * @param logger - Logger instance for warnings
 * @param options - Options for channel-specific behavior
 */
function createChannelCallbacksFactory(
  channel: IChannel,
  logger: Logger,
  options?: { sendDoneSignal?: boolean }
): (chatId: string) => PilotCallbacks {
  return (_chatId: string): PilotCallbacks => ({
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
  });
}

/**
 * Options for creating a default message handler.
 */
interface MessageHandlerOptions {
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

/**
 * Create a default message handler using the shared processing pattern.
 *
 * Pattern: extract data → get/create agent → optional attachment conversion → process → error handling
 *
 * @param channel - The channel instance (for error response)
 * @param context - Wired context with agentPool and callbacks factory
 * @param options - Channel-specific options
 */
function createDefaultMessageHandler(
  channel: IChannel,
  context: WiredContext,
  options: MessageHandlerOptions
): (message: IncomingMessage) => Promise<void> {
  return async (message: IncomingMessage) => {
    const { chatId, content, messageId, userId, metadata } = message;
    context.logger.info(
      { chatId, messageId, contentLength: content.length, hasAttachments: !!message.attachments },
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
      agent.processMessage(chatId, content, messageId, senderOpenId, fileRefs, chatHistoryContext);
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
// REST Wired Descriptor
// ============================================================================

/**
 * REST Channel wired descriptor.
 *
 * Provides full wiring for the REST channel:
 * - PilotCallbacks with done signal (sync mode)
 * - Message handler with basic text processing
 * - No post-registration setup needed
 */
export const REST_WIRED_DESCRIPTOR: WiredChannelDescriptor<RestChannelConfig> = {
  type: 'rest',
  name: 'REST API',
  factory: (config) => new RestChannel(config),
  defaultCapabilities: {
    supportsCard: true,
    supportsThread: false,
    supportsFile: false,
    supportsMarkdown: true,
    supportsMention: false,
    supportsUpdate: false,
  },

  createCallbacks: (channel, context) =>
    createChannelCallbacksFactory(channel, context.logger, { sendDoneSignal: true }),

  createMessageHandler: (channel, context) =>
    createDefaultMessageHandler(channel, context, {
      channelName: 'REST channel',
      sendDoneSignal: true,
    }),
};

// ============================================================================
// Feishu Wired Descriptor
// ============================================================================

/**
 * Feishu Channel wired descriptor.
 *
 * Provides full wiring for the Feishu channel:
 * - PilotCallbacks without done signal (async mode)
 * - Message handler with attachment conversion
 * - Post-registration setup: action prompt resolver, passive mode, IPC handlers
 */
export const FEISHU_WIRED_DESCRIPTOR: WiredChannelDescriptor<FeishuChannelConfig> = {
  type: 'feishu',
  name: 'Feishu',
  factory: (config) => new FeishuChannel(config),
  defaultCapabilities: {
    supportsCard: true,
    supportsThread: true,
    supportsFile: true,
    supportsMarkdown: true,
    supportsMention: true,
    supportsUpdate: true,
  },

  createCallbacks: (channel, context) =>
    createChannelCallbacksFactory(channel, context.logger, { sendDoneSignal: false }),

  createMessageHandler: (channel, context) =>
    createDefaultMessageHandler(channel, context, {
      channelName: 'Feishu channel',
      sendDoneSignal: false,
      extractAttachments: (message: IncomingMessage): FileRef[] | undefined => {
        const { attachments, chatId, messageType } = message;
        return attachments?.map((att) =>
          createInboundAttachment(
            att.fileName,
            chatId,
            messageType as 'image' | 'file' | 'media',
            {
              localPath: att.filePath,
              mimeType: att.mimeType,
              size: att.size,
              messageId: message.messageId,
            }
          )
        );
      },
    }),

  /**
   * Post-registration setup for Feishu channel.
   *
   * 1. Set up action prompt resolver (Issue #1572)
   * 2. Configure passive mode adapter (Issue #1464)
   * 3. Register IPC handlers (Issue #1042, #1571)
   */
  setup: (channel: IChannel, config: FeishuChannelConfig, context: ChannelSetupContext) => {
    const feishuChannel = channel as FeishuChannel;

    // 1. Set up action prompt resolver using InteractiveContextStore
    const contextStore = context.primaryNode.getInteractiveContextStore();
    config.resolveActionPrompt = (
      messageId: string,
      chatId: string,
      actionValue: string,
      actionText?: string
    ) => contextStore.generatePrompt(messageId, chatId, actionValue, actionText);

    // 2. Set up passive mode adapter
    // Adapter layer: ControlHandlerContext uses isEnabled/setEnabled semantics,
    // while FeishuChannel exposes isPassiveModeDisabled/setPassiveModeDisabled.
    context.controlHandlerContext.passiveMode = {
      isEnabled: (chatId: string) => !feishuChannel.isPassiveModeDisabled(chatId),
      setEnabled: (chatId: string, enabled: boolean) =>
        feishuChannel.setPassiveModeDisabled(chatId, !enabled),
    };

    // 3. Register IPC handlers for MCP Server connections
    const feishuHandlers: FeishuApiHandlers = {
      sendMessage: async (chatId: string, text: string, threadId?: string) => {
        await feishuChannel.sendMessage({ chatId, type: 'text', text, threadId });
      },
      sendCard: async (
        chatId: string,
        card: Record<string, unknown>,
        threadId?: string,
        description?: string
      ) => {
        await feishuChannel.sendMessage({ chatId, type: 'card', card, threadId, description });
      },
      uploadFile: async (chatId: string, filePath: string, threadId?: string) => {
        await feishuChannel.sendMessage({ chatId, type: 'file', filePath, threadId });
        return {
          fileKey: '',
          fileType: 'file',
          fileName: filePath.split('/').pop() || 'file',
          fileSize: 0,
        };
      },
      // Issue #1571: Build interactive card from raw parameters using extracted builder
      sendInteractive: async (chatId: string, params: {
        question: string;
        options: Array<{ text: string; value: string; type?: 'primary' | 'default' | 'danger' }>;
        title?: string;
        context?: string;
        threadId?: string;
        actionPrompts?: Record<string, string>;
      }) => {
        const { question, options, title, context: cardContext, threadId, actionPrompts } = params;

        // Validate params at IPC boundary
        const validationError = validateInteractiveParams(params);
        if (validationError) {
          context.logger.warn({ chatId, error: validationError }, 'sendInteractive: invalid params');
          throw new Error(`Invalid interactive params: ${validationError}`);
        }

        // Build card using extracted builder (Primary Node owns the full card lifecycle)
        const card = buildInteractiveCard({ question, options, title, context: cardContext });

        await feishuChannel.sendMessage({ chatId, type: 'card', card, threadId });

        // Build action prompts: use caller-provided prompts or generate defaults
        const resolvedActionPrompts = actionPrompts && Object.keys(actionPrompts).length > 0
          ? actionPrompts
          : buildActionPrompts(options);

        // Issue #1570: Return synthetic messageId for action prompt registration
        const syntheticMessageId = `interactive_${chatId}_${Date.now()}`;

        return { messageId: syntheticMessageId, actionPrompts: resolvedActionPrompts };
      },
    };

    context.primaryNode.registerFeishuHandlers(feishuHandlers);
    context.logger.info('Feishu IPC handlers registered via descriptor setup');
  },
};
