/**
 * Wired Channel Descriptors - Channel-specific wiring for REST and Feishu.
 *
 * Issue #1594 Phase 2: Each descriptor encapsulates the full wiring lifecycle
 * for its channel type, including ChatAgentCallbacks creation, message handling,
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
  type ChannelApiHandlers,
  type SystemMessage,
} from '@disclaude/core';
import { RestChannel, type RestChannelConfig } from './rest-channel.js';
import { FeishuChannel, type FeishuChannelConfig } from './feishu-channel.js';
import { WeChatChannel, type WeChatChannelConfig } from './wechat/index.js';
import crypto from 'crypto';
import { messageLogger } from '../utils/message-logger.js';
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
 * - ChatAgentCallbacks with done signal (sync mode)
 * - Message handler with basic text processing
 * - Post-registration setup: inject InputMessageRouter for /api/push (Issue #3808)
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
    createChannelCallbacksFactory(channel, context.logger, {
      sendDoneSignal: true,
      getChatHistory: (chatId: string) => messageLogger.getChatHistory(chatId),
      getChatLogFilePaths: (chatId: string) => messageLogger.getChatLogFilePaths(chatId),
    }),

  createMessageHandler: (channel, context) =>
    createDefaultMessageHandler(channel, context, {
      channelName: 'REST channel',
      sendDoneSignal: true,
    }),

  /**
   * Post-registration setup for REST channel.
   *
   * Issue #3808: Inject InputMessageRouter so the /api/push endpoint
   * can route system messages to agents.
   */
  setup: (channel: IChannel, _config: RestChannelConfig, context: ChannelSetupContext) => {
    const restChannel = channel as RestChannel;
    if (context.inputMessageRouter) {
      restChannel.setInputMessageRouter(context.inputMessageRouter);
      context.logger.info('REST /api/push endpoint configured via descriptor setup');
    } else {
      context.logger.warn('InputMessageRouter not available — REST /api/push endpoint will return 503');
    }
  },
};

// ============================================================================
// Feishu Wired Descriptor
// ============================================================================

/**
 * Feishu Channel wired descriptor.
 *
 * Provides full wiring for the Feishu channel:
 * - ChatAgentCallbacks without done signal (async mode)
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
    createChannelCallbacksFactory(channel, context.logger, {
      sendDoneSignal: false,
      // Issue #1863: Wire getChatHistory callback for session restoration
      getChatHistory: (chatId: string) => messageLogger.getChatHistory(chatId),
      // Issue #3996: Wire getChatLogFilePaths so agent knows where log files are
      getChatLogFilePaths: (chatId: string) => messageLogger.getChatLogFilePaths(chatId),
    }),

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

    // 2. Set up trigger mode adapter (Issue #2291: enum-based interface, #3345: 'auto' mode)
    // Adapter delegates to TriggerModeManager's native enum-based getMode/setMode.
    // The manager handles 'auto' mode resolution internally.
    const triggerModeManager = feishuChannel.getTriggerModeManager();
    const triggerModeAdapter = {
      getMode: (chatId: string): 'mention' | 'always' | 'auto' =>
        triggerModeManager.getMode(chatId),
      setMode: (chatId: string, mode: 'mention' | 'always' | 'auto') =>
        triggerModeManager.setMode(chatId, mode),
    };
    context.controlHandlerContext.triggerMode = triggerModeAdapter;

    // 3. Register IPC handlers for MCP Server connections
    // Base handlers reuse the same channel.sendMessage pattern as ChatAgentCallbacks
    // (Issue #1555: unified handler injection — avoids duplication)
    const baseHandlers = createChannelApiHandlers(feishuChannel, {
      logger: context.logger,
      channelName: 'Feishu',
    });

    const feishuHandlers: FeishuApiHandlers = {
      ...baseHandlers,

      // Issue #2951: Upload image for card embedding
      uploadImage: (filePath: string) => {
        return feishuChannel.uploadImage(filePath);
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

        // Issue #1619: sendMessage now returns real messageId from Feishu API.
        // Use real messageId for action prompt matching; fall back to synthetic ID.
        const realMessageId = await feishuChannel.sendMessage({ chatId, type: 'card', card, threadId });
        const messageId = realMessageId || `interactive_${chatId}_${Date.now()}`;

        // Build action prompts: use caller-provided prompts or generate defaults
        const resolvedActionPrompts = actionPrompts && Object.keys(actionPrompts).length > 0
          ? actionPrompts
          : buildActionPrompts(options);

        return { messageId, actionPrompts: resolvedActionPrompts };
      },

      // Issue #631: Push instruction to a chat agent via InputMessageRouter
      pushToAgent: async (chatId: string, message: string) => {
        const router = context.inputMessageRouter;
        if (!router) {
          throw new Error('InputMessageRouter not initialized — cannot push to agent');
        }

        context.logger.info({ chatId, messageLength: message.length }, 'pushToAgent: routing system message');

        const systemMessage: SystemMessage = {
          id: `push_${crypto.randomUUID()}`,
          source: 'system',
          trigger: 'command',
          payload: message,
          chatId,
          createdAt: new Date().toISOString(),
        };

        await router.route(systemMessage);

        return { success: true };
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
 * Provides full wiring for the WeChat channel:
 * - ChatAgentCallbacks without done signal (async mode)
 * - Message handler with basic text processing
 * - No post-registration setup (no passive mode, no IPC handlers)
 *
 * Capabilities:
 * - sendCard: downgrades to JSON-serialized text (WeChat API doesn't support cards)
 * - sendFile: supported via CDN upload (Phase 3.2, Issue #1556)
 * - No message listening / long polling (outbound-only bot)
 *
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1554 - WeChat Channel Dynamic Registration (Phase 1)
 * @see Issue #1556 - WeChat Channel Phase 3.2 (CDN media upload)
 * @see Issue #1638 - WeChat only supports dynamic registration, no config.yaml
 */
