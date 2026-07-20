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
import { promisify } from 'util';
import { execFile } from 'child_process';
import type * as lark from '@larksuiteoapi/node-sdk';
import {
  Config,
  DEDUPLICATION,
  REACTIONS,
  CHAT_HISTORY,
  createLogger,
  isGroupChat,
  stripLeadingMentions,
  ensureFileExtensionFromPath,
  type FeishuEventData,
  type FeishuMessageEvent,
  type FeishuCardActionEvent,
  type FeishuCardActionEventData,
  type IncomingMessage,
  type MessageAttachment,
  type ControlCommand,
  type ControlResponse,
  type TopicGroupMessageEvent,
} from '@disclaude/core';
import { InteractionManager } from '../../platforms/feishu/interaction-manager.js';
import { extractFullCardContent } from '../../platforms/feishu/card-builders/card-text-extractor.js';
import { messageLogger } from '../../utils/message-logger.js';
import type { TriggerModeManager } from './passive-mode.js';
import type { MentionDetector } from './mention-detector.js';
import { evaluateMessageFilters } from './message-filters.js';
import { tryHandleSlashCommand } from './command-router.js';
import {
  extractOpenId,
  parsePostContent,
  parseShareChatContent,
  extractSenderName,
} from './content-parser.js';

const logger = createLogger('MessageHandler');

/**
 * Map Feishu message type to resource download API `type` parameter.
 *
 * Feishu API only accepts "image" or "file":
 * - "image" for images
 * - "file" for files, audio, and video
 *
 * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-resource/get
 */
