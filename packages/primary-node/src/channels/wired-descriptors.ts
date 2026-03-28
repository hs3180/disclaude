/**
 * Wired Channel Descriptors - Channel-specific wiring for REST and Feishu.
 *
 * Issue #1594 Phase 2: Each descriptor encapsulates the full wiring lifecycle
 * for its channel type, including PilotCallbacks creation, message handling,
 * and post-registration setup (passive mode, IPC handlers).
 *
 * Issue #1555 Phase 2: Shared handler utilities extracted to utils/channel-handlers.ts
 * for reuse across all channel types. This file now only contains
 * channel-specific configuration and Feishu post-registration setup.
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
import { RestChannel, type RestChannelConfig } from './rest-channel.js';
import { FeishuChannel, type FeishuChannelConfig } from './feishu-channel.js';
import { WeChatChannel, type WeChatChannelConfig } from './wechat/index.js';
import type {
  ChannelSetupContext,
  WiredChannelDescriptor,
} from '../channel-lifecycle-manager.js';
import {
  createChannelCallbacksFactory,
  createDefaultMessageHandler,
  createChannelApiHandlers,
} from '../utils/channel-handlers.js';
import {
  buildInteractiveCard,
  buildActionPrompts,
  validateInteractiveParams,
} from '../platforms/feishu/card-builders/index.js';

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
    // Base handlers reuse the same channel.sendMessage pattern as PilotCallbacks
    // (Issue #1555: unified handler injection — avoids duplication)
    const baseHandlers = createChannelApiHandlers(feishuChannel, {
      logger: context.logger,
      channelName: 'Feishu',
    });

    const feishuHandlers: FeishuApiHandlers = {
      ...baseHandlers,

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
      // Issue #1546: Group management handlers (platform-agnostic)
      // Issue #1228: Added soulId for discussion personality injection
      createChat: (name?: string, description?: string, memberIds?: string[], soulId?: string) => {
        return feishuChannel.createChat(name, description, memberIds, soulId);
      },
      dissolveChat: (chatId: string) => {
        return feishuChannel.dissolveChat(chatId);
      },
    };

    context.primaryNode.registerFeishuHandlers(feishuHandlers);
    context.logger.info('Feishu IPC handlers registered via descriptor setup');
  },
};

// ============================================================================
// WeChat Wired Descriptor
// ============================================================================

/**
 * WeChat Channel wired descriptor.
 *
 * **Design Decision (Issue #1638)**: WeChat Channel only supports dynamic
 * registration (programmatic API), NOT config.yaml static configuration.
 * This descriptor is kept for dynamic registration use — callers should use
 * `ChannelLifecycleManager.createAndWire(WECHAT_WIRED_DESCRIPTOR, config)`
 * at runtime (e.g., after QR code authentication completes).
 *
 * Provides full wiring for the WeChat channel (MVP):
 * - PilotCallbacks without done signal (async mode)
 * - Message handler with basic text processing
 * - No post-registration setup (MVP: no passive mode, no IPC handlers)
 *
 * MVP limitations:
 * - sendCard: downgrades to JSON-serialized text (WeChat API doesn't support cards)
 * - sendFile: not supported (logs warning only)
 * - No message listening / long polling (outbound-only bot)
 *
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1554 - WeChat Channel Dynamic Registration (Phase 1)
 * @see Issue #1638 - WeChat only supports dynamic registration, no config.yaml
 */
export const WECHAT_WIRED_DESCRIPTOR: WiredChannelDescriptor<WeChatChannelConfig> = {
  type: 'wechat',
  name: 'WeChat',
  factory: (config) => new WeChatChannel(config),
  defaultCapabilities: {
    supportsCard: false,
    supportsThread: false,
    supportsFile: false,
    supportsMarkdown: false,
    supportsMention: false,
    supportsUpdate: false,
  },

  createCallbacks: (channel, context) =>
    createChannelCallbacksFactory(channel, context.logger, { sendDoneSignal: false }),

  createMessageHandler: (channel, context) =>
    createDefaultMessageHandler(channel, context, {
      channelName: 'WeChat channel',
      sendDoneSignal: false,
    }),
};
// Built-in Wired Descriptors Registry
// ============================================================================

/**
 * All built-in wired channel descriptors.
 *
 * Register these with ChannelLifecycleManager to enable config-driven
 * channel creation via `createAndWireByType()`.
 *
 * Issue #1594 Phase 3: Adding a new channel only requires:
 * 1. Create WiredChannelDescriptor in this file
 * 2. Add it to this array
 *
 * Note: WeChat is NOT included here (Issue #1638: dynamic registration only).
 * cli.ts remains untouched — it iterates over this array automatically.
 */
export const BUILTIN_WIRED_DESCRIPTORS: WiredChannelDescriptor[] = [
  REST_WIRED_DESCRIPTOR,
  FEISHU_WIRED_DESCRIPTOR,
];

