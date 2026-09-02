/**
 * Feishu Channel Implementation.
 *
 * Handles Feishu/Lark messaging platform integration via WebSocket.
 * Implements the IChannel interface for unified message handling.
 *
 * Issue #694: Refactored to use modular components.
 * Migrated to @disclaude/primary-node (Issue #1040)
 * Issue #1351: WsConnectionManager for health detection & auto-reconnect.
 */

import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import {
  Config,
  WS_HEALTH,
  createLogger,
  BaseChannel,
  eventBus,
  type FeishuEventData,
  type FeishuCardActionEventData,
  type FeishuChatMemberAddedEventData,
  type FeishuP2PChatEnteredEventData,
  type OutgoingMessage,
  type ChannelCapabilities,
  DEFAULT_CHANNEL_CAPABILITIES,
  attachmentManager,
} from '@disclaude/core';
import {
  InteractionManager,
  WelcomeService,
  createFeishuClient,
} from '../platforms/feishu/index.js';
import {
  TriggerModeManager,
  MentionDetector,
  WelcomeHandler,
  MessageHandler as FeishuMessageHandler,
  messageLogger,
  type MessageCallbacks,
  WsConnectionManager,
} from './feishu/index.js';
import { VIDEO_EXTENSIONS, extractVideoCover } from '../utils/video-cover-extractor.js';
import {
  IMAGE_EXTENSIONS,
  EXT_TO_FEISHU_FILE_TYPE,
  MAX_IMAGE_SIZE,
  MAX_FILE_SIZE,
  uploadImage,
  uploadFile,
} from '../utils/feishu-upload.js';
import { extractCardTextContent } from '../platforms/feishu/card-builders/card-text-extractor.js';
// Issue #4400 (#4208 P2-c): Card Kit streaming wiring.
import {
  FeishuCardKitClient,
  createCardKitClientFromEnv,
} from '../platforms/feishu/feishu-cardkit-client.js';
import {
  buildStreamingPlaceholderCard,
  STREAMING_REPLY_ELEMENT_ID,
} from '../platforms/feishu/card-builders/streaming-card-builder.js';
import {
  configuredFeishuMessageBytes,
  FEISHU_RETRY_MESSAGE_BYTES,
  truncateFeishuMessage,
} from './feishu-message-chunker.js';

const logger = createLogger('FeishuChannel');

/**
 * Extract chat ID from various Feishu event data formats.
 *
 * Handles different event types with different data structures:
 * - im.message.receive_v1: data.event.message.chat_id
 * - card.action.trigger: data.context.open_chat_id
 * - bot_p2p_chat_entered_v1: data.event.user.open_id
 * - chat.member.added_v1: data.event.chat_id
 *
 * Issue #1357: Used in event dispatcher catch blocks to notify users of errors.
 */
export function extractChatIdFromEvent(data: unknown): string | undefined {
  const raw = data as Record<string, unknown>;
  if (!raw) {
    return undefined;
  }

  // Try message event format: data.event.message.chat_id
  const event = raw.event as Record<string, unknown> | undefined;
  if (event?.message) {
    const message = event.message as Record<string, unknown>;
    if (typeof message.chat_id === 'string') {
      return message.chat_id;
    }
  }

  // Try card action format: data.context.open_chat_id
  if (raw.context) {
    const context = raw.context as Record<string, unknown>;
    if (typeof context.open_chat_id === 'string') {
      return context.open_chat_id;
    }
  }

  // Try member added event format: data.event.chat_id
  if (event && typeof event.chat_id === 'string') {
    return event.chat_id;
  }

  // Try P2P chat entered format: data.event.user.open_id
  if (event?.user) {
    const user = event.user as Record<string, unknown>;
    if (typeof user.open_id === 'string') {
      return user.open_id;
    }
  }

  return undefined;
}

/**
 * Extract structured Feishu API error details from a thrown lark SDK / axios error.
 *
 * Feishu returns business-level errors (e.g. an HTTP 400 for `im.message.reply`)
 * as a JSON body of shape `{ code, msg, log_id, data }`. The lark SDK surfaces
 * these as axios-style errors where the body lives on `err.response.data`, but
 * that body rarely serializes cleanly through the logger — which is why Issue
 * #4452 recorded 644 thread-reply failures "falling back to message.create"
 * with no captured root cause (the `code`/`msg`/`log_id` that pinpoint it).
 *
 * This normalizes the common shapes (axios `.response.data`, a direct `.code`
 * / `.msg` on the thrown object, and a bare `Error`) into a flat object safe to
 * spread into a pino log field. Only fields that are actually present are
 * included, so logs stay clean for ordinary `Error` throws.
 */
export function extractFeishuApiError(err: unknown): Record<string, unknown> {
  if (!err || typeof err !== 'object') {
    return { errorMessage: String(err) };
  }
  const e = err as Record<string, unknown>;
  // Feishu business error body: prefer axios `.response.data`, then a direct
  // `.data`, then the thrown object itself (some SDKs unwrap the body).
  const response = e.response as Record<string, unknown> | undefined;
  const body = (response?.data ?? e.data ?? e) as Record<string, unknown> | undefined;
  const apiCode = body?.code ?? e.code;
  const apiMsg = body?.msg ?? e.msg ?? e.message;
  const logId = body?.log_id ?? e.log_id ?? e.logId;
  const httpStatus = response?.status ?? e.status;

  const detail: Record<string, unknown> = {
    errorMessage: typeof e.message === 'string' ? e.message : String(err),
  };
  if (apiCode !== undefined) {
    detail.apiCode = apiCode;
  }
  if (apiMsg !== undefined && apiMsg !== e.message) {
    detail.apiMsg = apiMsg;
  }
  if (logId !== undefined) {
    detail.apiLogId = logId;
  }
  if (httpStatus !== undefined) {
    detail.httpStatus = httpStatus;
  }
  return detail;
}

