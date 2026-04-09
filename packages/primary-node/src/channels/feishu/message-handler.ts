/**
 * Message Handler.
 *
 * Handles incoming message events and card actions for Feishu channel.
 * Issue #694: Extracted from feishu-channel.ts
 *
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type * as lark from '@larksuiteoapi/node-sdk';
import {
  Config,
  DEDUPLICATION,
  REACTIONS,
  CHAT_HISTORY,
  createLogger,
  stripLeadingMentions,
  ensureFileExtension,
  type FeishuEventData,
  type FeishuMessageEvent,
  type FeishuCardActionEvent,
  type FeishuCardActionEventData,
  type IncomingMessage,
  type MessageAttachment,
  type ControlCommand,
  type ControlCommandType,
  type ControlResponse,
} from '@disclaude/core';
import { InteractionManager } from '../../platforms/feishu/interaction-manager.js';
import { extractCardTextContent } from '../../platforms/feishu/card-builders/card-text-extractor.js';
import { messageLogger } from './message-logger.js';
import type { TriggerModeManager } from './trigger-mode.js';
import type { MentionDetector } from './mention-detector.js';

const logger = createLogger('MessageHandler');

/**
 * Callback interface for emitting messages and control events.
 */
export interface MessageCallbacks {
  emitMessage: (message: IncomingMessage) => Promise<void>;
  emitControl: (control: ControlCommand) => Promise<ControlResponse>;
  sendMessage: (message: { chatId: string; type: string; text?: string; card?: Record<string, unknown>; description?: string; threadId?: string; filePath?: string }) => Promise<void>;
  /**
   * Route card action to Worker Node if applicable.
   * Issue #1629: Includes resolvedPrompt from InteractiveContextStore
   * so remote Worker Nodes receive the contextual prompt.
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
  }) => Promise<boolean>;
  /**
   * Resolve action prompt for a card action.
   * Issue #1572: Looks up the prompt template from InteractiveContextStore.
   *
   * @param messageId - Card message ID (from Feishu callback)
   * @param chatId - Chat ID
   * @param actionValue - Action value from the button
   * @param actionText - Action display text (optional)
   * @returns The generated prompt, or undefined if no template found
   */
  resolveActionPrompt?: (
    messageId: string,
    chatId: string,
    actionValue: string,
    actionText?: string,
  ) => string | undefined;
}

/**
 * Result of resolving a quoted/replied message.
 *
 * @property text - Formatted quoted message text for display in the prompt
 * @property attachment - Downloaded file attachment (only for image/file/media messages)
 */
interface QuotedMessageResult {
  text: string;
  attachment?: MessageAttachment;
}

/**
 * Message Handler.
 *
 * Handles incoming Feishu messages and card actions.
 */
