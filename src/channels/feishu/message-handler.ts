/**
 * Message Handler for Feishu Channel.
 *
 * Handles incoming message processing, filtering, and routing.
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { DEDUPLICATION, REACTIONS, CHAT_HISTORY } from '../../config/constants.js';
import { createLogger } from '../../utils/logger.js';
import { attachmentManager, downloadFile } from '../../file-transfer/inbound/index.js';
import { messageLogger } from '../../feishu/message-logger.js';
import { FeishuFileHandler } from '../../platforms/feishu/feishu-file-handler.js';
import { FeishuMessageSender } from '../../platforms/feishu/feishu-message-sender.js';
import { getCommandRegistry } from '../../nodes/commands/command-registry.js';
import { filteredMessageForwarder } from '../../feishu/filtered-message-forwarder.js';
import type { FilterReason } from '../../config/types.js';
import { stripLeadingMentions } from '../../utils/mention-parser.js';
import type { FeishuEventData, FeishuMessageEvent } from '../../types/platform.js';
import type { IncomingMessage, ControlCommand } from '../types.js';
import { MentionDetector } from './mention-detector.js';
import { PassiveModeManager } from './passive-mode.js';

const logger = createLogger('FeishuMessageProcessor');

/**
 * Callbacks required from the channel for message handling.
 */
export interface MessageHandlerCallbacks {
  /** Check if the channel is running */
  isRunning: () => boolean;
  /** Emit an incoming message */
  emitMessage: (message: IncomingMessage) => Promise<void>;
  /** Emit a control command */
  emitControl: (command: ControlCommand) => Promise<{ success: boolean; message?: string }>;
  /** Send a message through the channel */
  sendMessage: (message: { chatId: string; type: string; text?: string; card?: Record<string, unknown> }) => Promise<void>;
  /** Get or create the Lark client */
  getClient: () => lark.Client;
  /** Get or create the message sender */
  getMessageSender: () => FeishuMessageSender | undefined;
}

/**
 * FeishuMessageProcessor - Handles incoming message processing.
 *
 * This class encapsulates all the logic for:
 * - Message deduplication
 * - File/image handling
 * - Text parsing
 * - Command detection
 * - Passive mode filtering
 * - Message routing
 *
 * Note: Renamed from MessageHandler to avoid conflict with BaseChannel.messageHandler
 */
export class FeishuMessageProcessor {
  private fileHandler: FeishuFileHandler;
  private readonly MAX_MESSAGE_AGE = DEDUPLICATION.MAX_MESSAGE_AGE;

  constructor(
    private callbacks: MessageHandlerCallbacks,
    private mentionDetector: MentionDetector,
    private passiveModeManager: PassiveModeManager
  ) {
    // Initialize FileHandler
    this.fileHandler = new FeishuFileHandler({
      attachmentManager,
      downloadFile: async (fileKey: string, messageType: string, fileName?: string, messageId?: string) => {
        const client = this.callbacks.getClient();
        if (!client) {
          logger.error({ fileKey }, 'Client not initialized for file download');
          return { success: false };
        }
        try {
          const filePath = await downloadFile(client, fileKey, messageType, fileName, messageId);
          return { success: true, filePath };
        } catch (error) {
          logger.error({ err: error, fileKey, messageType }, 'File download failed');
          return { success: false };
        }
      },
    });
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
    const messageSender = this.callbacks.getMessageSender();
    if (messageSender) {
      await messageSender.addReaction(messageId, REACTIONS.TYPING);
    }
  }

  /**
   * Check if the chat is a group chat.
   * Uses chat_type field from message event.
   *
   * @param chatType - Chat type from message event ('p2p', 'group', 'topic')
   * @returns true if it's a group chat
   */
  private isGroupChat(chatType?: string): boolean {
    return chatType === 'group' || chatType === 'topic';
  }

  /**
   * Forward a filtered message to the debug chat.
   * @see Issue #597
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
   * Issue #517: Include recent chat history when bot is mentioned in group chats.
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
    if (!this.callbacks.isRunning()) {return;}

    this.callbacks.getClient();

    const event = (data.event || data) as FeishuMessageEvent;
    const { message, sender } = event;

    if (!message) {return;}

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
      await this.handleFileMessage(message_id, chat_id, message_type as 'image' | 'file' | 'media', content, sender, create_time, threadId);
      return;
    }

    // Handle text and post messages
    if (message_type !== 'text' && message_type !== 'post') {
      logger.debug({ messageType: message_type }, 'Skipped unsupported message type');
      await this.forwardFilteredMessage('unsupported', message_id, chat_id, content, this.extractOpenId(sender), { messageType: message_type });
      return;
    }

    // Parse content
    const text = this.parseMessageContent(content, message_type);
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

    // Process the text message
    await this.processTextMessage(
      message_id,
      chat_id,
      chat_type,
      text,
      mentions,
      sender,
      create_time,
      threadId
    );
  }

  /**
   * Parse message content based on message type.
   */
  private parseMessageContent(content: string, messageType: string): string {
    try {
      const parsed = JSON.parse(content);
      if (messageType === 'text') {
        return parsed.text?.trim() || '';
      } else if (messageType === 'post' && parsed.content && Array.isArray(parsed.content)) {
        let text = '';
        for (const row of parsed.content) {
          if (Array.isArray(row)) {
            for (const segment of row) {
              if (segment?.tag === 'text' && segment.text) {
                text += segment.text;
              }
            }
          }
        }
        return text.trim();
      }
    } catch {
      logger.error('Failed to parse content');
    }
    return '';
  }