/**
 * Feishu channel configuration.
 */
export interface FeishuChannelConfig {
  /** Channel ID (optional) */
  id?: string;
  /** Feishu App ID */
  appId?: string;
  /** Feishu App Secret */
  appSecret?: string;
  /**
   * Enable native streaming replies (Card Kit). Issue #4400 / #4208.
   * Default false → supportsStreaming capability is false → ChatAgent uses
   * sendMessage (unchanged). When true, the channel reports supportsStreaming.
   * Issue #4510 (part 2): the p2p-first narrowing is built-in (agent-side
   * chatType gate), not a config value — `true` means streaming in single
   * chats only; group/topic turns keep sendMessage.
   */
  streamingCard?: boolean;
  /**
   * Route card action to the local agent if applicable.
   * Issue #1629: Includes resolvedPrompt from InteractiveContextStore
   * so the agent receives the contextual prompt.
   * Issue #2247: Returns RouteCardActionResult to distinguish expired contexts.
   */
  routeCardAction?: (message: {
    chatId: string;
    cardMessageId: string;
    actionType: string;
    actionValue: string;
    actionText?: string;
    userId?: string;
    /** Resolved prompt from InteractiveContextStore (Issue #1629) */
    resolvedPrompt?: string;
    action?: {
      type: string;
      value: string;
      text?: string;
      trigger?: string;
    };
  }) => Promise<{ routed: boolean; expired?: boolean }>;
  /**
   * Resolve action prompt for a card action.
   * Issue #1572: Looks up the prompt template from InteractiveContextStore.
   */
  resolveActionPrompt?: (
    messageId: string,
    chatId: string,
    actionValue: string,
    actionText?: string
  ) => string | undefined;
}

/**
 * Feishu Channel - Handles Feishu/Lark messaging via WebSocket.
 *
 * Features:
 * - WebSocket-based event receiving with SDK-driven reconnection (Issue #2905)
 * - Auto-reconnect with exponential backoff triggered by SDK error/close events
 * - Offline message queue for messages sent during reconnection
 * - Message deduplication
 * - File/image handling
 * - Interactive card support
 * - Typing reactions
 */
export class FeishuChannel extends BaseChannel<FeishuChannelConfig> {
  private appId: string;
  private appSecret: string;
  private client?: lark.Client;

  // Issue #4400 (#4208 P2-c): Card Kit streaming state.
  // `streamingSequences` holds the per-card monotonic `sequence` counter that
  // Card Kit requires across ALL PUT/PATCH operations on one card (out-of-order
  // / reused values are rejected with business code 300317). createCard itself
  // carries no sequence, so the first PUT starts at 1.
  private streamingCardKitClient?: FeishuCardKitClient;
  private readonly streamingSequences = new Map<string, number>();

  /** WebSocket connection manager for health detection & auto-reconnect (Issue #1351) */
  private wsConnectionManager?: WsConnectionManager;

  // Modular components
  private triggerModeManager: TriggerModeManager;
  private mentionDetector: MentionDetector;
  private welcomeHandler: WelcomeHandler;
  private feishuMessageHandler: FeishuMessageHandler;
  private interactionManager: InteractionManager;

  /**
   * Offline message queue (Issue #1351).
   *
   * When the WebSocket is reconnecting, outgoing messages are buffered here
   * and automatically flushed after the connection is restored. Messages
   * older than `WS_HEALTH.OFFLINE_QUEUE.MAX_MESSAGE_AGE_MS` are discarded.
   */
  private offlineQueue: Array<{ message: OutgoingMessage; queuedAt: number }> = [];

  constructor(config: FeishuChannelConfig = {}) {
    super(config, 'feishu', 'Feishu');
    this.appId = config.appId || Config.FEISHU_APP_ID;
    this.appSecret = config.appSecret || Config.FEISHU_APP_SECRET;

    // Initialize modular components
    this.triggerModeManager = new TriggerModeManager();
    this.mentionDetector = new MentionDetector();
    this.interactionManager = new InteractionManager();
    this.welcomeHandler = new WelcomeHandler(this.appId, () => this.isRunning);

    // Create message callbacks
    const callbacks: MessageCallbacks = {
      emitMessage: async (message: Parameters<BaseChannel['emitMessage']>[0]) => {
        await this.emitMessage(message);
      },
      emitControl: async (control: Parameters<BaseChannel['emitControl']>[0]) => {
        if (this.controlHandler) {
          return await this.emitControl(control);
        }
        return { success: false };
      },
      sendMessage: async (message: {
        chatId: string;
        type: string;
        text?: string;
        card?: Record<string, unknown>;
        description?: string;
        threadId?: string;
        filePath?: string;
      }) => {
        await this.sendMessage(message as OutgoingMessage);
      },
      routeCardAction: config.routeCardAction,
      resolveActionPrompt: config.resolveActionPrompt,
      // Issue #4031: Emit topic message events through InternalEventBus
      onTopicMessage: (event) => {
        eventBus.emit('feishu.topic.message', event);
      },
    };

    this.feishuMessageHandler = new FeishuMessageHandler({
      triggerModeManager: this.triggerModeManager,
      mentionDetector: this.mentionDetector,
      interactionManager: this.interactionManager,
      callbacks,
      isRunning: () => this.isRunning,
      hasControlHandler: () => !!this.controlHandler,
      tenantAccessToken: process.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN || '',
    });

    logger.info({ id: this.id }, 'FeishuChannel created');
  }