function mapResourceType(messageType: string): 'image' | 'file' {
  return messageType === 'image' ? 'image' : 'file';
}

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
  /**
   * Called when a topic group message is received.
   * Issue #4031: Topic group message push notification.
   * The callback is invoked only when topicNotify.enabled is true in config.
   *
   * @param event - Topic group message event with chat context and sender info
   */
  onTopicMessage?: (event: TopicGroupMessageEvent) => void;
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
 * Issue #4319: message types whose content is a downloadable media payload.
 * Used by getThreadContext to decide whether to download + surface the file
 * (instead of extractMessageText's opaque placeholder).
 */
const MEDIA_MESSAGE_TYPES = new Set(['image', 'file', 'audio', 'media', 'video']);

/** Issue #4319: short Chinese label for a media message type (thread-context display). */
function mediaThreadLabel(messageType?: string): string {
  // Issue #4330: align with handleQuotedFileMessage's typeLabel so both paths
  // use the same Chinese labels for the same media types.
  switch (messageType) {
    case 'image': return '图片';
    case 'file': return '文件';
    case 'audio': return '语音消息';
    default: return '媒体文件';
  }
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
  private tenantAccessToken: string;

  private readonly MAX_MESSAGE_AGE = DEDUPLICATION.MAX_MESSAGE_AGE;

  /**
   * Create a MessageHandler.
   */
  constructor(options: {
    triggerModeManager: TriggerModeManager;
    mentionDetector: MentionDetector;
    interactionManager: InteractionManager;
    callbacks: MessageCallbacks;
    isRunning: () => boolean;
    hasControlHandler: () => boolean;
    tenantAccessToken: string;
  }) {
    this.triggerModeManager = options.triggerModeManager;
    this.mentionDetector = options.mentionDetector;
    this.interactionManager = options.interactionManager;
    this.callbacks = options.callbacks;
    this.isRunning = options.isRunning;
    this.getHasControlHandler = options.hasControlHandler;
    this.controlHandler = false;
    this.tenantAccessToken = options.tenantAccessToken;

    if (!this.tenantAccessToken) {
      logger.warn('tenantAccessToken is empty — file downloads via lark-cli will fail');
    }
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
   * Download a Feishu message resource file via lark-cli.
   *
   * Uses `npx @larksuite/cli im +messages-resources-download` instead of the Feishu SDK,
   * leveraging lark-cli's built-in retry, chunked download, and error handling.
   *
   * Issue #3960: Replaces SDK-based this.client.im.messageResource.get() + writeFile()
   */
  private async downloadResourceViaLarkCli(
    messageId: string,
    fileKey: string,
    resourceType: 'image' | 'file',
    outputPath: string,
  ): Promise<void> {
    const env = {
      ...process.env,
      LARKSUITE_CLI_TENANT_ACCESS_TOKEN: this.tenantAccessToken,
    };

    const { stdout, stderr } = await promisify(execFile)(
      'npx',
      [
        '@larksuite/cli', 'im', '+messages-resources-download',
        '--message-id', messageId,
        '--file-key', fileKey,
        '--type', resourceType,
        '--output', outputPath,
        '--as', 'bot',
      ],
      { env, timeout: 120_000 },
    );

    if (stderr) {
      if (!stdout) {
        throw new Error(`lark-cli messages-resources-download failed: ${stderr}`);
      }
      logger.warn({ stderr }, 'lark-cli reported warnings during resource download');
    }
  }

  /**
   * Build a download command string for the agent to use as a fallback hint.
   */
  private buildDownloadCmd(messageId: string, fileKey: string, resourceType: 'image' | 'file'): string {
    const ext = resourceType === 'image' ? 'jpg' : 'bin';
    return `npx @larksuite/cli im +messages-resources-download --message-id ${messageId} --file-key ${fileKey} --type ${resourceType} --as bot --output ./downloaded_file.${ext}`;
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
      // Truncation (recency-correct) is owned by getChatHistory(); pass our
      // larger budget via the override so it isn't silently capped at the
      // session default. The previous local truncation was dead code — it ran
      // `slice(-CHAT_HISTORY.MAX_CONTEXT_LENGTH)` on a string getChatHistory had
      // already capped smaller — and assumed oldest→newest ordering that no
      // longer holds. Do not re-truncate here.
      const history = await messageLogger.getChatHistory(chatId, CHAT_HISTORY.MAX_CONTEXT_LENGTH);

      if (!history || history.length === 0) {
        return undefined;
      }

      return history;
    } catch (error) {
      logger.error({ err: error, chatId }, 'Failed to get chat history context');
      return undefined;
    }
  }

  /**
   * Get thread context by walking up the parent_id chain in topic groups.
   *
   * Fetches messages in the reply chain from root to the immediate parent,
   * building a chronological thread history for the agent to understand
   * the full conversation context within the thread.
   *
   * Issue #3641 sub-problem 1: Thread context retrieval for topic groups.
   */
  private async getThreadContext(parentId: string, maxDepth: number = 10): Promise<string | undefined> {
    if (!this.client) {
      return undefined;
    }

    try {
      // Walk up the parent_id chain to collect all thread messages
      const threadMessages: Array<{ messageId: string; content: string; senderType: string }> = [];
      const visitedIds = new Set<string>();
      let currentId: string | undefined = parentId;

      while (currentId && threadMessages.length < maxDepth && !visitedIds.has(currentId)) {
        visitedIds.add(currentId);

        const response = await this.client.im.message.get({
          path: { message_id: currentId },
          params: { user_id_type: 'open_id' },
        });

        const msg = response.data as {
          message?: {
            message_type?: string;
            content?: string;
            message_id?: string;
            parent_id?: string;
            sender?: { sender_type?: string };
          };
        };

        if (!msg?.message) {
          break;
        }

        const msgType = msg.message.message_type;
        let text = this.extractMessageText(msgType, msg.message.content || '{}');

        // Issue #4319: media messages (image/file/audio/media/video) only yield an
        // opaque placeholder from extractMessageText. Download the file (reusing the
        // quoted-message path) and surface its name + local path so a media
        // topic-anchor in the thread is legible to the agent instead of "[未解析的 image 消息]".
        if (MEDIA_MESSAGE_TYPES.has(msgType || '')) {
          try {
            const media = await this.handleQuotedFileMessage(
              msgType || '',
              msg.message.content || '{}',
              msg.message.message_id || currentId,
            );
            if (media?.attachment?.filePath) {
              text = `[${mediaThreadLabel(msgType)}: ${media.attachment.fileName}]（已下载到本地: ${media.attachment.filePath}）`;
            } else if (media?.text) {
              // Issue #4327: reuse the manual-download hint (includes a runnable
              // download command) instead of the opaque "[未解析的 image 消息]".
              // Strip the "> " quote prefix on every line — the hint is multiline
              // (label line + download-command line), and the prefix is an artifact
              // of the quoted-message context, not meaningful in thread history.
              text = media.text.replace(/^>\s?/gm, '');
            }
            // else: keep extractMessageText's placeholder (download failed / no token)
          } catch (mediaErr) {
            logger.debug(
              { err: mediaErr, messageId: msg.message.message_id },
              'Failed to extract media in thread context; using placeholder',
            );
          }
        }

        if (text) {
          threadMessages.push({
            messageId: msg.message.message_id || currentId,
            content: text,
            senderType: msg.message.sender?.sender_type === 'app' ? 'bot' : 'user',
          });
        }

        // Walk to parent
        currentId = msg.message.parent_id;
      }

      if (threadMessages.length === 0) {
        return undefined;
      }

      // Reverse to get chronological order (oldest first)
      threadMessages.reverse();

      // Format as thread history
      const lines = threadMessages.map(m => {
        const label = m.senderType === 'bot' ? '🤖' : '👤';
        return `${label} ${m.content}`;
      });

      return lines.join('\n\n');
    } catch (error) {
      logger.debug({ err: error, parentId }, 'Failed to get thread context');
      return undefined;
    }
  }

  /**
   * Extract plain text from a Feishu message content string.
   */
  private extractMessageText(messageType: string | undefined, content: string): string {
    if (!messageType || !content) {
      return '';
    }

    try {
      const parsed = JSON.parse(content);
      if (messageType === 'text') {
        return parsed.text || '';
      } else if (messageType === 'post' && parsed.content && Array.isArray(parsed.content)) {
        return parsePostContent(parsed.content);
      } else if (messageType === 'interactive') {
        // Issue #4083: Extract text from interactive card messages
        return extractFullCardContent(parsed);
      }
      // Issue #4251: surface shared chat / user cards instead of silently
      // dropping them from the thread history. A dropped topic-anchor message
      // leaves the bot with an incomplete view of what the thread is about.
      // Issue #4316 nit ②: match by type (not id), so a card missing its id
      // still reads as a card rather than the generic placeholder.
      if (messageType === 'share_chat') {
        return parsed.share_chat_id
          ? `[分享的群名片: ${parsed.share_chat_id}]`
          : '[分享的群名片]';
      }
      if (messageType === 'share_user') {
        return parsed.share_user_id
          ? `[分享的联系人名片: ${parsed.share_user_id}]`
          : '[分享的联系人名片]';
      }
    } catch {
      // Issue #4083: Handle non-JSON interactive card content
      if (messageType === 'interactive') {
        return extractFullCardContent(content);
      }
      // Fall through to the unhandled-type placeholder below (Issue #4251).
    }
    // Issue #4251: never silently drop a message from thread context. Note the
    // type so the bot knows a message existed (and that its content is not
    // captured), rather than seeing a contiguous-but-incomplete history that
    // hides the gap — which can cause it to misread the thread's topic.
    // Issue #4316 nit ①: this covers both unrecognized types AND recognized
    // types with malformed content (e.g. post missing content array), so the
    // behavior is intentional and traceable.
    return `[未解析的 ${messageType} 消息]`;
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
          // Issue #1711: Extract full text from interactive card messages
          const parsed = JSON.parse(msgContent);
          quotedText = extractFullCardContent(parsed);
        // Issue #4330: include 'video' to match MEDIA_MESSAGE_TYPES used by getThreadContext.
        } else if (MEDIA_MESSAGE_TYPES.has(msgType || '')) {
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
    // Issue #3960: downloadResourceViaLarkCli uses npx lark-cli, which only needs tenantAccessToken (not this.client)
    let localPath: string | undefined;
    if (this.tenantAccessToken) {
      try {
        const downloadDir = path.join(Config.getWorkspaceDir(), 'downloads');
        await fs.mkdir(downloadDir, { recursive: true });
        localPath = path.join(downloadDir, String(fileName || fileKey));

        logger.info({ fileKey, fileName, localPath, quotedMessageId: messageId }, 'Downloading quoted file from Feishu');

        await this.downloadResourceViaLarkCli(
          messageId,
          fileKey,
          mapResourceType(messageType),
          localPath,
        );

        // Issue #1637, #1663: Ensure file has correct extension via magic bytes detection
        const correctedPath = await ensureFileExtensionFromPath(localPath);
        if (correctedPath !== localPath) {
          localPath = correctedPath;
          fileName = path.basename(correctedPath);
        }

        // Issue #2411: Verify file was actually written to disk
        try {
          const stat = await fs.stat(localPath);
          if (stat.size === 0) {
            throw new Error(`Downloaded quoted file is empty (0 bytes): ${localPath}`);
          }
        } catch (statError) {
          throw new Error(`Downloaded quoted file not found on disk: ${localPath}`, { cause: statError });
        }

        logger.info({ fileKey, localPath }, 'Quoted file downloaded successfully');
      } catch (downloadError) {
        logger.error({ err: downloadError, fileKey, messageId }, 'Failed to download quoted file');
        localPath = undefined;
      }
    }

    let typeLabel: string;
    if (messageType === 'image') {
      typeLabel = '图片';
    } else if (messageType === 'file') {
      typeLabel = '文件';
    } else if (messageType === 'audio') {
      typeLabel = '语音消息';
    } else {
      typeLabel = '媒体文件';
    }
    const resourceType = mapResourceType(messageType);
    const downloadCmd = this.buildDownloadCmd(messageId, fileKey, resourceType);
    if (!localPath) {
      return {
        text: `> **引用的消息**: [${typeLabel}] ${fileName || fileKey}（下载失败）\n> 可使用以下命令下载: ${downloadCmd}`,
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

    // Pre-compute whether a bot sender @mentions our bot (bot-to-bot, #1742).
    const botMentionsUs = sender?.sender_type === 'app' && this.mentionDetector.isBotMentioned(mentions);

    // Dedup / bot / age filters (Issue #4126: logic extracted to message-filters.ts)
    const filterVerdict = evaluateMessageFilters(
      { messageId: message_id, createTime: create_time, senderType: sender?.sender_type, botMentionsUs },
      { isProcessed: (id) => messageLogger.isMessageProcessed(id), maxMessageAge: this.MAX_MESSAGE_AGE },
    );
    if (!filterVerdict.passed) {
      const { reason } = filterVerdict;
      if (reason === 'duplicate') {
        logger.debug({ messageId: message_id }, 'Skipped duplicate message');
        this.forwardFilteredMessage('duplicate', message_id, chat_id, content, extractOpenId(sender));
      } else if (reason === 'bot') {
        logger.debug('Skipped bot message (not mentioning our bot)');
        this.forwardFilteredMessage('bot', message_id, chat_id, content);
      } else {
        logger.debug({ messageId: message_id }, 'Skipped old message');
        this.forwardFilteredMessage('old', message_id, chat_id, content, extractOpenId(sender), { age: filterVerdict.age });
      }
      return;
    }

    // Bot-to-bot @mention messages that passed the filter are allowed through (#1742).
    if (sender?.sender_type === 'app') {
      logger.info({ messageId: message_id, chatId: chat_id }, 'Bot message mentions our bot, allowing through');
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
      // Issue #3960: downloadResourceViaLarkCli uses npx lark-cli, which only needs tenantAccessToken (not this.client)
      let localPath: string | undefined;
      if (this.tenantAccessToken) {
        try {
          const downloadDir = path.join(Config.getWorkspaceDir(), 'downloads');
          await fs.mkdir(downloadDir, { recursive: true });
          localPath = path.join(downloadDir, String(fileName || fileKey));

          logger.info({ fileKey, fileName, localPath }, 'Downloading file from Feishu');

          await this.downloadResourceViaLarkCli(
            message_id,
            fileKey,
            mapResourceType(message_type),
            localPath,
          );

          // Issue #2411: Verify file was actually written to disk
          try {
            const stat = await fs.stat(localPath);
            if (stat.size === 0) {
              throw new Error(`Downloaded file is empty (0 bytes): ${localPath}`);
            }
          } catch (statError) {
            throw new Error(`Downloaded file not found on disk: ${localPath}`, { cause: statError });
          }

          // Issue #1637, #1663: Ensure file has correct extension via magic bytes detection
          const correctedPath = await ensureFileExtensionFromPath(localPath);
          if (correctedPath !== localPath) {
            localPath = correctedPath;
            fileName = path.basename(correctedPath);
          }

          logger.info({ fileKey, localPath }, 'File downloaded successfully');
        } catch (downloadError) {
          logger.error({ err: downloadError, fileKey, messageId: message_id }, 'Failed to download file');
          localPath = undefined;
        }
      }

      // Log the incoming message
      await messageLogger.logIncomingMessage(
        message_id,
        extractOpenId(sender) || 'unknown',
        chat_id,
        `[${message_type} received]${localPath ? ` → ${localPath}` : ''}`,
        message_type,
        create_time
      );

      await this.addTypingReaction(message_id);

      // Build content with file path for the agent prompt
      let typeLabel: string;
      if (message_type === 'image') {
        typeLabel = '图片';
      } else if (message_type === 'file') {
        typeLabel = '文件';
      } else if (message_type === 'audio') {
        typeLabel = '语音消息';
      } else {
        typeLabel = '媒体文件';
      }
      const resourceType = mapResourceType(message_type);
      const downloadCmd = this.buildDownloadCmd(message_id, fileKey, resourceType);
      const filePrompt = localPath
        ? `用户${message_type === 'audio' ? '发送了一段' : '上传了一个'}${typeLabel}：${fileName || fileKey}\n\n文件已下载到本地: ${localPath}\n\n请使用 Read 工具读取该文件来查看内容。${message_type === 'image' ? '这是一个图片文件，Read 工具可以直接查看图片内容。' : message_type === 'audio' ? '这是一个音频文件。你可以根据自身能力处理音频（如调用 ASR 工具转录、分析音频特征等）。' : ''}\n\n如果文件读取失败，可以使用以下命令重新下载:\n${downloadCmd}`
        : `用户${message_type === 'audio' ? '发送了一段' : '上传了一个'}${typeLabel}：${fileName || fileKey}，但自动下载失败。\n\n你可以尝试手动下载该文件：\n- message_id: \`${message_id}\`\n- file_key: \`${fileKey}\`\n- 消息类型: ${message_type}\n- API type 参数: ${resourceType}\n\n下载命令:\n\`\`\`bash\n${downloadCmd}\n\`\`\``;

      // Issue #3702: Build metadata for file/image messages to pass chatType and threadContext,
      // ensuring intermediate message filtering works correctly in topic groups.
      const fileMetadata: Record<string, unknown> = {};
      if (chat_type) {
        fileMetadata.chatType = chat_type;
      }
      let fileThreadContext: string | undefined;
      if (chat_type === 'topic' && parent_id) {
        fileThreadContext = await this.getThreadContext(parent_id);
      }
      if (fileThreadContext) {
        fileMetadata.threadContext = fileThreadContext;
      }

      // Issue #3828: Apply @mention/trigger mode check for file/image messages in group/topic chats
      const fileBotMentioned = this.mentionDetector.isBotMentioned(mentions);
      if (isGroupChat(chat_type) && !fileBotMentioned) {
        if (this.triggerModeManager.getMode(chat_id) === 'auto'
          && this.triggerModeManager.needsSmallGroupRecheck(chat_id)) {
          await this.checkAndAutoDisableSmallGroup(chat_id);
        }
        if (!this.triggerModeManager.isTriggerEnabled(chat_id)) {
          logger.debug(
            { messageId: message_id, chatId: chat_id, chat_type, messageType: message_type },
            'Skipped file/image message in group chat without @mention (trigger mode disabled)'
          );
          this.forwardFilteredMessage('trigger_mode', message_id, chat_id, filePrompt, extractOpenId(sender), { chat_type, messageType: message_type });
          return;
        }
      }

      // Get chat history context when bot IS mentioned in group/topic for file messages
      // Issue #4304: Skip group-level chat history for topic groups — it mixes
      // messages from different threads. Topic groups already have thread-isolated
      // context set above (fileThreadContext at line ~753).
      if (isGroupChat(chat_type) && chat_type !== 'topic' && fileBotMentioned) {
        const chatHistoryContext = await this.getChatHistoryContext(chat_id);
        if (chatHistoryContext) {
          fileMetadata.chatHistoryContext = chatHistoryContext;
        }
      }

      await this.callbacks.emitMessage({
        messageId: `${message_id}-${message_type === 'audio' ? 'audio' : 'file'}`,
        chatId: chat_id,
        userId: extractOpenId(sender),
        content: filePrompt,
        messageType: message_type === 'audio' ? 'audio' : 'file',
        timestamp: create_time,
        threadId,
        attachments: localPath ? [{ fileName: fileName || fileKey, filePath: localPath }] : undefined,
        metadata: Object.keys(fileMetadata).length > 0 ? fileMetadata : undefined,
      });
      return;
    }

    // Handle text, post, share_chat, and interactive messages
    // Issue #846: Add support for share_chat (forwarded chat history) messages
    // Issue #3657: Add support for interactive (card) messages
    if (message_type !== 'text' && message_type !== 'post' && message_type !== 'share_chat' && message_type !== 'interactive') {
      logger.debug({ messageType: message_type }, 'Skipped unsupported message type');
      this.forwardFilteredMessage('unsupported', message_id, chat_id, content, extractOpenId(sender), { messageType: message_type });
      return;
    }

    // Parse content
    let text = '';
    try {
      const parsed = JSON.parse(content);
      if (message_type === 'text') {
        text = parsed.text?.trim() || '';
      } else if (message_type === 'post' && parsed.content && Array.isArray(parsed.content)) {
        text = parsePostContent(parsed.content);
      } else if (message_type === 'share_chat') {
        // Issue #846: Parse share_chat (forwarded/merged chat history) messages
        text = parseShareChatContent(parsed);
      } else if (message_type === 'interactive') {
        // Issue #3657: Parse interactive card messages
        text = extractFullCardContent(parsed);
      }
    } catch {
      // Issue #4083: Handle non-JSON interactive card content (<card> format)
      if (message_type === 'interactive' && content) {
        text = extractFullCardContent(content);
      } else {
        logger.error('Failed to parse content');
        return;
      }
    }

    if (!text) {
      logger.debug('Skipped empty text');
      this.forwardFilteredMessage('empty', message_id, chat_id, content, extractOpenId(sender));
      return;
    }

    // Log message
    await messageLogger.logIncomingMessage(
      message_id,
      extractOpenId(sender) || 'unknown',
      chat_id,
      text,
      message_type,
      create_time
    );

    // Issue #4031: Emit topic group message notification if enabled.
    // Placed BEFORE trigger_mode check so notifications fire for all topic messages,
    // regardless of whether the bot is @mentioned.
    if (chat_type === 'topic' && this.callbacks.onTopicMessage
        && Config.getRawConfig().feishu?.topicNotify?.enabled === true) {
      try {
        const senderOpenId = extractOpenId(sender);
        const senderName = extractSenderName({ sender, sender_name: sender?.sender_id } as unknown as { [key: string]: unknown });
        this.callbacks.onTopicMessage({
          type: 'topic_group_message',
          chatId: chat_id,
          rootId: parent_id ?? message_id,
          threadId: message_id,
          sender: {
            name: senderName,
            openId: senderOpenId,
          },
          content: (text || '').substring(0, 500),
          isReply: !!parent_id,
          timestamp: create_time
            ? new Date(create_time).toISOString()
            : new Date().toISOString(),
        });
      } catch (topicNotifyError) {
        logger.warn(
          { err: topicNotifyError, messageId: message_id },
          'Failed to emit topic group notification (non-critical)'
        );
      }
    }

    // Check for control commands
    const botMentioned = this.mentionDetector.isBotMentioned(mentions);
    const textWithoutMentions = stripLeadingMentions(text, mentions);

    // Group chat trigger mode (Issue #2291: triggerMode enum, #3345: 'auto' mode)
    // Issue #2052: Auto-enable trigger mode for 2-member group chats (bot + 1 user)
    // Issue #3592: Re-check small group status even when already marked (allows unmarking when group grows)
    const isTriggerCommand = textWithoutMentions.startsWith('/trigger');
    if (isGroupChat(chat_type) && !botMentioned && !isTriggerCommand) {
      // Issue #3592: Always re-check small group status in 'auto' mode (with throttle)
      // In 'mention' mode, user explicitly wants mention-only regardless of group size
      if (this.triggerModeManager.getMode(chat_id) === 'auto'
        && this.triggerModeManager.needsSmallGroupRecheck(chat_id)) {
        await this.checkAndAutoDisableSmallGroup(chat_id);
      }
      if (!this.triggerModeManager.isTriggerEnabled(chat_id)) {
        logger.debug({ messageId: message_id, chatId: chat_id, chat_type }, 'Skipped group chat message without @mention (trigger mode disabled)');
        this.forwardFilteredMessage('trigger_mode', message_id, chat_id, text, extractOpenId(sender), { chat_type });
        return;
      }
    }

    // Add typing reaction
    await this.addTypingReaction(message_id);

    // Handle commands (Issue #4126 part 2: extracted to channels/feishu/command-router.ts)
    const commandHandled = await tryHandleSlashCommand(
      { textWithoutMentions, chatId: chat_id },
      {
        hasControlHandler: this.controlHandler,
        emitControl: (command) => this.callbacks.emitControl(command),
        sendMessage: (reply) => this.callbacks.sendMessage(reply),
      },
    );
    if (commandHandled) {
      return;
    }

    // Get quoted/replied message context if this is a reply
    let quotedMessageResult: { text: string; attachment?: MessageAttachment } | undefined;
    if (parent_id) {
      quotedMessageResult = await this.getQuotedMessageContext(parent_id);
    }

    // Get chat history context for trigger mode (Issue #2193: renamed from passive mode)
    // Issue #3989: For topic groups, use thread context only (not flat chat history)
    // to avoid mixing messages from different threads.
    const isTriggerModeMention = isGroupChat(chat_type) && botMentioned;
    let chatHistoryContext: string | undefined;
    let threadContext: string | undefined;

    if (chat_type === 'topic' && parent_id) {
      // Topic groups: build thread context from parent chain only
      threadContext = await this.getThreadContext(parent_id);
    } else if (isTriggerModeMention && chat_type !== 'topic') {
      // Regular groups: use flat chat history.
      // Issue #4304 (part 2): topic groups never use flat chat history — it
      // mixes messages across threads. A topic message without parent_id gets
      // no injected context here, matching the file/image path.
      chatHistoryContext = await this.getChatHistoryContext(chat_id);
    }

    // Build metadata
    const metadata: Record<string, unknown> = {};
    if (chat_type) {
      metadata.chatType = chat_type;
    }
    if (quotedMessageResult?.text) {
      metadata.quotedMessage = quotedMessageResult.text;
    }
    if (chatHistoryContext) {
      metadata.chatHistoryContext = chatHistoryContext;
    }
    if (threadContext) {
      metadata.threadContext = threadContext;
    }

    // Build attachments from quoted message if available
    const quotedAttachments = quotedMessageResult?.attachment
      ? [quotedMessageResult.attachment]
      : undefined;

    // Emit as incoming message
    await this.callbacks.emitMessage({
      messageId: message_id,
      chatId: chat_id,
      userId: extractOpenId(sender),
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

    // Issue #4197: Log the card click under the ORIGINAL message_id with the
    // RESOLVED prompt content (not a synthetic id + generic button text).
    // The system-prompt/history builder looks up incoming content by the
    // original Feishu message_id; the previous synthetic id
    // (`card_action_<id>_<ts>`) meant the click was invisible there, so the LLM
    // only ever saw the card's `[Interactive Card]` text instead of the
    // `actionPrompts` content. Awaited (not fire-and-forget) so the entry is
    // persisted before the turn is processed.
    //
    // Issue #4197 (refinement): route through logCardInteraction, NOT
    // logIncomingMessage. A card interaction is a distinct event from
    // im.message.receive; logCardInteraction registers the click under a
    // namespaced dedup key (`card_action:<message_id>`) instead of the bare
    // message_id, so the click can no longer mark the card message as
    // "processed" and suppress a later im.message.receive for the same card.
    // (issue #4197 方案 A)
    await messageLogger.logCardInteraction(
      message_id,
      user?.sender_id?.open_id || 'unknown',
      chat_id,
      messageContent,
    ).catch(err => {
      logger.warn({ err, messageId: message_id, chatId: chat_id }, 'Failed to log card action');
    });

    // Try to route card action to Worker Node first
    if (this.callbacks.routeCardAction) {
      logger.debug(
        { messageId: message_id, chatId: chat_id, actionValue: action.value },
        'Attempting to route card action'
      );
      const result = await this.callbacks.routeCardAction({
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

      if (result.routed) {
        logger.info({ messageId: message_id, chatId: chat_id, actionValue: action.value }, 'Card action routed to Worker Node');
        return;
      }

      // Issue #2247 Problem 7: When the card context has expired, notify the user
      // instead of falling through to local emit (which may silently discard the action).
      if (result.expired) {
        logger.info({ messageId: message_id, chatId: chat_id }, 'Card context expired, notifying user');
        await this.callbacks.sendMessage({
          chatId: chat_id,
          type: 'text',
          text: '⏰ 您的操作已超时，请重新开始对话。',
        }).catch((notifyErr) => {
          logger.error({ err: notifyErr, chatId: chat_id }, 'Failed to send card action expiry notification');
        });
        return;
      }
      logger.debug({ messageId: message_id, chatId: chat_id }, 'Card action not routed, falling back to local emit');
    }

    // Emit card action as a message to the agent
    // Issue #2007: This is the fallback path when routeCardAction returns false
    // (no remote Worker Node registered). The message goes through the same
    // pipeline as text messages via createDefaultMessageHandler → ChatAgent.processMessage.
    let emitFailed = false;
    try {
      logger.debug(
        { messageId: message_id, chatId: chat_id, actionValue: action.value, routed: false },
        'Emitting card action as local message to agent'
      );
      await this.callbacks.emitMessage({
        messageId: message_id,  // Use original Feishu message ID (not synthetic) to prevent threadRoot pollution (fixes #2285)
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
      emitFailed = true;
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

    // Try to handle via InteractionManager (only if emit succeeded — the agent
    // won't process the action if the message was never delivered, so sending
    // a second error notification would be redundant and confusing).
    if (!emitFailed) {
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
  }

  /**
   * Check if a group chat has ≤2 members and auto-disable passive mode.
   *
   * Uses Feishu API `GET /open-apis/im/v1/chats/{chat_id}` to get member counts.
   * A group with user_count=1 and bot_count=1 (or fewer) is considered a small group.
   *
   * Once detected, the chat is permanently marked as a small group — even if
   * more members join later, passive mode stays off to avoid disruptive changes.
   *
   * Issue #2052: Disable passive mode by default for 2-member group chats.
   *
   * @param chatId - Chat ID to check
   */
  private async checkAndAutoDisableSmallGroup(chatId: string): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      const response = await this.client.im.chat.get({
        path: { chat_id: chatId },
      });

      const chatData = response.data;
      if (!chatData) {
        return;
      }

      // user_count and bot_count are strings in Feishu API
      const userCount = parseInt(chatData.user_count || '0', 10);
      const botCount = parseInt(chatData.bot_count || '0', 10);
      const totalMembers = userCount + botCount;

      if (totalMembers > 0 && totalMembers <= 2) {
        this.triggerModeManager.markAsSmallGroup(chatId);
        logger.info(
          { chatId, userCount, botCount, totalMembers },
          'Small group detected (≤2 members), auto-enabling trigger mode',
        );
      } else {
        // Issue #3592: Unmark if group has grown beyond 2 members
        this.triggerModeManager.unmarkSmallGroup(chatId);
        logger.debug(
          { chatId, userCount, botCount, totalMembers },
          'Group has more than 2 members, trigger mode disabled',
        );
      }

      // Issue #3592: Record check time for throttling
      this.triggerModeManager.updateSmallGroupCheckTime(chatId);
    } catch (error) {
      // Don't block message processing if member count check fails
      logger.debug({ err: error, chatId }, 'Failed to check group member count for auto-detection');
    }
  }
}