export const WECHAT_WIRED_DESCRIPTOR: WiredChannelDescriptor<WeChatChannelConfig> = {
  type: 'wechat',
  name: 'WeChat',
  factory: (config) => new WeChatChannel(config),
  defaultCapabilities: {
    supportsCard: false,
    supportsThread: false,
    supportsFile: true,
    supportsMarkdown: false,
    supportsMention: false,
    supportsUpdate: false,
    supportedMcpTools: ['send_text', 'send_file'],
  },

  createCallbacks: (channel, context) =>
    createChannelCallbacksFactory(channel, context.logger, {
      sendDoneSignal: false,
      getChatHistory: (chatId: string) => messageLogger.getChatHistory(chatId),
      getChatLogFilePaths: (chatId: string) => messageLogger.getChatLogFilePaths(chatId),
    }),

  createMessageHandler: (channel, context) =>
    createDefaultMessageHandler(channel, context, {
      channelName: 'WeChat channel',
      sendDoneSignal: false,
    }),

  /**
   * Post-registration setup for WeChat channel.
   * Issue #3814: Register IPC handlers for MCP Server tool routing.
   *
   * Registers handlers for:
   * - sendMessage (base: delegates to channel.sendMessage)
   * - sendCard (base: delegates to channel.sendMessage, WeChat downgrades to text)
   * - uploadFile (base: delegates to channel.sendMessage for file delivery)
   * - sendInteractive (downgraded to text message — WeChat has no card support)
   * - pushToAgent (reuses InputMessageRouter, same as Feishu)
   */
  setup: (channel: IChannel, _config: WeChatChannelConfig, context: ChannelSetupContext) => {
    const wechatChannel = channel as WeChatChannel;

    // Base handlers reuse the same channel.sendMessage pattern
    const baseHandlers = createChannelApiHandlers(wechatChannel, {
      logger: context.logger,
      channelName: 'WeChat',
    });

    const wechatHandlers: ChannelApiHandlers = {
      ...baseHandlers,

      // Issue #3814: sendInteractive downgraded to text for WeChat
      sendInteractive: async (chatId, params) => {
        const { question, options, title } = params;
        const parts: string[] = [];
        if (title) {parts.push(`【${title}】`);}
        parts.push(question);
        for (const opt of options) {
          parts.push(`- ${opt.text}`);
        }
        await wechatChannel.sendMessage({
          chatId,
          type: 'text',
          text: parts.join('\n'),
        });
        // WeChat has no interactive support — return synthetic IDs
        return { messageId: `wechat_interactive_${crypto.randomUUID()}` };
      },

      // Issue #3814: pushToAgent reuses InputMessageRouter (same as Feishu)
      pushToAgent: async (chatId: string, message: string) => {
        const router = context.inputMessageRouter;
        if (!router) {
          throw new Error('InputMessageRouter not initialized — cannot push to agent');
        }

        context.logger.info({ chatId, messageLength: message.length }, 'pushToAgent: routing system message via WeChat');

        const systemMessage: SystemMessage = {
          id: `push_${crypto.randomUUID()}`,
          source: 'system',
          trigger: 'command',
          payload: message,
          chatId,
          createdAt: new Date().toISOString(),
        };

        await router.route(systemMessage);
        return { success: true };
      },
    };

    // Register with PrimaryNode for IPC routing
    context.primaryNode.registerChannelHandlers('wechat', wechatHandlers, wechatChannel);
    context.logger.info('WeChat IPC handlers registered via descriptor setup');
  },
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