  /**
   * Handle file/image messages.
   */
  private async handleFileMessage(
    messageId: string,
    chatId: string,
    messageType: 'image' | 'file' | 'media',
    content: string,
    sender: { sender_type?: string; sender_id?: unknown } | undefined,
    createTime: number | undefined,
    threadId: string
  ): Promise<void> {
    logger.info(
      { chatId, messageType, messageId },
      'Processing file/image message'
    );
    const result = await this.fileHandler.handleFileMessage(chatId, messageType, content, messageId);
    if (!result.success) {
      logger.error(
        { chatId, messageType, messageId, error: result.error },
        'File/image processing failed - detailed error'
      );
      await this.callbacks.sendMessage({
        chatId,
        type: 'text',
        text: `❌ 处理${messageType === 'image' ? '图片' : '文件'}失败: ${result.error || '未知错误'}`,
      });
      return;
    }

    const attachments = attachmentManager.getAttachments(chatId);
    if (attachments.length > 0) {
      const latestAttachment = attachments[attachments.length - 1];
      const uploadPrompt = this.fileHandler.buildUploadPrompt(latestAttachment);

      await messageLogger.logIncomingMessage(
        messageId,
        this.extractOpenId(sender) || 'unknown',
        chatId,
        `[File uploaded: ${latestAttachment.fileName}]`,
        messageType,
        createTime
      );

      // Emit as incoming message
      await this.callbacks.emitMessage({
        messageId: `${messageId}-file`,
        chatId,
        userId: this.extractOpenId(sender),
        content: uploadPrompt,
        messageType: 'file',
        timestamp: createTime,
        threadId,
        attachments: [{
          fileName: latestAttachment.fileName || 'unknown',
          filePath: latestAttachment.localPath || '',
          mimeType: latestAttachment.mimeType,
        }],
      });
    }
  }

  /**
   * Process text message after initial parsing.
   */
  private async processTextMessage(
    messageId: string,
    chatId: string,
    chatType: string | undefined,
    text: string,
    mentions: FeishuMessageEvent['message']['mentions'] | undefined,
    sender: { sender_type?: string; sender_id?: unknown } | undefined,
    createTime: number | undefined,
    threadId: string
  ): Promise<void> {
    // Check for control commands
    const botMentioned = this.mentionDetector.isBotMentioned(mentions);

    // Get control commands from CommandRegistry
    const commandRegistry = getCommandRegistry();

    // Strip leading mentions to detect commands in messages like "@bot /help"
    const textWithoutMentions = stripLeadingMentions(text, mentions);

    // Group chat passive mode
    const isPassiveCommand = textWithoutMentions.startsWith('/passive');
    const passiveModeDisabled = this.passiveModeManager.isPassiveModeDisabled(chatId);
    if (this.isGroupChat(chatType) && !botMentioned && !passiveModeDisabled && !isPassiveCommand) {
      logger.debug(
        { messageId, chatId, chat_type: chatType },
        'Skipped group chat message without @mention (passive mode)'
      );
      await this.forwardFilteredMessage('passive_mode', messageId, chatId, text, this.extractOpenId(sender), { chat_type: chatType });
      return;
    }

    if (textWithoutMentions.startsWith('/')) {
      const handled = await this.handleCommand(
        textWithoutMentions,
        chatId,
        botMentioned,
        commandRegistry,
        sender
      );
      if (handled) {
        return;
      }
    }

    // Log if bot is mentioned with a non-control command
    if (botMentioned && textWithoutMentions.startsWith('/')) {
      logger.debug({ messageId, chatId, command: textWithoutMentions }, 'Bot mentioned with non-control command, passing to agent');
    }

    // Add typing reaction for messages that will be processed
    await this.addTypingReaction(messageId);

    // Get chat history context for passive mode
    const isPassiveModeTrigger = this.isGroupChat(chatType) && botMentioned;
    let chatHistoryContext: string | undefined;

    if (isPassiveModeTrigger) {
      chatHistoryContext = await this.getChatHistoryContext(chatId);
      logger.debug(
        { messageId, chatId, historyLength: chatHistoryContext?.length },
        'Including chat history context for passive mode trigger'
      );
    }

    // Emit as incoming message
    await this.callbacks.emitMessage({
      messageId,
      chatId,
      userId: this.extractOpenId(sender),
      content: text,
      messageType: chatType as any,
      timestamp: createTime,
      threadId,
      metadata: chatHistoryContext ? { chatHistoryContext } : undefined,
    });
  }

  /**
   * Handle command processing.
   * @returns true if command was handled and should stop further processing
   */
  private async handleCommand(
    textWithoutMentions: string,
    chatId: string,
    botMentioned: boolean,
    commandRegistry: ReturnType<typeof getCommandRegistry>,
    sender: { sender_type?: string; sender_id?: unknown } | undefined
  ): Promise<boolean> {
    const [command, ...args] = textWithoutMentions.slice(1).split(/\s+/);
    const cmd = command.toLowerCase();

    const isControlCommand = commandRegistry.has(cmd);

    if (isControlCommand || !botMentioned) {
      const response = await this.callbacks.emitControl({
        type: cmd as any,
        chatId,
        data: { args, rawText: textWithoutMentions, senderOpenId: this.extractOpenId(sender) },
      });

      if (response.success) {
        if (response.message) {
          await this.callbacks.sendMessage({
            chatId,
            type: 'text',
            text: response.message,
          });
        }
        return true;
      }

      if (botMentioned) {
        await this.callbacks.sendMessage({
          chatId,
          type: 'text',
          text: `❓ **未知命令**: /${cmd}\n\n使用 /help 查看可用命令列表。`,
        });
        return true;
      }
    } else {
      // Unknown command with @mention: show error instead of passing to agent
      await this.callbacks.sendMessage({
        chatId,
        type: 'text',
        text: `❓ **未知命令**: /${cmd}\n\n使用 /help 查看可用命令列表。`,
      });
      return true;
    }

    return false;
  }
}
