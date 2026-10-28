/**
 * Wired Channel Descriptors - Channel-specific wiring for REST and Feishu.
 *
 * Issue #1594 Phase 2: Each descriptor encapsulates the full wiring lifecycle
 * for its channel type, including ChatAgentCallbacks creation, message handling,
 * and post-registration setup (passive mode, REST API handlers).
 *
 * Issue #1555 Phase 2: Shared handler utilities extracted to utils/channel-handlers.ts
 * for reuse across all channel types. This file now only contains
 * channel-specific configuration and Feishu post-registration setup.
 *
 * @module channels/wired-descriptors
 */

import {
  createInboundAttachment,
  createControlHandler,
  buildHelpMessage,
  Config,
  GitHubIssueClient,
  resolveGitHubIssueTarget,
  type ControlHandlerContext,
  type IChannel,
  type IncomingMessage,
  type FileRef,
  type FeishuApiHandlers,
  type ChannelApiHandlers,
  type SystemMessage,
} from '@disclaude/core';
import { persistentFileStorageProvider } from './rest/file-storage.js';
import { RestChannel, type RestChannelConfig } from './rest-channel.js';
import { FeishuChannel, type FeishuChannelConfig } from './feishu-channel.js';
import { WeChatChannel, type WeChatChannelConfig } from './wechat/index.js';
import crypto from 'crypto';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { messageLogger } from '../utils/message-logger.js';
import { WelcomeService } from '../platforms/feishu/welcome-service.js';
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
  factory: (config) => new RestChannel({ ...config, fileStorageServiceProvider: config.fileStorageServiceProvider ?? persistentFileStorageProvider }),
  defaultCapabilities: {
    supportsCard: true,
    supportsThread: false,
    supportsFile: false,
    supportsMarkdown: true,
    supportsMention: false,
    supportsUpdate: false,
    supportsStreaming: false,
    supportedChannelTools: [],
  },

  createCallbacks: (channel, context) =>
    createChannelCallbacksFactory(channel, context.logger, {
      sendDoneSignal: true,
      finalReplyOnly: true,
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
    // Issue #4256 (part 2): wire pool-stats provider so /api/health reports
    // live agent-pool state (active/busy/idle/peak/evictions) for leak diagnostics.
    restChannel.setAgentPoolStatsProvider(context.agentPool);
    context.service.registerChannelHandlers('rest', {
      ...createChannelApiHandlers(restChannel, { logger: context.logger, channelName: 'REST' }),
      sendInteractive: () => Promise.reject(new Error('REST does not support interactive cards')),
    }, restChannel);
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
 * - Post-registration setup: action prompt resolver, passive mode, REST API handlers
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
    supportsStreaming: false,
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
   * 3. Register REST API handlers (Issue #1042, #1571)
   */
  setup: (channel: IChannel, config: FeishuChannelConfig, context: ChannelSetupContext) => {
    const feishuChannel = channel as FeishuChannel;

    // 1. Set up action prompt resolver using InteractiveContextStore
    const contextStore = context.service.getInteractiveContextStore();
    config.resolveActionPrompt = (
      messageId: string,
      chatId: string,
      actionValue: string,
      actionText?: string
    ) => contextStore.generatePrompt(messageId, chatId, actionValue, actionText);
    config.resolveActionText = (messageId, chatId, actionValue) => contextStore.getActionText?.(messageId, chatId, actionValue);
    config.resolveActionThreadRoot = (messageId, chatId) => contextStore.getThreadRootId?.(messageId, chatId);

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
    const helpContext: ControlHandlerContext = {
      ...context.controlHandlerContext as unknown as ControlHandlerContext,
      triggerMode: triggerModeAdapter,
      getHelpCapabilities: () => feishuChannel.getCapabilities(),
    };
    const generateWelcomeMessage = (chatId: string, chatType: import('@disclaude/core').ChatType): string | undefined => {
      const command = { type: 'help' as const, chatId, chatType, ...(chatId.startsWith('ou_') ? { actorId: chatId } : {}) };
      if (helpContext.isCommandAllowed && !helpContext.isCommandAllowed(command)) { return undefined; }
      return buildHelpMessage(command, helpContext, true);
    };
    const welcomeService = new WelcomeService({
      generateWelcomeMessage,
      generateHelpMessage: generateWelcomeMessage,
      sendMessage: async (chatId, text) => { await feishuChannel.sendMessage({ chatId, type: 'text', text }); },
      sendWelcomeMessage: (chatId, text, chatType) => feishuChannel.sendWelcomeMessage(chatId, text, chatType),
    });
    helpContext.guidance = welcomeService;
    feishuChannel.setWelcomeService(welcomeService);

    // Issue #5400: resolve the GitHub App client from the `github` config
    // section once per setup; a broken section degrades /issue to text-only
    // guidance instead of failing the channel.
    try {
      const target = resolveGitHubIssueTarget(Config.getRawConfig());
      config.issueReportingClient = target ? new GitHubIssueClient(target) : undefined;
    } catch (error) {
      context.logger.warn({ err: error }, 'github feedback configuration could not be resolved; /issue submission stays disabled');
    }
    helpContext.issueReporting = {
      sendConfirmation: (record, target) => feishuChannel.requestIssueReport(record, target),
    };

    feishuChannel.onControl(createControlHandler(helpContext));

    // 3. Register REST API handlers for channel CLI requests
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
        /** Reply parent message ID (om_...); legacy name, not Feishu's omt_... thread_id. */
        threadId?: string;
        /** Requested topic root message ID (om_...); verifies the parent and anchors fallback. */
        threadRootId?: string;
        actionPrompts?: Record<string, string>;
      }) => {
        const { question, options, title, context: cardContext, threadId, threadRootId, actionPrompts } = params;

        // Validate params at REST API boundary
        const validationError = validateInteractiveParams(params);
        if (validationError) {
          context.logger.warn({ chatId, error: validationError }, 'sendInteractive: invalid params');
          throw new Error(`Invalid interactive params: ${validationError}`);
        }

        // Build card using extracted builder (disclaude service owns the full card lifecycle)
        const card = buildInteractiveCard({ question, options, title, context: cardContext });

        const messageId = await feishuChannel.sendMessage({
          chatId, type: 'card', card, threadId, ...(threadRootId ? { threadRootId } : {}),
        });
        // A queued or unacknowledged send cannot support button registration or
        // prove delivery. Never manufacture a successful receipt (Issue #5259).
        if (typeof messageId !== 'string' || !messageId.trim()) {
          throw new Error('Interactive card delivery returned no message_id; delivery is unconfirmed');
        }

        // Preserve explicit instructions and fill unmapped buttons with their
        // visible labels and the original card context, never just route IDs.
        const resolvedActionPrompts = buildActionPrompts(options, actionPrompts, undefined, {
          question, context: cardContext,
        });

        return { messageId, actionPrompts: resolvedActionPrompts };
      },

      // Issue #631: Push instruction to a chat agent via InputMessageRouter
      // Issue #4063: Support waitForCompletion for Loop Runner turn detection
      pushToAgent: async (chatId: string, message: string, options?: { waitForCompletion?: boolean }) => {
        const router = context.inputMessageRouter;
        if (!router) {
          throw new Error('InputMessageRouter not initialized — cannot push to agent');
        }

        context.logger.info({ chatId, messageLength: message.length, waitForCompletion: options?.waitForCompletion }, 'pushToAgent: routing system message');

        const systemMessage: SystemMessage = {
          id: `push_${crypto.randomUUID()}`,
          source: 'system',
          trigger: 'command',
          payload: message,
          chatId,
          createdAt: new Date().toISOString(),
          waitForCompletion: options?.waitForCompletion,
        };

        await router.route(systemMessage);

        return { success: true };
      },
    };

    context.service.registerFeishuHandlers(feishuHandlers);
    context.service.registerChannelHandlers('feishu', feishuHandlers, feishuChannel);
    context.logger.info('Feishu REST API handlers registered via descriptor setup');
  },
};

