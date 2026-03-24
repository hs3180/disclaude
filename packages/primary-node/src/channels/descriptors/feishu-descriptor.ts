/**
 * Feishu Channel Descriptor
 *
 * Declarative wiring for Feishu channel: factory, callbacks, message handler,
 * attachment extraction, passive mode setup, and IPC handler registration.
 *
 * Part of Issue #1594: Unify fragmented channel management architecture.
 *
 * @module @disclaude/primary-node/channels/descriptors/feishu
 */

import {
  createLogger,
  type IChannel,
  type IncomingMessage,
  type FileRef,
  type FeishuApiHandlers,
  createInboundAttachment,
} from '@disclaude/core';
import type { PilotCallbacks } from '@disclaude/worker-node';
import { FeishuChannel, type FeishuChannelConfig } from '../feishu-channel.js';
import {
  buildInteractiveCard,
  buildActionPrompts,
  validateInteractiveParams,
} from '../../platforms/feishu/card-builders/index.js';
import type { ChannelDescriptor, ChannelSetupContext, PilotCallbacksFactory } from '../../channel-descriptor.js';

const logger = createLogger('FeishuDescriptor');

/**
 * Create PilotCallbacks factory for Feishu channel.
 *
 * Feishu channel uses asynchronous mode: does NOT send 'done' signal.
 * The PilotCallbacks check channel initialization on each call.
 */
function createFeishuCallbacksFactory(channel: IChannel): PilotCallbacksFactory {
  return (): PilotCallbacks => ({
    sendMessage: async (chatId: string, text: string, parentMessageId?: string) => {
      if (!channel) { throw new Error('Feishu channel not initialized'); }
      await channel.sendMessage({
        chatId,
        type: 'text',
        text,
        threadId: parentMessageId,
      });
    },
    sendCard: async (chatId: string, card: Record<string, unknown>, description?: string, parentMessageId?: string) => {
      if (!channel) { throw new Error('Feishu channel not initialized'); }
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
    // eslint-disable-next-line require-await
    onDone: async (chatId: string, _parentMessageId?: string) => {
      logger.info({ chatId }, 'Task completed');
    },
  });
}

/**
 * Extract file attachments from Feishu messages.
 * Converts MessageAttachment[] to FileRef[] for agent processing.
 */
function extractFeishuAttachments(message: IncomingMessage): FileRef[] | undefined {
  const { chatId, attachments, messageType, messageId } = message;
  return attachments?.map((att) =>
    createInboundAttachment(att.fileName, chatId, messageType as 'image' | 'file' | 'media', {
      localPath: att.filePath,
      mimeType: att.mimeType,
      size: att.size,
      messageId,
    })
  );
}

/**
 * Create Feishu IPC handlers for MCP Server integration.
 *
 * These handlers are registered with PrimaryNode to enable MCP Server tools
 * to send messages via IPC (Issue #1042).
 */
function createFeishuIpcHandlers(channel: IChannel): FeishuApiHandlers {
  return {
    sendMessage: async (chatId: string, text: string, threadId?: string) => {
      await channel.sendMessage({
        chatId,
        type: 'text',
        text,
        threadId,
      });
    },
    sendCard: async (
      chatId: string,
      card: Record<string, unknown>,
      threadId?: string,
      description?: string
    ) => {
      await channel.sendMessage({
        chatId,
        type: 'card',
        card,
        threadId,
        description,
      });
    },
    uploadFile: async (chatId: string, filePath: string, threadId?: string) => {
      // File upload via sendMessage with type: 'file'
      await channel.sendMessage({
        chatId,
        type: 'file',
        filePath,
        threadId,
      });
      // Return minimal file info (actual implementation would need to upload and get file_key)
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
      const { question, options, title, context, threadId, actionPrompts } = params;

      // Validate params at IPC boundary (data comes from external MCP Server process)
      const validationError = validateInteractiveParams(params);
      if (validationError) {
        logger.warn({ chatId, error: validationError }, 'sendInteractive: invalid params');
        throw new Error(`Invalid interactive params: ${validationError}`);
      }

      // Build card using extracted builder (Primary Node owns the full card lifecycle)
      const card = buildInteractiveCard({ question, options, title, context });

      await channel.sendMessage({
        chatId,
        type: 'card',
        card,
        threadId,
      });

      // Build action prompts: use caller-provided prompts or generate defaults
      const resolvedActionPrompts = actionPrompts && Object.keys(actionPrompts).length > 0
        ? actionPrompts
        : buildActionPrompts(options);

      // Issue #1570: Return synthetic messageId for action prompt registration.
      // Real messageId propagation requires doSendMessage() changes (future phase).
      const syntheticMessageId = `interactive_${chatId}_${Date.now()}`;

      // TODO(Phase 3 #1572): Move action prompt registration to Primary Node.
      // Currently MCP Server handles registration using the returned messageId + actionPrompts.
      // The synthetic messageId means registration will work but won't match the real Feishu message.
      logger.debug(
        { chatId, syntheticMessageId, actionCount: Object.keys(resolvedActionPrompts).length },
        'sendInteractive: card sent (synthetic messageId — action prompts should be registered by caller)'
      );

      return { messageId: syntheticMessageId, actionPrompts: resolvedActionPrompts };
    },
  };
}

/**
 * Feishu channel descriptor.
 *
 * Includes:
 * - Attachment extraction for file/image messages
 * - Passive mode integration
 * - IPC handler registration for MCP Server
 */
export const feishuDescriptor: ChannelDescriptor<FeishuChannelConfig> = {
  type: 'feishu',
  name: 'Feishu Channel',
  factory: (config: FeishuChannelConfig) => new FeishuChannel(config),
  sendDoneSignal: false,
  createCallbacks: (channel: IChannel, _context: ChannelSetupContext) =>
    createFeishuCallbacksFactory(channel),
  extractAttachments: extractFeishuAttachments,
  setup: async (channel: IChannel, context: ChannelSetupContext) => {
    const feishuChannel = channel as FeishuChannel;

    // Integrate passive mode into unified control handler context (Issue #1464)
    const controlHandlerContext = context.controlHandlerContext as {
      passiveMode?: {
        isEnabled: (chatId: string) => boolean;
        setEnabled: (chatId: string, enabled: boolean) => void;
      };
    };
    controlHandlerContext.passiveMode = {
      isEnabled: (chatId: string) => !feishuChannel.isPassiveModeDisabled(chatId),
      setEnabled: (chatId: string, enabled: boolean) =>
        feishuChannel.setPassiveModeDisabled(chatId, !enabled),
    };

    // Register Feishu handlers for IPC (Issue #1042)
    const feishuHandlers = createFeishuIpcHandlers(channel);
    context.primaryNode.registerFeishuHandlers(feishuHandlers);
    logger.info('Feishu IPC handlers registered');
  },
};
