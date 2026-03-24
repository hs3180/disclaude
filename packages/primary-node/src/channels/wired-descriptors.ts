/**
 * Wired Channel Descriptors.
 *
 * Provides WiredChannelDescriptor instances for built-in channel types.
 * Unlike the basic ChannelDescriptor (factory + capabilities only),
 * these include full wiring logic: callbacks, message handlers, and setup hooks.
 *
 * Part of Issue #1594 (Phase 2): Abstract channel wiring into descriptors.
 *
 * @module channels/wired-descriptors
 */

import {
  createLogger,
  type IChannel,
  type FileRef,
  type IncomingMessage,
  type FeishuApiHandlers,
  createInboundAttachment,
} from '@disclaude/core';
import type { PilotCallbacks } from '@disclaude/worker-node';
import { RestChannel, type RestChannelConfig } from './rest-channel.js';
import { FeishuChannel, type FeishuChannelConfig } from './feishu-channel.js';
import {
  type WiredChannelDescriptor,
  type ChannelSetupContext,
  createChannelCallbacks,
  createDefaultMessageHandler,
} from '../channel-lifecycle-manager.js';
import {
  buildInteractiveCard,
  buildActionPrompts,
  validateInteractiveParams,
} from '../platforms/feishu/card-builders/index.js';

const logger = createLogger('WiredDescriptors');

// ============================================================================
// REST Channel Wired Descriptor
// ============================================================================

/**
 * REST Channel wired descriptor.
 *
 * Wiring specifics:
 * - Callbacks: sendDoneSignal=true (REST uses sync mode, signals completion)
 * - Message handler: standard flow, no attachment conversion, done signal on error
 * - No post-registration setup
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
    supportedMcpTools: ['send_text', 'send_card', 'send_interactive', 'send_file'],
  },

  createCallbacks: (channel: IChannel) => {
    return createChannelCallbacks(channel, { sendDoneSignal: true });
  },

  createMessageHandler: (channel: IChannel, context: ChannelSetupContext, _callbacks: PilotCallbacks) => {
    // REST needs its own message handler because it sends 'done' signal on error
    return createDefaultMessageHandler(channel, context, _callbacks, {
      sendDoneSignalOnError: true,
    });
  },
};

// ============================================================================
// Feishu Channel Wired Descriptor
// ============================================================================

/**
 * Feishu Channel wired descriptor.
 *
 * Wiring specifics:
 * - Callbacks: sendDoneSignal=false (Feishu uses async mode)
 * - Message handler: includes attachment conversion (images, files)
 * - Setup: passive mode adapter + IPC handler registration
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
    supportedMcpTools: ['send_text', 'send_card', 'send_interactive', 'send_file'],
  },

  createCallbacks: (channel: IChannel) => {
    return createChannelCallbacks(channel, { sendDoneSignal: false });
  },

  createMessageHandler: (channel: IChannel, context: ChannelSetupContext, callbacks: PilotCallbacks) => {
    // Feishu-specific: convert MessageAttachment[] to FileRef[]
    const convertAttachments = (message: IncomingMessage): FileRef[] | undefined => {
      const { attachments, messageId, messageType, chatId } = message;
      return attachments?.map((att) =>
        createInboundAttachment(
          att.fileName,
          chatId,
          messageType as 'image' | 'file' | 'media',
          {
            localPath: att.filePath,
            mimeType: att.mimeType,
            size: att.size,
            messageId,
          }
        )
      );
    };

    return createDefaultMessageHandler(channel, context, callbacks, {
      convertAttachments,
      sendDoneSignalOnError: false,
    });
  },

  /**
   * Feishu post-registration setup:
   * 1. Configure passive mode adapter on controlHandlerContext
   * 2. Register Feishu IPC handlers for MCP Server tools
   */
  setup: (channel: IChannel, context: ChannelSetupContext) => {
    const feishuChannel = channel as FeishuChannel;

    // 1. Passive mode adapter (Issue #1464)
    // FeishuChannel exposes isPassiveModeDisabled/setPassiveModeDisabled,
    // while ControlHandlerContext uses isEnabled/setEnabled semantics.
    if (context.controlHandlerContext) {
      context.controlHandlerContext.passiveMode = {
        isEnabled: (chatId: string) => !feishuChannel.isPassiveModeDisabled(chatId),
        setEnabled: (chatId: string, enabled: boolean) =>
          feishuChannel.setPassiveModeDisabled(chatId, !enabled),
      };
    }

    // 2. Register Feishu IPC handlers for MCP Server tools
    const feishuHandlers: FeishuApiHandlers = {
      sendMessage: async (chatId: string, text: string, threadId?: string) => {
        await feishuChannel.sendMessage({
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
        await feishuChannel.sendMessage({
          chatId,
          type: 'card',
          card,
          threadId,
          description,
        });
      },

      uploadFile: async (chatId: string, filePath: string, threadId?: string) => {
        await feishuChannel.sendMessage({
          chatId,
          type: 'file',
          filePath,
          threadId,
        });
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
          logger.warn({ chatId, error: validationError }, 'sendInteractive: invalid params');
          throw new Error(`Invalid interactive params: ${validationError}`);
        }

        // Build card using extracted builder (Primary Node owns the full card lifecycle)
        const card = buildInteractiveCard({ question, options, title, context: cardContext });

        await feishuChannel.sendMessage({
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
        const syntheticMessageId = `interactive_${chatId}_${Date.now()}`;

        // TODO(Phase 3 #1572): Move action prompt registration to Primary Node.
        logger.debug(
          { chatId, syntheticMessageId, actionCount: Object.keys(resolvedActionPrompts).length },
          'sendInteractive: card sent (synthetic messageId — action prompts should be registered by caller)'
        );

        return { messageId: syntheticMessageId, actionPrompts: resolvedActionPrompts };
      },
    };

    context.primaryNode.registerFeishuHandlers(feishuHandlers);
    logger.info('Feishu IPC handlers registered via descriptor setup');
  },
};

// ============================================================================
// All Wired Descriptors
// ============================================================================

/**
 * All built-in wired channel descriptors.
 *
 * @example
 * ```typescript
 * const manager = new ChannelLifecycleManager({...});
 * for (const desc of BUILTIN_WIRED_DESCRIPTORS) {
 *   manager.registerDescriptor(desc);
 * }
 * ```
 */
export const BUILTIN_WIRED_DESCRIPTORS: WiredChannelDescriptor[] = [
  REST_WIRED_DESCRIPTOR,
  FEISHU_WIRED_DESCRIPTOR,
];
