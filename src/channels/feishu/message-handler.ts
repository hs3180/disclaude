/**
 * Message Handler.
 *
 * Handles incoming message events and card actions for Feishu channel.
 * Issue #694: Extracted from feishu-channel.ts
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import { DEDUPLICATION, REACTIONS, CHAT_HISTORY } from '../../config/constants.js';
import { createLogger } from '../../utils/logger.js';
import { attachmentManager, downloadFile } from '../../file-transfer/inbound/index.js';
import { messageLogger } from '../../feishu/message-logger.js';
import { FeishuFileHandler } from '../../platforms/feishu/feishu-file-handler.js';
import { FeishuMessageSender } from '../../platforms/feishu/feishu-message-sender.js';
import { InteractionManager } from '../../platforms/feishu/interaction-manager.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import { getCommandRegistry } from '../../nodes/commands/command-registry.js';
import { resolvePendingInteraction } from '../../mcp/feishu-context-mcp.js';
import { generateInteractionPrompt } from '../../mcp/tools/interactive-message.js';
import { filteredMessageForwarder } from '../../feishu/filtered-message-forwarder.js';
import type { FilterReason } from '../../config/types.js';
import { stripLeadingMentions } from '../../utils/mention-parser.js';
import type {
  FeishuEventData,
  FeishuMessageEvent,
  FeishuCardActionEvent,
  FeishuCardActionEventData,
} from '../../types/platform.js';
import type { PassiveModeManager } from './passive-mode.js';
import type { MentionDetector } from './mention-detector.js';

const logger = createLogger('MessageHandler');

/**
 * Callback interface for emitting messages and control events.
 */
export interface MessageCallbacks {
  emitMessage: (message: {
    messageId: string;
    chatId: string;
    userId?: string;
    content: string;
    messageType: string;
    timestamp?: number;
    threadId?: string;
    metadata?: Record<string, unknown>;
    attachments?: Array<{ fileName: string; filePath: string; mimeType?: string }>;
  }) => Promise<void>;
  emitControl: (control: {
    type: string;
    chatId: string;
    data: { args: string[]; rawText: string; senderOpenId?: string };
  }) => Promise<{ success: boolean; message?: string }>;
  sendMessage: (message: { chatId: string; type: string; text?: string; card?: Record<string, unknown>; description?: string; threadId?: string; filePath?: string }) => Promise<void>;
}

/**
 * Message Handler.
 *
 * Handles incoming Feishu messages and card actions.
 */
export class MessageHandler {
  private appId: string;
  private appSecret: string;
  private client?: lark.Client;
  private messageSender?: FeishuMessageSender;
  private fileHandler: FeishuFileHandler;
  private interactionManager: InteractionManager;
  private passiveModeManager: PassiveModeManager;
  private mentionDetector: MentionDetector;
  private callbacks: MessageCallbacks;
  private isRunning: () => boolean;
  private controlHandler: boolean;
  private getHasControlHandler: () => boolean;

  private readonly MAX_MESSAGE_AGE = DEDUPLICATION.MAX_MESSAGE_AGE;

  /**
   * Create a MessageHandler.
   */
  constructor(options: {
    appId: string;
    appSecret: string;
    passiveModeManager: PassiveModeManager;
    mentionDetector: MentionDetector;
    interactionManager: InteractionManager;
    callbacks: MessageCallbacks;
    isRunning: () => boolean;
    hasControlHandler: () => boolean;
  }) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.passiveModeManager = options.passiveModeManager;
    this.mentionDetector = options.mentionDetector;
    this.interactionManager = options.interactionManager;
    this.callbacks = options.callbacks;
    this.isRunning = options.isRunning;
    this.getHasControlHandler = options.hasControlHandler;
    this.controlHandler = false;