export class MessageHandler {
  private client?: lark.Client;
  private interactionManager: InteractionManager;
  private triggerModeManager: TriggerModeManager;
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
    passiveModeManager: TriggerModeManager;
    mentionDetector: MentionDetector;
    interactionManager: InteractionManager;
    callbacks: MessageCallbacks;
    isRunning: () => boolean;
    hasControlHandler: () => boolean;
  }) {
    this.triggerModeManager = options.passiveModeManager;
    this.mentionDetector = options.mentionDetector;
    this.interactionManager = options.interactionManager;
    this.callbacks = options.callbacks;
    this.isRunning = options.isRunning;
    this.getHasControlHandler = options.hasControlHandler;
    this.controlHandler = false;
  }

  /**
   * Initialize the handler with client.
   */
  initialize(client: lark.Client): void {
    this.client = client;
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
   * Clear the client (on stop).
   */
  clearClient(): void {
    this.client = undefined;
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
   * Parse post message content with support for rich text elements.
   * Issue #846: Add support for code_block, pre, and chat_history tags.
   *
   * Supported tags:
   * - text: Plain text
   * - a: Links
   * - at: Mentions
   * - img: Images (represented as [图片])
   * - code_block: Code blocks (converted to markdown format)
   * - pre: Preformatted text (converted to markdown format)
   * - chat_history: Forwarded chat history
   */
  private parsePostContent(content: unknown[]): string {
    let text = '';

    for (const row of content) {
      if (!Array.isArray(row)) {
        continue;
      }
      for (const segment of row) {
        if (!segment?.tag) {
          continue;
        }

        switch (segment.tag) {
          case 'text':
            text += segment.text || '';
            break;

          case 'a':
            text += segment.text || segment.href || '';
            break;

          case 'at':
            text += `@${segment.text || segment.user_id || 'user'}`;
            break;

          case 'img':
            text += '[图片]';
            break;

          case 'code_block':
          case 'pre': {
            // Extract code content and language
            const lang = segment.language || '';
            const code = segment.text || segment.content || '';
            if (code) {
              text += `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
            }
            break;
          }

          case 'chat_history': {
            // Parse forwarded chat history content
            const historyContent = this.parseChatHistoryElement(segment);
            if (historyContent) {
              text += historyContent;
            }
            break;
          }

          default:
            // For unknown tags, try to extract text if available
            if (segment.text) {
              text += segment.text;
            }
        }
      }
    }

    return text.trim();
  }

  /**
   * Parse chat_history element from post message.
   * Issue #846: Support for forwarded chat history within post messages.
   */
  private parseChatHistoryElement(element: { [key: string]: unknown }): string {
    const messages = element.messages || element.content;
    if (!Array.isArray(messages)) {
      return '';
    }

    let result = '\n--- 转发的聊天记录 ---\n';

    for (const msg of messages) {
      const sender = msg.sender || msg.from || '未知发送者';
      const content = msg.content || msg.text || msg.body || '';
      const time = msg.create_time || msg.timestamp || '';

      if (time) {
        result += `[${time}] `;
      }
      result += `${sender}: ${content}\n`;
    }

    result += '--- 转发结束 ---\n';
    return result;
  }

  /**
   * Parse share_chat message content (merged/forwarded messages).
   * Issue #846: Support for share_chat message type.
   *
   * share_chat messages contain forwarded chat history with multiple messages.
   */
  private parseShareChatContent(parsed: { [key: string]: unknown }): string {
    // Check for chat_history in the message content
    const chatHistory = parsed.chat_history || parsed.messages || [];
    const title = parsed.title || '转发的聊天记录';

    if (!Array.isArray(chatHistory) || chatHistory.length === 0) {
      // If no structured history, try to extract from body or text
      const body = parsed.body || parsed.text || '';
      if (body) {
        return `[转发消息] ${body}`;
      }
      return '[转发消息] 无法解析内容';
    }

    let result = `\n### 📋 ${title}\n\n`;

    for (const msg of chatHistory) {
      const msgData = msg as { [key: string]: unknown };
      const sender = this.extractSenderName(msgData);
      const content = this.extractMessageContent(msgData);
      const time = this.formatMessageTime(msgData);

      if (time) {
        result += `**[${time}]** `;
      }
      result += `**${sender}**: ${content}\n\n`;
    }

    return result.trim();
  }

  /**
   * Extract sender name from message data.
   */
  private extractSenderName(msgData: { [key: string]: unknown }): string {
    // Try various possible sender field names
    const sender = msgData.sender
      || msgData.from
      || msgData.sender_name
      || msgData.author
      || msgData.user
      || '未知发送者';

    if (typeof sender === 'string') {
      return sender;
    }

    if (typeof sender === 'object' && sender !== null) {
      const senderObj = sender as { [key: string]: unknown };
      return String(senderObj.name || senderObj.nickname || senderObj.open_id || '未知发送者');
    }

    return '未知发送者';
  }

  /**
   * Extract message content from message data.
   */
  private extractMessageContent(msgData: { [key: string]: unknown }): string {
    // Try various possible content field names
    const content = msgData.content
      || msgData.body
      || msgData.text
      || msgData.message
      || '';

    if (typeof content === 'string') {
      return content;
    }

    if (typeof content === 'object' && content !== null) {
      // Handle nested content structure
      const contentObj = content as { [key: string]: unknown };
      if (contentObj.text) {
        return String(contentObj.text);
      }
      // For post messages, parse the content
      if (Array.isArray(contentObj.content)) {
        return this.parsePostContent(contentObj.content);
      }
    }

    return String(content);
  }

  /**
   * Format message timestamp to readable string.
   */
  private formatMessageTime(msgData: { [key: string]: unknown }): string {
    const timestamp = msgData.create_time
      || msgData.timestamp
      || msgData.time
      || msgData.created_at;

    if (!timestamp) {
      return '';
    }

    try {
      // Handle Unix timestamp (seconds or milliseconds)
      let ms: number;
      if (typeof timestamp === 'number') {
        ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
      } else if (typeof timestamp === 'string') {
        ms = parseInt(timestamp, 10);
        if (ms > 1e12) {
          // Already in milliseconds
        } else {
          ms *= 1000;
        }
      } else {
        return '';
      }

      const date = new Date(ms);
      if (isNaN(date.getTime())) {
        return '';
      }

      // Format as HH:MM
      return date.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  }

  /**
   * Add typing reaction to indicate processing started.
   */
  private async addTypingReaction(messageId: string): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      await this.client.im.messageReaction.create({
        path: {
          message_id: messageId,
        },
        data: {
          reaction_type: {
            emoji_type: REACTIONS.TYPING,
          },
        },
      });
    } catch (error) {
      logger.debug({ err: error, messageId }, 'Failed to add typing reaction');
    }
  }

  /**
   * Check if the chat is a group chat.
   */
  private isGroupChat(chatType?: string): boolean {
    return chatType === 'group' || chatType === 'topic';
  }

  /**
   * Forward a filtered message (simplified - just logs for now).
   */
  private forwardFilteredMessage(
    reason: string,
    messageId: string,
    chatId: string,
    _content: string,
    userId?: string,
    metadata?: Record<string, unknown>
  ): void {
    logger.debug({ reason, messageId, chatId, userId, metadata }, 'Message filtered');
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

      // Truncate if too long
      let history = rawHistory;
      if (history.length > CHAT_HISTORY.MAX_CONTEXT_LENGTH) {
        const truncatePoint = history.lastIndexOf('## [', history.length - CHAT_HISTORY.MAX_CONTEXT_LENGTH);
        if (truncatePoint > 0) {
          history = `...(earlier messages truncated)...\n\n${history.slice(truncatePoint)}`;
        } else {
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
   * Get quoted/replied message content.
   *
   * Supports text, post, interactive, image, file, and media message types.
   * For image/file/media, downloads the file and returns both a text prompt
   * and a structured MessageAttachment so the agent can access the file.
   */
  private async getQuotedMessageContext(parentId: string): Promise<QuotedMessageResult | undefined> {
    if (!this.client) {
      return undefined;
    }

    try {
      const response = await this.client.im.message.get({
        path: {
          message_id: parentId,
        },
        params: {
          user_id_type: 'open_id',
        },
      });

      const message = response.data as { message?: { message_type?: string; content?: string; message_id?: string } };
      if (!message?.message) {
        return undefined;
      }

      const msgType = message.message.message_type;
      const msgContent = message.message.content || '{}';
      const msgId = message.message.message_id || parentId;

      let quotedText = '';
      try {
        if (msgType === 'text') {
          const parsed = JSON.parse(msgContent);
          quotedText = parsed.text || msgContent || '';
        } else if (msgType === 'post') {
          const parsed = JSON.parse(msgContent);
          if (parsed.content && Array.isArray(parsed.content)) {
            for (const row of parsed.content) {
              if (Array.isArray(row)) {
                for (const segment of row) {
                  if (segment?.tag === 'text' && segment.text) {
                    quotedText += segment.text;
                  }
                }
              }
            }
          }
        } else if (msgType === 'interactive') {
          // Issue #1711: Extract text from interactive card messages
          const parsed = JSON.parse(msgContent);
          quotedText = extractCardTextContent(parsed);
        } else if (msgType === 'image' || msgType === 'file' || msgType === 'media' || msgType === 'audio') {
          return await this.handleQuotedFileMessage(msgType, msgContent, msgId);
        }
      } catch {
        quotedText = msgContent || '';
      }

      if (!quotedText.trim()) {
        return undefined;
      }

      return { text: `> **引用的消息**:\n> ${quotedText.split('\n').join('\n> ')}` };
    } catch (error) {
      logger.debug({ err: error, parentId }, 'Failed to get quoted message context');
      return undefined;
    }
  }

  /**
   * Handle quoted/replied file/image/media message.
   *
   * Downloads the file to workspace and returns both a descriptive prompt
   * and a structured MessageAttachment so the agent can access the file.
   */
  private async handleQuotedFileMessage(
    messageType: string,
    content: string,
    messageId: string,
  ): Promise<QuotedMessageResult | undefined> {
    let fileKey: string | undefined;
    let fileName: string | undefined;

    try {
      const parsed = JSON.parse(content);
      if (messageType === 'image') {
        fileKey = parsed.image_key;
        fileName = `image_${fileKey}`;
      } else if (messageType === 'audio') {
        // Issue #1966: Audio messages use file_key in content JSON
        fileKey = parsed.file_key;
        fileName = parsed.file_name || `audio_${fileKey}`;
      } else {
        fileKey = parsed.file_key;
        fileName = parsed.file_name || `file_${fileKey}`;
      }
    } catch {
      logger.warn({ content, messageType, messageId }, 'Failed to parse quoted file message content');
      return undefined;
    }

    if (!fileKey) {
      logger.warn({ messageType, messageId }, 'No file_key found in quoted message');
      return undefined;
    }

    // Download file to workspace/downloads directory
    let localPath: string | undefined;
    if (this.client) {
      try {
        const downloadDir = path.join(Config.getWorkspaceDir(), 'downloads');
        await fs.mkdir(downloadDir, { recursive: true });
        localPath = path.join(downloadDir, String(fileName || fileKey));

        logger.info({ fileKey, fileName, localPath, quotedMessageId: messageId }, 'Downloading quoted file from Feishu');

        const response = await this.client.im.messageResource.get({
          path: { message_id: messageId, file_key: fileKey },
          params: { type: messageType },
        });
        await response.writeFile(localPath);

        // Issue #1637: Ensure file has correct extension based on magic bytes
        const correctedPath = await this.correctFileExtension(localPath);
        if (correctedPath !== localPath) {
          localPath = correctedPath;
          fileName = path.basename(correctedPath);
        }

        logger.info({ fileKey, localPath }, 'Quoted file downloaded successfully');
      } catch (downloadError) {
        logger.error({ err: downloadError, fileKey, messageId }, 'Failed to download quoted file');
      }
    }

    const typeLabel = messageType === 'image' ? '图片' : messageType === 'file' ? '文件' : messageType === 'audio' ? '语音消息' : '媒体文件';
    if (!localPath) {
      return {
        text: `> **引用的消息**: [${typeLabel}] ${fileName || fileKey}（下载失败，无法查看内容）`,
      };
    }

    return {
      text: `> **引用的消息**: [${typeLabel}] ${fileName || fileKey}`,
      attachment: {
        fileName: fileName || fileKey,
        filePath: localPath,
      },
    };
  }

  /**
   * Handle incoming message event from WebSocket.
   */
  async handleMessageReceive(data: FeishuEventData): Promise<void> {
    if (!this.isRunning()) {
      return;
    }

    const event = (data.event || data) as FeishuMessageEvent;
    const { message, sender } = event;

    if (!message) {
      return;
    }

    const { message_id, chat_id, chat_type, content, message_type, create_time, mentions, parent_id } = message;
    const threadId = message_id;

    if (!message_id || !chat_id || !content || !message_type) {
      logger.warn('Missing required message fields');
      return;
    }

    // Deduplication
    if (messageLogger.isMessageProcessed(message_id)) {
      logger.debug({ messageId: message_id }, 'Skipped duplicate message');
      this.forwardFilteredMessage('duplicate', message_id, chat_id, content, this.extractOpenId(sender));
      return;
    }

    // Ignore bot messages UNLESS the sender bot @mentions our bot (bot-to-bot communication)
    // Issue #1742: Allow bot-to-bot @mention conversations
    if (sender?.sender_type === 'app') {
      const botMentionsUs = this.mentionDetector.isBotMentioned(mentions);
      if (!botMentionsUs) {
        logger.debug('Skipped bot message (not mentioning our bot)');
        this.forwardFilteredMessage('bot', message_id, chat_id, content);
        return;
      }
      logger.info({ messageId: message_id, chatId: chat_id }, 'Bot message mentions our bot, allowing through');
    }

    // Check message age
    if (create_time) {
      const messageAge = Date.now() - create_time;
      if (messageAge > this.MAX_MESSAGE_AGE) {
        logger.debug({ messageId: message_id }, 'Skipped old message');
        this.forwardFilteredMessage('old', message_id, chat_id, content, this.extractOpenId(sender), { age: messageAge });
        return;
      }
    }

    // Handle file/image messages - download to workspace and include path in prompt
    if (message_type === 'image' || message_type === 'file' || message_type === 'media' || message_type === 'audio') {
      logger.info({ chatId: chat_id, messageType: message_type, messageId: message_id }, 'File/image message received');

      // Parse content to extract file_key and file_name
      let fileKey: string | undefined;
      let fileName: string | undefined;
      try {
        const parsed = JSON.parse(content);
        if (message_type === 'image') {
          fileKey = parsed.image_key;
          fileName = `image_${fileKey}`;
        } else if (message_type === 'audio') {
          // Issue #1966: Audio messages use file_key in content JSON
          fileKey = parsed.file_key;
          fileName = parsed.file_name || `audio_${fileKey}`;
        } else {
          fileKey = parsed.file_key;
          fileName = parsed.file_name || `file_${fileKey}`;
        }
      } catch (parseError) {
        logger.error({ err: parseError, content, messageType: message_type }, 'Failed to parse file message content');
      }

      if (!fileKey) {
        logger.warn({ messageType: message_type, messageId: message_id }, 'No file_key found in message');
        return;
      }

      // Download file to workspace/downloads directory
      let localPath: string | undefined;
      if (this.client) {
        try {
          const downloadDir = path.join(Config.getWorkspaceDir(), 'downloads');
          await fs.mkdir(downloadDir, { recursive: true });
          localPath = path.join(downloadDir, String(fileName || fileKey));

          logger.info({ fileKey, fileName, localPath }, 'Downloading file from Feishu');

          const response = await this.client.im.messageResource.get({
            path: { message_id, file_key: fileKey },
            params: { type: message_type },
          });
          await response.writeFile(localPath);

          // Issue #1637: Ensure file has correct extension based on magic bytes
          const correctedPath = await this.correctFileExtension(localPath);
          if (correctedPath !== localPath) {
            localPath = correctedPath;
            fileName = path.basename(correctedPath);
          }

          logger.info({ fileKey, localPath }, 'File downloaded successfully');
        } catch (downloadError) {
          logger.error({ err: downloadError, fileKey, messageId: message_id }, 'Failed to download file');
        }
      }

      // Log the incoming message
      await messageLogger.logIncomingMessage(
        message_id,
        this.extractOpenId(sender) || 'unknown',
        chat_id,
        `[${message_type} received]${localPath ? ` → ${localPath}` : ''}`,
        message_type,
        create_time
      );

      await this.addTypingReaction(message_id);

      // Build content with file path for the agent prompt
      const typeLabel = message_type === 'image' ? '图片' : message_type === 'file' ? '文件' : message_type === 'audio' ? '语音消息' : '媒体文件';
      const filePrompt = localPath
        ? `用户${message_type === 'audio' ? '发送了一段' : '上传了一个'}${typeLabel}：${fileName || fileKey}\n\n文件已下载到本地: ${localPath}\n\n请使用 Read 工具读取该文件来查看内容。${message_type === 'image' ? '这是一个图片文件，Read 工具可以直接查看图片内容。' : message_type === 'audio' ? '这是一个音频文件。你可以根据自身能力处理音频（如调用 ASR 工具转录、分析音频特征等）。' : ''}`
        : `用户${message_type === 'audio' ? '发送了一段' : '上传了一个'}${typeLabel}，但下载失败。`;

      await this.callbacks.emitMessage({
        messageId: `${message_id}-${message_type === 'audio' ? 'audio' : 'file'}`,
        chatId: chat_id,
        userId: this.extractOpenId(sender),
        content: filePrompt,
        messageType: message_type === 'audio' ? 'audio' : 'file',
        timestamp: create_time,
        threadId,
        attachments: localPath ? [{ fileName: fileName || fileKey, filePath: localPath }] : undefined,
      });
      return;
    }

    // Handle text, post, and share_chat messages
    // Issue #846: Add support for share_chat (forwarded chat history) messages
    if (message_type !== 'text' && message_type !== 'post' && message_type !== 'share_chat') {
      logger.debug({ messageType: message_type }, 'Skipped unsupported message type');
      this.forwardFilteredMessage('unsupported', message_id, chat_id, content, this.extractOpenId(sender), { messageType: message_type });
      return;
    }

    // Parse content
    let text = '';
    try {
      const parsed = JSON.parse(content);
      if (message_type === 'text') {
        text = parsed.text?.trim() || '';
      } else if (message_type === 'post' && parsed.content && Array.isArray(parsed.content)) {
        text = this.parsePostContent(parsed.content);
      } else if (message_type === 'share_chat') {
        // Issue #846: Parse share_chat (forwarded/merged chat history) messages
        text = this.parseShareChatContent(parsed);
      }
    } catch {
      logger.error('Failed to parse content');
      return;
    }

    if (!text) {
      logger.debug('Skipped empty text');
      this.forwardFilteredMessage('empty', message_id, chat_id, content, this.extractOpenId(sender));
      return;
    }

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
    const textWithoutMentions = stripLeadingMentions(text, mentions);

    // Group chat trigger mode
    const isTriggerCommand = textWithoutMentions.startsWith('/trigger');
    const isAlwaysTrigger = this.triggerModeManager.getTriggerMode(chat_id) === 'always';
    if (this.isGroupChat(chat_type) && !botMentioned && !isAlwaysTrigger && !isTriggerCommand) {
      logger.debug({ messageId: message_id, chatId: chat_id, chat_type }, 'Skipped group chat message without @mention (trigger mode: mention)');
      this.forwardFilteredMessage('trigger_mode', message_id, chat_id, text, this.extractOpenId(sender), { chat_type });
      return;
    }

    // Add typing reaction
    await this.addTypingReaction(message_id);

    // Handle commands
    if (textWithoutMentions.startsWith('/')) {
      const [command, ...args] = textWithoutMentions.slice(1).split(/\s+/);
      const cmd = command.toLowerCase();

      if (this.controlHandler) {
        const response = await this.callbacks.emitControl({
          type: cmd as ControlCommandType,
          chatId: chat_id,
          data: { args, rawText: textWithoutMentions, senderOpenId: this.extractOpenId(sender) },
        });

        // Issue #1562: Relay both success messages and error messages from control handler.
        // Previously, success:false responses with error messages were silently dropped,
        // causing commands like /trigger to appear unrecognized.
        if (response.success || response.message) {
          if (response.message) {
            await this.callbacks.sendMessage({
              chatId: chat_id,
              type: 'text',
              text: response.message,
            });
          }
          return;
        }
      }

      // Default command handling (fallback when controlHandler is not available)
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

      // Issue #1494: Fallback /stop handling when controlHandler is unavailable
      if (cmd === 'stop') {
        await this.callbacks.sendMessage({
          chatId: chat_id,
          type: 'text',
          text: '⏹️ **停止命令已发送**\n\n当前会话将尝试停止响应。',
        });
        return;
      }

    }

    // Get quoted/replied message context if this is a reply
    let quotedMessageResult: { text: string; attachment?: MessageAttachment } | undefined;
    if (parent_id) {
      quotedMessageResult = await this.getQuotedMessageContext(parent_id);
    }

    // Get chat history context for passive mode
    const isPassiveModeTrigger = this.isGroupChat(chat_type) && botMentioned;
    let chatHistoryContext: string | undefined;

    if (isPassiveModeTrigger) {
      chatHistoryContext = await this.getChatHistoryContext(chat_id);
    }

    // Build metadata
    const metadata: Record<string, unknown> = {};
    if (quotedMessageResult?.text) {
      metadata.quotedMessage = quotedMessageResult.text;
    }
    if (chatHistoryContext) {
      metadata.chatHistoryContext = chatHistoryContext;
    }

    // Build attachments from quoted message if available
    const quotedAttachments = quotedMessageResult?.attachment
      ? [quotedMessageResult.attachment]
      : undefined;

    // Emit as incoming message
    await this.callbacks.emitMessage({
      messageId: message_id,
      chatId: chat_id,
      userId: this.extractOpenId(sender),
      content: text,
      messageType: message_type,
      timestamp: create_time,
      threadId,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      attachments: quotedAttachments,
    });
  }

  /**
   * Handle card action event from WebSocket.
   */
  async handleCardAction(data: FeishuCardActionEventData): Promise<void> {
    if (!this.isRunning()) {
      return;
    }

    // Parse actual Feishu event structure
    const rawData = data as Record<string, unknown>;
    const context = rawData.context as { open_message_id?: string; open_chat_id?: string } | undefined;
    const operator = rawData.operator as { open_id?: string; user_id?: string; union_id?: string } | undefined;
    const actionData = rawData.action as { value?: string; tag?: string; type?: string; text?: string } | undefined;

    const message_id = context?.open_message_id;
    const chat_id = context?.open_chat_id;
    const action = actionData ? {
      type: actionData.tag ?? actionData.type ?? '',
      value: actionData.value ?? '',
      trigger: 'button' as const,
      text: actionData.text,
    } : undefined;
    const user = operator ? {
      sender_id: {
        open_id: operator.open_id ?? '',
        user_id: operator.user_id,
        union_id: operator.union_id,
      },
    } : undefined;

    if (!action || !message_id || !chat_id) {
      logger.warn({
        hasAction: !!action,
        hasMessageId: !!message_id,
        hasChatId: !!chat_id,
        eventData: JSON.stringify(data),
      }, 'Missing required card action fields');
      return;
    }

    logger.info(
      {
        messageId: message_id,
        chatId: chat_id,
        actionType: action.type,
        actionValue: action.value,
        userId: user?.sender_id?.open_id,
      },
      'Card action received'
    );

    // Send user-visible confirmation message
    const buttonText = action.text || action.value;
    if (buttonText) {
      try {
        await this.callbacks.sendMessage({
          chatId: chat_id,
          type: 'text',
          text: `✅ 您选择了「${buttonText}」`,
          threadId: message_id,
        });
      } catch (error) {
        logger.warn({ err: error, messageId: message_id, chatId: chat_id }, 'Failed to send user confirmation');
      }
    }

    // Issue #1629: Resolve action prompt BEFORE routing so that remote
    // Worker Nodes receive the contextual prompt via resolvedPrompt field.
    // Issue #1572: Try to resolve action prompt from InteractiveContextStore.
    // Falls back to default text if no prompt template is registered.
    const defaultMessage = `用户点击了按钮「${buttonText}」`;
    let messageContent: string;
    let resolvedPrompt: string | undefined;
    try {
      if (this.callbacks.resolveActionPrompt) {
        const promptFromTemplate = this.callbacks.resolveActionPrompt(
          message_id,
          chat_id,
          action.value,
          action.text,
        );
        resolvedPrompt = promptFromTemplate || undefined;
        messageContent = promptFromTemplate || defaultMessage;
      } else {
        messageContent = defaultMessage;
      }
    } catch (err) {
      logger.warn({ err, messageId: message_id, chatId: chat_id }, 'Failed to resolve action prompt, using default');
      messageContent = defaultMessage;
    }

    // Try to route card action to Worker Node first
    if (this.callbacks.routeCardAction) {
      logger.debug(
        { messageId: message_id, chatId: chat_id, actionValue: action.value },
        'Attempting to route card action'
      );
      const routed = await this.callbacks.routeCardAction({
        chatId: chat_id,
        cardMessageId: message_id,
        actionType: action.type,
        actionValue: action.value,
        actionText: action.text,
        userId: user?.sender_id?.open_id,
        resolvedPrompt,
        action: {
          type: action.type,
          value: action.value,
          text: action.text,
          trigger: action.trigger,
        },
      });

      if (routed) {
        logger.info({ messageId: message_id, chatId: chat_id, actionValue: action.value }, 'Card action routed to Worker Node');
        return;
      }
      logger.debug({ messageId: message_id, chatId: chat_id }, 'Card action not routed, falling back to local emit');
    }

    // Emit card action as a message to the agent
    // Issue #2007: This is the fallback path when routeCardAction returns false
    // (no remote Worker Node registered). The message goes through the same
    // pipeline as text messages via createDefaultMessageHandler → Pilot.processMessage.
    try {
      logger.debug(
        { messageId: message_id, chatId: chat_id, actionValue: action.value, routed: false },
        'Emitting card action as local message to agent'
      );
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
        },
      });
      logger.debug(
        { messageId: message_id, chatId: chat_id },
        'Card action message emitted successfully'
      );
    } catch (error) {
      logger.error({ err: error, messageId: message_id, chatId: chat_id }, 'Failed to emit card action message');
      // Issue #1357: Notify user that their card action was not processed
      this.callbacks.sendMessage({
        chatId: chat_id,
        type: 'text',
        text: '❌ 处理卡片操作时发生错误，请重试。',
      }).catch((notifyErr) => {
        logger.error({ err: notifyErr, chatId: chat_id }, 'Failed to send card action error notification');
      });
    }

    // Try to handle via InteractionManager
    try {
      const compatEvent: FeishuCardActionEvent = {
        action,
        message_id,
        chat_id,
        user: user ?? { sender_id: { open_id: '' } },
        tenant_key: (rawData.tenant_key as string) || '',
      };

      await this.interactionManager.handleAction(compatEvent);
    } catch (error) {
      logger.error({ err: error, messageId: message_id, chatId: chat_id }, 'Card action handler error');

      await this.callbacks.sendMessage({
        chatId: chat_id,
        type: 'text',
        text: `❌ 处理卡片操作时发生错误：${error instanceof Error ? error.message : '未知错误'}`,
      });
    }
  }

  /**
   * Detect and correct a downloaded file's extension based on its magic bytes.
   *
   * Reads only the first 12 bytes of the file (instead of the entire file)
   * for magic bytes detection, then renames the file if an extension is needed.
   *
   * @param filePath - Current path of the downloaded file
   * @returns The (possibly renamed) file path with correct extension
   */
  private async correctFileExtension(filePath: string): Promise<string> {
    try {
      const fd = await fs.open(filePath, 'r');
      const header = Buffer.alloc(12);
      await fd.read(header, 0, 12, 0);
      await fd.close();

      const correctedPath = ensureFileExtension(filePath, header);
      if (correctedPath === filePath) {
        return filePath;
      }

      try {
        await fs.rename(filePath, correctedPath);
        return correctedPath;
      } catch (renameErr) {
        // Rename may fail (e.g., cross-device link) — log and keep original
        logger.warn(
          { err: renameErr, from: filePath, to: correctedPath },
          'Failed to rename file, keeping original name',
        );
        return filePath;
      }
    } catch {
      // File read failed — return original path
      return filePath;
    }
  }
}