// ============================================================================
// WeChat Wired Descriptor
// ============================================================================

/**
 * WeChat Channel wired descriptor.
 *
 * Personal WeChat via Tencent iLink. Configured accounts load a private saved
 * login and long-poll incoming messages; dynamic registration remains usable.
 * Common attachment, Agent callback and CLI handlers all use the same adapter.
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
    supportsStreaming: false,
    supportedChannelTools: ['send_text', 'send_file'],
    nativeVideoFormats: ['mp4'],
  },

  createCallbacks: (channel, context) => {
    const factory = createChannelCallbacksFactory(channel, context.logger, {
      sendDoneSignal: false,
      getChatHistory: (chatId: string) => messageLogger.getChatHistory(chatId),
      getChatLogFilePaths: (chatId: string) => messageLogger.getChatLogFilePaths(chatId),
    });
    return (chatId, threadRootId) => ({
      ...factory(chatId, threadRootId),
      beginProcessing: (target) => (channel as WeChatChannel).beginTyping(target),
      sendFile: async (target, filePath) => { await channel.sendMessage({ chatId: target, type: 'file', filePath }); },
    });
  },

  createMessageHandler: (channel, context) =>
    createDefaultMessageHandler(channel, context, {
      channelName: 'WeChat channel',
      sendDoneSignal: false,
      extractAttachments: (message) => message.attachments?.map(att => createInboundAttachment(
        att.fileName, message.chatId, att.mimeType?.startsWith('image/') ? 'image' : 'file',
        { localPath: att.filePath, size: att.size, mimeType: att.mimeType, messageId: message.messageId },
      )),
    }),

  /**
   * Post-registration setup for WeChat channel.
   * Issue #3814: Register REST API handlers for channel CLI requests.
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

      sendCard: () => Promise.reject(new Error('WeChat does not support cards; use send_text')),
      sendInteractive: () => Promise.reject(new Error('WeChat does not support interactive cards; use send_text')),
      uploadFile: async (chatId, filePath, threadId) => {
        await wechatChannel.sendMessage({ chatId, type: 'file', filePath, threadId });
        return { fileKey: '', fileType: 'file', fileName: basename(filePath), fileSize: (await stat(filePath)).size };
      },

      // Issue #3814: pushToAgent reuses InputMessageRouter (same as Feishu)
      pushToAgent: async (chatId: string, message: string, options?: { waitForCompletion?: boolean }) => {
        const router = context.inputMessageRouter;
        if (!router) {
          throw new Error('InputMessageRouter not initialized — cannot push to agent');
        }

        context.logger.info({ chatId, messageLength: message.length, waitForCompletion: options?.waitForCompletion }, 'pushToAgent: routing system message via WeChat');

        const systemMessage: SystemMessage = {
          id: `push_${crypto.randomUUID()}`,
          source: 'system',
          trigger: 'command',
          payload: message,
          chatId,
          createdAt: new Date().toISOString(),
          waitForCompletion: options?.waitForCompletion,
        };

        await router.route(systemMessage);
        return { success: true };
      },
    };

    // Register with DisclaudeService for REST API routing
    context.service.registerChannelHandlers('wechat', wechatHandlers, wechatChannel);
    context.logger.info('WeChat REST API handlers registered via descriptor setup');
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
 * WeChat is config-driven when a saved private login is configured (#4889).
 */
export const BUILTIN_WIRED_DESCRIPTORS: WiredChannelDescriptor[] = [
  REST_WIRED_DESCRIPTOR,
  FEISHU_WIRED_DESCRIPTOR,
  WECHAT_WIRED_DESCRIPTOR,
];