    // Initialize FileHandler
    this.fileHandler = new FeishuFileHandler({
      attachmentManager,
      downloadFile: async (fileKey: string, messageType: string, fileName?: string, messageId?: string) => {
        if (!this.client) {
          logger.error({ fileKey }, 'Client not initialized for file download');
          return { success: false };
        }
        try {
          const filePath = await downloadFile(this.client, fileKey, messageType, fileName, messageId);
          return { success: true, filePath };
        } catch (error) {
          logger.error({ err: error, fileKey, messageType }, 'File download failed');
          return { success: false };
        }
      },
    });
  }

  /**
   * Initialize the handler (create client and message sender).
   */
  initialize(): void {
    this.client = createFeishuClient(this.appId, this.appSecret);
    this.messageSender = new FeishuMessageSender({
      client: this.client,
      logger,
    });
    // Initialize filtered message forwarder
    filteredMessageForwarder.setMessageSender({
      sendText: async (chatId: string, text: string) => {
        await this.messageSender!.sendText(chatId, text);
      },
    });
    // Set control handler availability from the callback
    this.controlHandler = this.getHasControlHandler();
    logger.debug({ controlHandler: this.controlHandler }, 'MessageHandler initialized');
  }

  /**
   * Set whether control handler is available.
   */
  setControlHandler(hasHandler: boolean): void {
    this.controlHandler = hasHandler;
  }

  /**
   * Get the client (for external use).
   */
  getClient(): lark.Client | undefined {
    return this.client;
  }

  /**
   * Get the message sender (for external use).
   */
  getMessageSender(): FeishuMessageSender | undefined {
    return this.messageSender;
  }

  /**
   * Clear the client (on stop).
   */
  clearClient(): void {
    this.client = undefined;
    this.messageSender = undefined;
  }

  /**
   * Extract open_id from sender object.
   */
  private extractOpenId(sender?: { sender_type?: string; sender_id?: unknown }): string | undefined {
    if (!sender?.sender_id) {
      return undefined;
    }
    if (typeof sender.sender_id === 'object' && sender.sender_id !== null) {
      const senderId = sender.sender_id as { open_id?: string };
      return senderId.open_id;
    }
    if (typeof sender.sender_id === 'string') {
      return sender.sender_id;
    }
    return undefined;
  }

  /**
   * Add typing reaction to indicate processing started.
   */
  private async addTypingReaction(messageId: string): Promise<void> {
    if (this.messageSender) {
      await this.messageSender.addReaction(messageId, REACTIONS.TYPING);
    }
  }

  /**
   * Check if the chat is a group chat.
   */
  private isGroupChat(chatType?: string): boolean {
    return chatType === 'group' || chatType === 'topic';
  }

  /**
   * Forward a filtered message to the debug chat.
   */
  private async forwardFilteredMessage(
    reason: FilterReason,
    messageId: string,
    chatId: string,
    content: string,
    userId?: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await filteredMessageForwarder.forward({
      messageId,
      chatId,
      userId,
      content,
      reason,
      metadata,
      timestamp: Date.now(),
    });
  }

  /**
   * Get formatted chat history context for passive mode.
   */
  private async getChatHistoryContext(chatId: string): Promise<string | undefined> {
    try {
      const rawHistory = await messageLogger.getChatHistory(chatId);

      if (!rawHistory || rawHistory.length === 0) {
        return undefined;
      }

      // Truncate if too long (keep the most recent content)
      let history = rawHistory;
      if (history.length > CHAT_HISTORY.MAX_CONTEXT_LENGTH) {
        // Try to truncate at a reasonable point (e.g., at a message boundary)
        const truncatePoint = history.lastIndexOf('## [', history.length - CHAT_HISTORY.MAX_CONTEXT_LENGTH);
        if (truncatePoint > 0) {
          history = `...(earlier messages truncated)...\n\n${history.slice(truncatePoint)}`;
        } else {
          // Fallback: just truncate from the end
          history = history.slice(-CHAT_HISTORY.MAX_CONTEXT_LENGTH);
          history = `...(earlier messages truncated)...\n\n${history.slice(history.indexOf('## ['))}`;
        }
      }

      return history;
    } catch (error) {
      logger.error({ err: error, chatId }, 'Failed to get chat history context');
      return undefined;
    }
  }

  /**
   * Handle incoming message event from WebSocket.
   */
  async handleMessageReceive(data: FeishuEventData): Promise<void> {
    if (!this.isRunning()) {
      return;
    }

    // Ensure client is initialized
    if (!this.client) {
      this.initialize();
    }

    const event = (data.event || data) as FeishuMessageEvent;
    const { message, sender } = event;

    if (!message) {
      return;
    }

    const { message_id, chat_id, chat_type, content, message_type, create_time, mentions } = message;

    // Bot replies to user message by setting parent_id = message_id
    // Feishu automatically handles thread affiliation
    const threadId = message_id;

    if (!message_id || !chat_id || !content || !message_type) {
      logger.warn('Missing required message fields');
      return;
    }

    // Deduplication
    if (messageLogger.isMessageProcessed(message_id)) {
      logger.debug({ messageId: message_id }, 'Skipped duplicate message');
      await this.forwardFilteredMessage('duplicate', message_id, chat_id, content, this.extractOpenId(sender));
      return;
    }

    // Ignore bot messages
    if (sender?.sender_type === 'app') {
      logger.debug('Skipped bot message');
      await this.forwardFilteredMessage('bot', message_id, chat_id, content);
      return;
    }

    // Check message age
    if (create_time) {
      const messageAge = Date.now() - create_time;
      if (messageAge > this.MAX_MESSAGE_AGE) {
        logger.debug({ messageId: message_id }, 'Skipped old message');
        await this.forwardFilteredMessage('old', message_id, chat_id, content, this.extractOpenId(sender), { age: messageAge });
        return;
      }
    }

    // Handle file/image messages
    if (message_type === 'image' || message_type === 'file' || message_type === 'media') {
      logger.info(
        { chatId: chat_id, messageType: message_type, messageId: message_id },
        'Processing file/image message'
      );
      const result = await this.fileHandler.handleFileMessage(chat_id, message_type, content, message_id);
      if (!result.success) {
        logger.error(
          { chatId: chat_id, messageType: message_type, messageId: message_id, error: result.error },
          'File/image processing failed - detailed error'
        );
        await this.callbacks.sendMessage({
          chatId: chat_id,
          type: 'text',
          text: `❌ 处理${message_type === 'image' ? '图片' : '文件'}失败: ${result.error || '未知错误'}`,
        });
        return;
      }

      const attachments = attachmentManager.getAttachments(chat_id);
      if (attachments.length > 0) {
        const latestAttachment = attachments[attachments.length - 1];
        const uploadPrompt = this.fileHandler.buildUploadPrompt(latestAttachment);

        await messageLogger.logIncomingMessage(
          message_id,
          this.extractOpenId(sender) || 'unknown',
          chat_id,
          `[File uploaded: ${latestAttachment.fileName}]`,
          message_type,
          create_time
        );

        // Emit as incoming message
        await this.callbacks.emitMessage({
          messageId: `${message_id}-file`,
          chatId: chat_id,
          userId: this.extractOpenId(sender),
          content: uploadPrompt,
          messageType: 'file',
          timestamp: create_time,
          threadId,
          attachments: [{
            fileName: latestAttachment.fileName || 'unknown',
            filePath: latestAttachment.localPath || '',
            mimeType: latestAttachment.mimeType,
          }],
        });
      }
      return;
    }

    // Handle text and post messages
    if (message_type !== 'text' && message_type !== 'post') {
      logger.debug({ messageType: message_type }, 'Skipped unsupported message type');
      await this.forwardFilteredMessage('unsupported', message_id, chat_id, content, this.extractOpenId(sender), { messageType: message_type });
      return;
    }

    // Parse content
    let text = '';
    try {
      const parsed = JSON.parse(content);
      if (message_type === 'text') {
        text = parsed.text?.trim() || '';
      } else if (message_type === 'post' && parsed.content && Array.isArray(parsed.content)) {
        for (const row of parsed.content) {
          if (Array.isArray(row)) {
            for (const segment of row) {
              if (segment?.tag === 'text' && segment.text) {
                text += segment.text;
              }
            }
          }
        }
        text = text.trim();
      }
    } catch {
      logger.error('Failed to parse content');
      return;
    }

    if (!text) {
      logger.debug('Skipped empty text');
      await this.forwardFilteredMessage('empty', message_id, chat_id, content, this.extractOpenId(sender));
      return;
    }

    logger.info({ messageId: message_id, chatId: chat_id }, 'Message received');

    // Log message
    await messageLogger.logIncomingMessage(
      message_id,
      this.extractOpenId(sender) || 'unknown',
      chat_id,
      text,
      message_type,
      create_time
    );

    // Check for control commands
    const botMentioned = this.mentionDetector.isBotMentioned(mentions);

    // Get control commands from CommandRegistry
    const commandRegistry = getCommandRegistry();

    // Strip leading mentions to detect commands in messages like "@bot /help"
    const textWithoutMentions = stripLeadingMentions(text, mentions);

    // Group chat passive mode
    const isPassiveCommand = textWithoutMentions.startsWith('/passive');
    const passiveModeDisabled = this.passiveModeManager.isPassiveModeDisabled(chat_id);
    if (this.isGroupChat(chat_type) && !botMentioned && !passiveModeDisabled && !isPassiveCommand) {
      logger.debug(
        { messageId: message_id, chatId: chat_id, chat_type },
        'Skipped group chat message without @mention (passive mode)'
      );
      await this.forwardFilteredMessage('passive_mode', message_id, chat_id, text, this.extractOpenId(sender), { chat_type });
      return;
    }

    if (textWithoutMentions.startsWith('/')) {
      const [command, ...args] = textWithoutMentions.slice(1).split(/\s+/);
      const cmd = command.toLowerCase();

      const isControlCommand = commandRegistry.has(cmd);

      if (isControlCommand || !botMentioned) {
        if (this.controlHandler) {
          const response = await this.callbacks.emitControl({
            type: cmd,
            chatId: chat_id,
            data: { args, rawText: textWithoutMentions, senderOpenId: this.extractOpenId(sender) },
          });

          if (response.success) {
            if (response.message) {
              await this.callbacks.sendMessage({
                chatId: chat_id,
                type: 'text',
                text: response.message,
              });
            }
            return;
          }
          if (botMentioned) {
            await this.callbacks.sendMessage({
              chatId: chat_id,
              type: 'text',
              text: `❓ **未知命令**: /${cmd}\n\n使用 /help 查看可用命令列表。`,
            });
            return;
          }
        }

        // Default command handling if no control handler registered
        if (cmd === 'reset') {
          await this.callbacks.sendMessage({
            chatId: chat_id,
            type: 'text',
            text: '✅ **对话已重置**\n\n新的会话已启动，之前的上下文已清除。',
          });
          return;
        }

        if (cmd === 'status') {
          await this.callbacks.sendMessage({
            chatId: chat_id,
            type: 'text',
            text: '📊 **状态**\n\nChannel: Feishu\nStatus: running',
          });
          return;
        }
      } else {
        await this.callbacks.sendMessage({
          chatId: chat_id,
          type: 'text',
          text: `❓ **未知命令**: /${cmd}\n\n使用 /help 查看可用命令列表。`,
        });
        return;
      }
    }

    // Log if bot is mentioned with a non-control command (for debugging)
    if (botMentioned && textWithoutMentions.startsWith('/')) {
      logger.debug({ messageId: message_id, chatId: chat_id, command: textWithoutMentions }, 'Bot mentioned with non-control command, passing to agent');
    }

    // Add typing reaction only for messages that will be processed
    await this.addTypingReaction(message_id);

    // Get chat history context for passive mode
    const isPassiveModeTrigger = this.isGroupChat(chat_type) && botMentioned;
    let chatHistoryContext: string | undefined;

    if (isPassiveModeTrigger) {
      chatHistoryContext = await this.getChatHistoryContext(chat_id);
      logger.debug(
        { messageId: message_id, chatId: chat_id, historyLength: chatHistoryContext?.length },
        'Including chat history context for passive mode trigger'
      );
    }

    // Emit as incoming message
    await this.callbacks.emitMessage({
      messageId: message_id,
      chatId: chat_id,
      userId: this.extractOpenId(sender),
      content: text,
      messageType: message_type,
      timestamp: create_time,
      threadId,
      metadata: chatHistoryContext ? { chatHistoryContext } : undefined,
    });
  }

  /**
   * Handle card action event from WebSocket.
   */
  async handleCardAction(data: FeishuCardActionEventData): Promise<void> {
    if (!this.isRunning()) {
      return;
    }

    const event = (data.event || data) as FeishuCardActionEvent;
    const { action, message_id, chat_id, user } = event;

    if (!action || !message_id || !chat_id) {
      logger.warn('Missing required card action fields');
      return;
    }

    logger.info(
      {
        messageId: message_id,
        chatId: chat_id,
        actionType: action.type,
        actionValue: action.value,
        trigger: action.trigger,
        userId: user?.sender_id?.open_id,
      },
      'Card action received'
    );

    // First, try to resolve any pending wait_for_interaction calls
    const resolved = resolvePendingInteraction(
      message_id,
      action.value,
      action.type,
      user?.sender_id?.open_id || 'unknown'
    );

    if (resolved) {
      logger.debug({ messageId: message_id }, 'Card action resolved pending interaction');
    }

    // Always emit card action as a message to the agent
    try {
      // Try to get a pre-defined prompt template first
      const promptFromTemplate = generateInteractionPrompt(
        message_id,
        action.value,
        action.text,
        action.type
      );

      // Use the template prompt if available, otherwise use default message
      const messageContent = promptFromTemplate || (() => {
        const buttonText = action.text || action.value;
        return `User clicked '${buttonText}' button`;
      })();

      await this.callbacks.emitMessage({
        messageId: `${message_id}-${action.value}`,
        chatId: chat_id,
        userId: user?.sender_id?.open_id,
        content: messageContent,
        messageType: 'card',
        timestamp: Date.now(),
        metadata: {
          cardAction: action,
          cardMessageId: message_id,
          wasPendingInteraction: resolved,
          usedPromptTemplate: !!promptFromTemplate,
        },
      });

      logger.debug(
        { messageId: message_id, chatId: chat_id, actionValue: action.value, usedTemplate: !!promptFromTemplate },
        'Card action emitted as message to agent'
      );
    } catch (error) {
      logger.error({ err: error, messageId: message_id, chatId: chat_id }, 'Failed to emit card action message');
    }

    // Return early if resolved
    if (resolved) {
      return;
    }

    try {
      // Try to handle via InteractionManager
      const handled = await this.interactionManager.handleAction(event, async (defaultEvent) => {
        // Try to get a pre-defined prompt template first
        const promptFromTemplate = generateInteractionPrompt(
          defaultEvent.message_id,
          defaultEvent.action.value,
          defaultEvent.action.text,
          defaultEvent.action.type
        );

        // Use the template prompt if available, otherwise use default message
        const messageContent = promptFromTemplate || (() => {
          const buttonText = defaultEvent.action.text || defaultEvent.action.value;
          return `The user clicked '${buttonText}' button`;
        })();

        await this.callbacks.emitMessage({
          messageId: `${defaultEvent.message_id}-${defaultEvent.action.value}`,
          chatId: defaultEvent.chat_id,
          userId: defaultEvent.user?.sender_id?.open_id,
          content: messageContent,
          messageType: 'card',
          timestamp: Date.now(),
          metadata: {
            cardAction: defaultEvent.action,
            cardMessageId: defaultEvent.message_id,
            usedPromptTemplate: !!promptFromTemplate,
          },
        });
      });

      if (!handled) {
        logger.debug(
          { messageId: message_id, actionValue: action.value },
          'Card action not handled'
        );
      }
    } catch (error) {
      logger.error({ err: error, messageId: message_id, chatId: chat_id }, 'Card action handler error');

      // Notify user of the error
      await this.callbacks.sendMessage({
        chatId: chat_id,
        type: 'text',
        text: `❌ 处理卡片操作时发生错误：${error instanceof Error ? error.message : '未知错误'}`,
      });
    }
  }
}