  protected async doStart(): Promise<void> {
    // Initialize message logger
    await messageLogger.init();

    // Create Feishu client
    this.client = createFeishuClient(this.appId, this.appSecret, {
      loggerLevel: lark.LoggerLevel.info,
    });

    // Set client on mention detector and fetch bot info
    this.mentionDetector.setClient(this.client);
    await this.mentionDetector.fetchBotInfo();

    // Initialize message handler
    this.feishuMessageHandler.initialize(this.client);

    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        try {
          await this.feishuMessageHandler.handleMessageReceive(data as FeishuEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle message receive');
          await this.notifyUserDirectly(
            extractChatIdFromEvent(data) ?? '',
            '⚠️ 处理消息时遇到内部错误，请稍后重试。'
          );
        }
      },
      'card.action.trigger': async (data: unknown) => {
        try {
          await this.feishuMessageHandler.handleCardAction(data as FeishuCardActionEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle card action');
          await this.notifyUserDirectly(
            extractChatIdFromEvent(data) ?? '',
            '⚠️ 处理卡片操作时遇到错误，请稍后重试。'
          );
        }
      },
      'im.message.message_read_v1': () => {
        // No action needed for read receipts
      },
      'im.message.reaction.created_v1': () => {
        // No action needed — bot adds typing reactions which trigger these events
      },
      'im.message.reaction.deleted_v1': () => {
        // No action needed — reaction removal events are not actionable
      },
      'im.chat.access_event.bot_p2p_chat_entered_v1': async (data: unknown) => {
        try {
          await this.welcomeHandler.handleP2PChatEntered(data as FeishuP2PChatEnteredEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle P2P chat entered');
          await this.notifyUserDirectly(
            extractChatIdFromEvent(data) ?? '',
            '⚠️ 欢迎消息发送失败，但这不影响正常使用。'
          );
        }
      },
      'im.chat.member.added_v1': async (data: unknown) => {
        try {
          await this.welcomeHandler.handleChatMemberAdded(data as FeishuChatMemberAddedEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle chat member added');
          await this.notifyUserDirectly(
            extractChatIdFromEvent(data) ?? '',
            '⚠️ 欢迎消息发送失败，但这不影响正常使用。'
          );
        }
      },
      'im.chat.updated_v1': (data: unknown) => {
        // A chat's properties changed (rename, description, or a group/topic
        // format toggle). Drop the cached chat_mode / group_message_type so the
        // next message re-fetches — no need to parse the diff, lazy re-fetch on
        // the next message is correct and wastes nothing when no message comes.
        try {
          const chatId = extractChatIdFromEvent(data);
          if (chatId) {
            this.feishuMessageHandler.invalidateChatModeCache(chatId);
          }
        } catch (error) {
          logger.warn({ err: error }, 'Failed to invalidate chat_mode cache on chat update');
        }
      },
    });

    // Create SDK logger
    const sdkLogger = {
      error: (...msg: unknown[]) => logger.error({ context: 'LarkSDK' }, String(msg)),
      warn: (...msg: unknown[]) => logger.warn({ context: 'LarkSDK' }, String(msg)),
      info: (...msg: unknown[]) => logger.info({ context: 'LarkSDK' }, String(msg)),
      debug: (...msg: unknown[]) => logger.debug({ context: 'LarkSDK' }, String(msg)),
      trace: (...msg: unknown[]) => logger.trace({ context: 'LarkSDK' }, String(msg)),
    };

    // Create WebSocket connection manager (Issue #1351, simplified in #2905)
    this.wsConnectionManager = new WsConnectionManager({
      appId: this.appId,
      appSecret: this.appSecret,
      sdkLogger,
      sdkLogLevel: lark.LoggerLevel.info,
    });

    // Listen for connection state events
    this.wsConnectionManager.on('stateChange', (state) => {
      logger.info({ wsState: state }, 'WebSocket connection state changed');
    });

    this.wsConnectionManager.on('reconnected', (attempt) => {
      logger.info({ attempt }, 'WebSocket reconnected successfully');
      // Flush offline message queue after reconnect
      void this.flushOfflineQueue();
    });

    this.wsConnectionManager.on('reconnectFailed', (totalAttempts) => {
      logger.error({ totalAttempts }, 'WebSocket reconnection failed after all attempts');
    });

    // Start the connection manager (creates WSClient + registers SDK event listeners)
    await this.wsConnectionManager.start(eventDispatcher);

    logger.info('FeishuChannel started');
  }

  protected async doStop(): Promise<void> {
    // Stop WebSocket connection manager (closes WSClient + cleans up resources)
    if (this.wsConnectionManager) {
      await this.wsConnectionManager.stop();
      this.wsConnectionManager = undefined;
    }

    this.feishuMessageHandler.clearClient();

    // Dispose interaction manager
    this.interactionManager.dispose();

    // Clear offline queue
    this.offlineQueue = [];

    // Clean up old attachments to prevent memory leaks
    attachmentManager.cleanupOldAttachments();

    logger.info('FeishuChannel stopped');
  }

  protected async doSendMessage(message: OutgoingMessage): Promise<string | void> {
    if (!this.client) {
      throw new Error('Client not initialized');
    }

    // If WebSocket is reconnecting, queue message for later (Issue #1351)
    if (this.wsConnectionManager && this.wsConnectionManager.state !== 'connected') {
      this.queueOfflineMessage(message);
      return;
    }

    // Issue #1619: Use thread reply when threadId is provided.
    // Consistent with feishu-adapter.ts pattern.
    const useThreadReply = !!message.threadId;

    // Narrow client type for use inside closure (TS can't narrow this.client in closures)
    // eslint-disable-next-line prefer-destructuring
    const client = this.client;

    /**
     * Helper: send a Feishu message via create or reply API.
     * Returns the real message_id from the API response.
     */
    const sendFeishuMessage = async (
      msgType: string,
      content: string
    ): Promise<string | undefined> => {
      if (useThreadReply) {
        // useThreadReply is !!message.threadId — guaranteed truthy here.
        // TypeScript can't narrow from boolean, so we use type assertion.
        const threadId = message.threadId as string;
        try {
          const replyResp = await client.im.message.reply({
            path: {
              message_id: threadId,
            },
            data: {
              msg_type: msgType,
              content,
            },
          });
          return replyResp.data?.message_id;
        } catch (err) {
          // Issue #4452: capture the Feishu API-level error (code/msg/log_id)
          // so the frequent reply() 400s become diagnosable. Rather than dump
          // the raw (very verbose) axios error, `extractFeishuApiError` pulls
          // out the body the lark SDK buries on `err.response.data` plus the
          // HTTP status — the fields needed to pinpoint why reply() failed.
          logger.warn(
            {
              threadId,
              chatId: message.chatId,
              ...extractFeishuApiError(err),
            },
            'Thread reply failed, falling back to message.create'
          );
          // Fall through to create path (with root_id, see below).
        }
      }
      const createResp = await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: message.chatId,
          msg_type: msgType,
          content,
          // Issue #4252: when we intended a thread reply, keep the message in
          // the thread on the create fallback too. Without root_id, message.create
          // posts to the chat root, so the card/text escapes the thread — the
          // observed symptom for send_interactive/send_card when reply() fails.
          ...(useThreadReply ? { root_id: message.threadId as string } : {}),
        },
      });
      return createResp.data?.message_id;
    };

    /**
     * Helper: log an outgoing message to the chat history (Issue #3795).
     * Fire-and-forget to avoid blocking the send flow.
     */
    const logOutgoing = (
      msgId: string | undefined,
      contentSummary: string,
      msgType: string
    ): void => {
      if (!msgId) {
        return;
      }
      messageLogger
        .logOutgoingMessage(msgId, message.chatId, contentSummary, msgType)
        .catch((err) => {
          logger.warn({ err, chatId: message.chatId, msgId }, 'Failed to log outgoing message');
        });
    };

    switch (message.type) {
      case 'text': {
        // Issue #1742: If mentions are provided, send as post (rich text) with @mention tags
        if (message.mentions && message.mentions.length > 0) {
          const postContent = this.buildPostContentWithMentions(
            message.mentions,
            message.text || ''
          );
          const messageId = await sendFeishuMessage('post', JSON.stringify(postContent));
          logger.debug(
            {
              chatId: message.chatId,
              messageId,
              mentionCount: message.mentions.length,
              threadReply: useThreadReply,
            },
            'Post message (with mentions) sent'
          );
          logOutgoing(messageId, message.text || '', 'post');
          return messageId;
        }
        const text = message.text || '';
        let textToSend = truncateFeishuMessage(text, configuredFeishuMessageBytes());
        let messageId: string | undefined;
        try {
          messageId = await sendFeishuMessage('text', JSON.stringify({ text: textToSend }));
        } catch (err) {
          const apiError = extractFeishuApiError(err);
          if (Number(apiError.apiCode) !== 230025) {
            throw err;
          }
          textToSend = truncateFeishuMessage(text, FEISHU_RETRY_MESSAGE_BYTES);
          logger.warn(
            {
              chatId: message.chatId,
              originalBytes: Buffer.byteLength(text),
              sentBytes: Buffer.byteLength(textToSend),
              apiCode: apiError.apiCode,
            },
            'Feishu 230025; retrying with a more compact head-tail truncation (Issue #4693)'
          );
          try {
            messageId = await sendFeishuMessage('text', JSON.stringify({ text: textToSend }));
          } catch (retryErr) {
            const retryApiError = extractFeishuApiError(retryErr);
            if (Number(retryApiError.apiCode) !== 230025) {
              throw retryErr;
            }
            // Keep the session responsive even if the platform limit is lower
            // than our conservative retry budget or changes again.
            textToSend = '⚠️ 回复内容过长，已发送截断提示。请缩小测试范围后重试。';
            logger.error(
              {
                chatId: message.chatId,
                originalBytes: Buffer.byteLength(text),
                apiCode: retryApiError.apiCode,
              },
              'Feishu rejected the compact retry as oversized; sending a short fallback'
            );
            messageId = await sendFeishuMessage('text', JSON.stringify({ text: textToSend }));
          }
        }
        logger.debug(
          {
            chatId: message.chatId,
            messageId,
            truncated: textToSend !== text,
            threadReply: useThreadReply,
          },
          'Text message sent'
        );
        logOutgoing(messageId, textToSend, 'text');
        return messageId;
      }

      case 'card': {
        const messageId = await sendFeishuMessage(
          'interactive',
          JSON.stringify(message.card || {})
        );
        logger.debug(
          { chatId: message.chatId, messageId, threadReply: useThreadReply },
          'Card message sent'
        );
        // Issue #3995: Extract card text content when description is missing
        const rawCardDescription =
          message.description || (message.card ? extractCardTextContent(message.card) : '[card]');
        const cardDescription =
          rawCardDescription.length > 200
            ? `${rawCardDescription.slice(0, 197)}...`
            : rawCardDescription;
        logOutgoing(messageId, cardDescription, 'interactive');
        return messageId;
      }

      case 'file': {
        if (!message.filePath) {
          logger.error({ chatId: message.chatId }, 'File path missing in file message');
          throw new Error('File path is required for file messages');
        }

        // eslint-disable-next-line prefer-destructuring
        const filePath = message.filePath;
        const fileName = path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const { size: fileSize } = fs.statSync(filePath);

        logger.info({ chatId: message.chatId, filePath, fileName, fileSize }, 'Uploading file');

        // Determine message type based on file extension
        const isImage = IMAGE_EXTENSIONS.has(ext);

        let fileMessageId: string | undefined;

        if (isImage) {
          // Upload image using shared utility
          if (fileSize > MAX_IMAGE_SIZE) {
            throw new Error(
              `Image file too large: ${fileSize} bytes (max ${MAX_IMAGE_SIZE / 1024 / 1024}MB)`
            );
          }
          const imageKey = await uploadImage(this.client, filePath);
          if (!imageKey) {
            logger.error(
              { chatId: message.chatId, fileName },
              'Failed to upload image, no image_key returned'
            );
            throw new Error(`Failed to upload image: ${fileName}`);
          }
          logger.info(
            { chatId: message.chatId, imageKey, fileName },
            'Image uploaded, sending message'
          );

          // Send image message
          fileMessageId = await sendFeishuMessage('image', JSON.stringify({ image_key: imageKey }));
          logger.info(
            {
              chatId: message.chatId,
              messageId: fileMessageId,
              fileName,
              threadReply: useThreadReply,
            },
            'Image message sent'
          );
          logOutgoing(fileMessageId, `[image: ${fileName}]`, 'image');
        } else if (VIDEO_EXTENSIONS.has(ext)) {
          // Upload video file — use msg_type:'media' with auto-generated cover image
          // Issue #2265: Proper video support via Feishu media message type.
          if (fileSize > MAX_FILE_SIZE) {
            throw new Error(
              `File too large: ${fileSize} bytes (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`
            );
          }

          const fileKey = await uploadFile(this.client, filePath, fileName, 'mp4');
          if (!fileKey) {
            logger.error(
              { chatId: message.chatId, fileName },
              'Failed to upload video, no file_key returned'
            );
            throw new Error(`Failed to upload video: ${fileName}`);
          }
          logger.info(
            { chatId: message.chatId, fileKey, fileName },
            'Video uploaded, extracting cover image'
          );

          // Extract first frame as cover image
          const coverResult = extractVideoCover(filePath);
          let imageKey: string | undefined;

          if (coverResult.success && coverResult.coverPath) {
            imageKey = await uploadImage(this.client, coverResult.coverPath);
            // Clean up temp cover file
            try {
              fs.unlinkSync(coverResult.coverPath);
            } catch {
              /* ignore */
            }
          }

          if (!imageKey) {
            // Fallback: send as generic file if cover extraction/upload fails
            logger.warn(
              { chatId: message.chatId, fileName, coverError: coverResult.error },
              'Cover image unavailable, sending video as file attachment'
            );
            fileMessageId = await sendFeishuMessage('file', JSON.stringify({ file_key: fileKey }));
          } else {
            // Send as media message with video + cover image
            fileMessageId = await sendFeishuMessage(
              'media',
              JSON.stringify({ file_key: fileKey, image_key: imageKey })
            );
          }
          logger.info(
            {
              chatId: message.chatId,
              messageId: fileMessageId,
              fileName,
              threadReply: useThreadReply,
              hasCover: !!imageKey,
            },
            'Video message sent'
          );
          logOutgoing(fileMessageId, `[video: ${fileName}]`, 'media');
        } else {
          // Upload file using shared utility
          if (fileSize > MAX_FILE_SIZE) {
            throw new Error(
              `File too large: ${fileSize} bytes (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`
            );
          }

          const fileType = EXT_TO_FEISHU_FILE_TYPE[ext] || 'stream';
          const fileKey = await uploadFile(this.client, filePath, fileName, fileType);
          if (!fileKey) {
            logger.error(
              { chatId: message.chatId, fileName },
              'Failed to upload file, no file_key returned'
            );
            throw new Error(`Failed to upload file: ${fileName}`);
          }
          logger.info(
            { chatId: message.chatId, fileKey, fileName, fileType },
            'File uploaded, sending message'
          );

          // Send file message
          fileMessageId = await sendFeishuMessage('file', JSON.stringify({ file_key: fileKey }));
          logger.info(
            {
              chatId: message.chatId,
              messageId: fileMessageId,
              fileName,
              threadReply: useThreadReply,
            },
            'File message sent'
          );
          logOutgoing(fileMessageId, `[file: ${fileName}]`, 'file');
        }
        return fileMessageId;
      }

      case 'done':
        logger.info({ chatId: message.chatId }, 'Task completed (done signal)');
        return;

      default:
        throw new Error(`Unsupported message type: ${(message as { type: string }).type}`);
    }
  }

  /**
   * Build Feishu post content with @mention tags.
   *
   * Constructs a rich text (post) message structure with @mention elements
   * followed by the text content. Used when sending messages with mentions
   * to properly render @mention tags in Feishu.
   *
   * Issue #1742: Bot-to-bot @mention support.
   *
   * @param mentions - Array of mention targets with openId and optional name
   * @param text - The text content to include after mentions
   * @returns Feishu post content structure
   */
  private buildPostContentWithMentions(
    mentions: Array<{ openId: string; name?: string }>,
    text: string
  ): Record<string, unknown> {
    const inlineElements: Array<Record<string, unknown>> = [];
    for (const mention of mentions) {
      inlineElements.push({ tag: 'at', user_id: mention.openId });
    }
    if (text) {
      inlineElements.push({ tag: 'text', text: ` ${text}` });
    }
    return {
      zh_cn: {
        title: '',
        content: [inlineElements],
      },
    };
  }

  protected checkHealth(): boolean {
    // Issue #2905: Simplified health check — just check connection state.
    // Previous custom health check (lastMessageReceivedAt) caused false positives.
    if (this.wsConnectionManager) {
      return this.wsConnectionManager.isHealthy();
    }
    return false;
  }

  /**
   * Upload an image to Feishu and return the image_key for card embedding.
   * Issue #2951: Used by MCP send_card to auto-translate local image paths.
   *
   * @param filePath - Local file path to upload
   * @returns Feishu image_key (e.g., "img_v3_xxx")
   * @throws Error if client not initialized or upload fails
   */
  async uploadImage(filePath: string): Promise<{ imageKey: string }> {
    if (!this.client) {
      throw new Error('Feishu client not initialized — call start() first');
    }

    const { size: fileSize } = await fsp.stat(filePath);
    if (fileSize > MAX_IMAGE_SIZE) {
      throw new Error(
        `Image file too large: ${fileSize} bytes (max ${MAX_IMAGE_SIZE / 1024 / 1024}MB)`
      );
    }

    // Issue #4132: reuse shared upload utility (dedup with the send path).
    const imageKey = await uploadImage(this.client, filePath);
    if (!imageKey) {
      throw new Error(`Failed to upload image: ${path.basename(filePath)}`);
    }

    logger.info(
      { imageKey, fileName: path.basename(filePath) },
      'Image uploaded for card embedding'
    );
    return { imageKey };
  }

  /**
   * Get the capabilities of Feishu channel.
   */
  getCapabilities(): ChannelCapabilities {
    const credentialsConfigured = Boolean(this.appId && this.appSecret);
    return {
      ...DEFAULT_CHANNEL_CAPABILITIES,
      supportsCard: true,
      supportsThread: true,
      supportsFile: true,
      supportsMarkdown: true,
      supportsMention: true,
      supportsUpdate: true,
      // Issue #4400 / #4208: native streaming is opt-in via the
      // streamingCard flag (default off → capability false → ChatAgent
      // degrades to sendMessage). When on, the streaming callbacks below
      // implement the Card Kit two-step flow driven by StreamingReplyDriver.
      // Issue #4510 (part 2): the p2p narrowing is built into the ChatAgent
      // gate (chatType === 'p2p'), not a scope capability — this channel has
      // no per-chat type state, so it only reports the raw flag.
      supportsStreaming: this.config.streamingCard === true,
      // Do not advertise channel-send tools to an agent when the channel
      // cannot authenticate. This prevents Codex from discovering a tool that
      // can only fail later with "Feishu credentials not configured".
      supportedMcpTools: credentialsConfigured
        ? ['send_text', 'send_card', 'send_interactive', 'send_file']
        : [],
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Issue #4400 (#4208 P2-c): Card Kit streaming wiring.
  //
  // Implements the IChannel streaming contract (startStreaming / streamText /
  // finalizeStreaming) the ChatAgent StreamingReplyDriver (#4399) drives. The
  // 2-step Card Kit flow (verified against the live Feishu API):
  //   1. startStreaming  → POST /cardkit/v1/cards (createCard) → card_id,
  //                        then IM-send the card to the chat by card_id
  //                        (msg_type "interactive", {type:'card',data:{card_id}}).
  //   2. streamText      → PUT /cards/{card_id}/elements/{element_id}/content
  //                        (full buffer; platform applies the typewriter delta).
  //   3. finalizeStreaming → PATCH /cards/{card_id}/settings (streaming_mode off).
  //
  // Safety: every step is gated on the streamingCard flag and degrades to
  // sendMessage on ANY failure — startStreaming returns null (or throws) and
  // the StreamingReplyDriver catches it, so a reply is never lost. The flag is
  // default-off, so today's flows are bit-identical until a gray rollout.
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Lazily build the Card Kit HTTP client from the tenant token env var that
   * feishu-channel already maintains. Returns null (→ sendMessage degrade) if
   * the token is missing rather than throwing, so a misconfigured deployment
   * never loses a reply.
   */
  private getCardKitClient(): FeishuCardKitClient | null {
    if (this.streamingCardKitClient) {
      return this.streamingCardKitClient;
    }
    try {
      this.streamingCardKitClient = createCardKitClientFromEnv();
      return this.streamingCardKitClient;
    } catch (err) {
      logger.warn(
        { err },
        'startStreaming: Card Kit client unavailable (tenant token missing?) — declining to sendMessage'
      );
      return null;
    }
  }

  /**
   * Begin a streaming reply: create a streaming card and send it to the chat.
   * Returns the card_id handle for subsequent streamText/finalizeStreaming
   * calls, or null to signal "degrade to sendMessage".
   */
  async startStreaming(chatId: string, parentMessageId?: string): Promise<string | null> {
    // Defense-in-depth: the ChatAgent already gates on supportsStreaming, but a
    // misconfigured capability must never silently activate streaming.
    // Issue #4510 (part 2): the p2p narrowing lives in the agent-side chatType
    // gate (this channel has no per-chat type state, and calling startStreaming
    // at all already means the agent decided this turn is streamable).
    if (this.config.streamingCard !== true) {
      return null;
    }
    const cardKitClient = this.getCardKitClient();
    if (!cardKitClient) {
      return null;
    }
    const larkClient = this.client;
    if (!larkClient) {
      logger.warn(
        { chatId },
        'startStreaming: lark IM client not ready — declining to sendMessage'
      );
      return null;
    }
    try {
      // Step 1: create the streaming card entity → card_id.
      const created = await cardKitClient.createCard(buildStreamingPlaceholderCard());
      const { cardId } = created;
      if (!cardId) {
        logger.warn(
          { chatId, created },
          'startStreaming: createCard returned no card_id — declining to sendMessage'
        );
        return null;
      }
      // Step 2: send the created card to the conversation by card_id. The same
      // app that created the card entity must send it. `root_id` keeps the card
      // inside a topic thread when present (mirrors sendMessage's create path).
      await larkClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
          ...(parentMessageId ? { root_id: parentMessageId } : {}),
        },
      });
      // createCard carries no sequence; the first PUT/PATCH uses sequence 1.
      this.streamingSequences.set(cardId, 0);
      logger.info(
        { chatId, cardId, parentMessageId },
        'startStreaming: streaming card created and sent to chat'
      );
      return cardId;
    } catch (err) {
      // Decline → the StreamingReplyDriver degrades this turn to sendMessage.
      logger.warn({ err, chatId }, 'startStreaming failed — degrading to sendMessage');
      return null;
    }
  }

  /**
   * Patch the in-flight card's reply element with the latest accumulated text.
   * The Card Kit `sequence` is strictly increasing per card; assigning it
   * synchronously (before the await) keeps it monotonic in emission order even
   * though the throttle fires PATCHes fire-and-forget. A rejected PATCH (e.g.
   * rare wire-level reorder → 300317) is swallowed by the driver and the
   * complete buffer is re-delivered on finalize.
   */
  async streamText(id: string, text: string): Promise<void> {
    if (!this.streamingSequences.has(id)) {
      // Unknown / already-finalized card — nothing to patch.
      return;
    }
    const client = this.streamingCardKitClient;
    if (!client) {
      return;
    }
    const sequence = (this.streamingSequences.get(id) ?? 0) + 1;
    this.streamingSequences.set(id, sequence);
    await client.updateElementContent(id, STREAMING_REPLY_ELEMENT_ID, text, sequence);
  }

  /**
   * Freeze the in-flight card (turn the breathing cursor off) and drop its
   * sequence state. Idempotent — safe on every turn-exit path.
   */
  async finalizeStreaming(id: string): Promise<void> {
    if (!this.streamingSequences.has(id)) {
      return;
    }
    const client = this.streamingCardKitClient;
    const sequence = (this.streamingSequences.get(id) ?? 0) + 1;
    this.streamingSequences.set(id, sequence);
    try {
      if (client) {
        await client.finalizeStreaming(id, sequence);
      }
      logger.info({ cardId: id, sequence }, 'finalizeStreaming: streaming card frozen');
    } catch (err) {
      // A failed freeze degrades (driver sendMessage-flushes the full buffer);
      // still clean up so the per-card counter does not leak.
      logger.warn({ err, cardId: id }, 'finalizeStreaming failed — driver will sendMessage-flush');
    } finally {
      this.streamingSequences.delete(id);
    }
  }

  /**
   * Check if this channel owns a given chatId.
   * Feishu chatIds follow specific patterns: "oc_" (group) or "ou_" (user).
   *
   * Issue #3824: Channel ownership query for post-restart routing.
   */
  ownsChatId(chatId: string): boolean {
    return chatId.startsWith('oc_') || chatId.startsWith('ou_');
  }

  // Delegate trigger mode methods to TriggerModeManager (Issue #2193: renamed from PassiveMode)
  isTriggerEnabled(chatId: string): boolean {
    return this.triggerModeManager.isTriggerEnabled(chatId);
  }

  setTriggerEnabled(chatId: string, enabled: boolean): void {
    this.triggerModeManager.setTriggerEnabled(chatId, enabled);
  }

  getTriggerEnabledChats(): string[] {
    return this.triggerModeManager.getTriggerEnabledChats();
  }

  /**
   * Get the TriggerModeManager instance.
   * Issue #2069: Allows external initialization from persisted records.
   * Issue #2193: Renamed from getPassiveModeManager.
   */
  getTriggerModeManager(): TriggerModeManager {
    return this.triggerModeManager;
  }

  /**
   * Get the InteractionManager for this channel.
   */
  getInteractionManager(): InteractionManager {
    return this.interactionManager;
  }

  /**
   * Set the WelcomeService for this channel.
   */
  setWelcomeService(service: WelcomeService): void {
    this.welcomeHandler.setWelcomeService(service);
  }

  /**
   * Handle incoming message event (for testing purposes).
   * @internal
   */
  handleMessageReceive(data: FeishuEventData): Promise<void> {
    return this.feishuMessageHandler.handleMessageReceive(data);
  }

  /**
   * Get bot info for IPC handlers.
   * Returns bot's open_id and app_id.
   */
  getBotInfo(): { openId: string; name?: string; avatarUrl?: string } {
    const botInfo = this.mentionDetector.getBotInfo();
    return {
      openId: botInfo?.open_id || '',
      name: 'Bot',
    };
  }

  // ─── WebSocket monitoring ──────────────────────────────────────────

  /**
   * Send a text message directly via Feishu API client, bypassing all routing/queue logic.
   *
   * Used as a last-resort fallback for error notifications when the normal message
   * flow has failed. This is intentionally simple — no offline queue, no routing,
   * no formatting — to maximize the chance of delivery.
   *
   * The notification itself is wrapped in try/catch to ensure it never throws.
   *
   * Issue #1357: Error notification for critical event handler failures.
   */
  private async notifyUserDirectly(chatId: string, text: string): Promise<void> {
    if (!this.client || !chatId) {
      return;
    }
    try {
      const resp = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      const msgId = resp.data?.message_id;
      if (msgId) {
        messageLogger.logOutgoingMessage(msgId, chatId, text, 'text').catch((err) => {
          logger.warn({ err, chatId, msgId }, 'Failed to log outgoing notification message');
        });
      }
    } catch (notifyErr) {
      // Never throw from error notification — just log the secondary failure
      logger.error({ err: notifyErr, chatId }, 'Failed to send error notification to user');
    }
  }

  /**
   * Get WebSocket connection metrics for observability.
   */
  getWsMetrics(): ReturnType<WsConnectionManager['getMetrics']> | undefined {
    return this.wsConnectionManager?.getMetrics();
  }

  /**
   * Queue a message for later delivery when the WebSocket is reconnecting.
   *
   * Messages older than `MAX_MESSAGE_AGE_MS` are discarded during flush.
   * Queue size is bounded by `MAX_SIZE` — oldest messages are dropped when full.
   */
  private queueOfflineMessage(message: OutgoingMessage): void {
    const maxSize = WS_HEALTH.OFFLINE_QUEUE.MAX_SIZE;

    // Drop oldest if queue is full
    if (this.offlineQueue.length >= maxSize) {
      const dropped = this.offlineQueue.shift();
      logger.warn(
        { chatId: dropped?.message.chatId, type: dropped?.message.type },
        'Offline queue full, dropping oldest message'
      );
    }

    this.offlineQueue.push({ message, queuedAt: Date.now() });

    logger.info(
      { chatId: message.chatId, type: message.type, queueSize: this.offlineQueue.length },
      'Message queued (WebSocket reconnecting)'
    );
  }

  /**
   * Flush the offline message queue after a successful reconnection.
   *
   * Filters out expired messages (older than `MAX_MESSAGE_AGE_MS`) and
   * sends the remaining ones via `doSendMessage()`. Errors on individual
   * messages are logged but do not prevent other messages from being sent.
   */
  private async flushOfflineQueue(): Promise<void> {
    if (this.offlineQueue.length === 0) {
      return;
    }

    const now = Date.now();
    const maxAge = WS_HEALTH.OFFLINE_QUEUE.MAX_MESSAGE_AGE_MS;
    const queue = this.offlineQueue;
    this.offlineQueue = [];

    // Filter out expired messages
    const valid = queue.filter((entry) => {
      const age = now - entry.queuedAt;
      if (age > maxAge) {
        logger.debug(
          { chatId: entry.message.chatId, type: entry.message.type, ageMs: age, maxAgeMs: maxAge },
          'Discarding expired offline message'
        );
        return false;
      }
      return true;
    });

    if (valid.length === 0) {
      return;
    }

    logger.info({ count: valid.length }, 'Flushing offline message queue');

    // Send each message; don't let individual failures block others
    for (const entry of valid) {
      try {
        await this.doSendMessage(entry.message);
      } catch (error) {
        logger.error(
          { err: error, chatId: entry.message.chatId, type: entry.message.type },
          'Failed to send queued message'
        );
      }
    }

    logger.info(
      { flushed: valid.length, dropped: queue.length - valid.length },
      'Offline queue flushed'
    );
  }
}
