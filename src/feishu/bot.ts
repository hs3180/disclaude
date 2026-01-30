/**
 * Feishu/Lark bot using WebSocket API.
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { EventEmitter } from 'events';
import { AgentClient } from '../agent/client.js';
import { Config } from '../config/index.js';
import { DEDUPLICATION } from '../config/constants.js';
import { FeishuOutputAdapter } from '../utils/output-adapter.js';
import { TaskTracker } from '../utils/task-tracker.js';
import { LongTaskManager } from '../long-task/index.js';
import type { SessionManager } from './session.js';
import { buildTextContent } from './content-builder.js';
import { createLogger } from '../utils/logger.js';
import { handleError, ErrorCategory } from '../utils/error-handler.js';
import * as CommandHandlers from './command-handlers.js';
import type { CommandHandlerContext } from './command-handlers.js';
import { attachmentManager, type FileAttachment } from './attachment-manager.js';
import { downloadFile } from './file-downloader.js';

// Temporarily disabled: Markdown detection for rich text messages
// TODO: Re-enable when rich text format is needed again
// function containsMarkdown(text: string): boolean {
//   // Common Markdown patterns in Lark:
//   // Headers: # ## ###
//   // Bold: **text**
//   // Italic: *text* or _text_
//   // Strikethrough: ~~text~~
//   // Inline code: `code`
//   // Code blocks: ```
//   // Links: [text](url)
//   // Images: ![alt](url)
//   // Lists: - item, * item, 1. item
//   // Quotes: > quote
//   // Horizontal rules: --- or ***
//   // Mentions: <at id=...>
//   const markdownPatterns = [
//     /^#{1,6}\s/m,           // Headers
//     /\*\*[^*]+\*\*/,        // Bold
//     /\*[^*]+\*/,            // Italic (single asterisk)
//     /_[^_]+_/m,             // Italic (underscore) - word boundaries to avoid false positives
//     /~~[^~]+~~/,            // Strikethrough
//     /`[^`]+`/,              // Inline code
//     /```/,                  // Code blocks
//     /\[[^\]]+\]\([^)]+\)/,  // Links
//     /!\[[^\]]+\]\([^)]+\)/, // Images
//     /^\s*[-*]\s/m,          // Unordered lists
//     /^\s*\d+\.\s/m,         // Ordered lists
//     /^>\s/m,                // Quotes
//     /^---|^\*{3}/m,         // Horizontal rules
//     /<at[^>]*>/,            // Mentions
//   ];
//
//   return markdownPatterns.some(pattern => pattern.test(text));
// }

/**
 * Feishu/Lark bot using WebSocket.
 */
export class FeishuBot extends EventEmitter {
  readonly agentClient: AgentClient;
  readonly appId: string;
  readonly appSecret: string;
  readonly sessionManager: SessionManager;

  private client?: lark.Client;
  private wsClient?: lark.WSClient;
  private eventDispatcher?: lark.EventDispatcher;
  private running = false;
  private logger = createLogger('FeishuBot');

  // Track processed message IDs to prevent duplicate processing
  private processedMessageIds = new Set<string>();
  private readonly MAX_PROCESSED_IDS = DEDUPLICATION.MAX_PROCESSED_IDS;
  private readonly MAX_MESSAGE_AGE = DEDUPLICATION.MAX_MESSAGE_AGE;

  // Task tracker for persistent deduplication
  private taskTracker: TaskTracker;

  // Active long task managers per chat (one per chat to avoid conflicts)
  private longTaskManagers = new Map<string, LongTaskManager>();

  constructor(
    agentClient: AgentClient,
    appId: string,
    appSecret: string,
    sessionManager: SessionManager
  ) {
    super();
    this.agentClient = agentClient;
    this.appId = appId;
    this.appSecret = appSecret;
    this.sessionManager = sessionManager;
    this.taskTracker = new TaskTracker();
  }

  /**
   * Get or create Lark HTTP client (for sending messages).
   */
  private getClient(): lark.Client {
    if (!this.client) {
      this.client = new lark.Client({
        appId: this.appId,
        appSecret: this.appSecret,
      });
    }
    return this.client;
  }

  /**
   * Send a message to Feishu.
   * Currently using plain text format only (rich text temporarily disabled).
   */
  async sendMessage(chatId: string, text: string): Promise<void> {
    const client = this.getClient();

    try {
      // Always use plain text format
      // Use content builder utility for consistent message formatting
      await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: buildTextContent(text),
        },
      });

      // Defensive: Ensure text is valid before substring
      const safeText = text || '';
      const preview = safeText.length > 100 ? `${safeText.substring(0, 100)  }...` : safeText;
      this.logger.debug({ chatId, messageType: 'text', preview }, 'Message sent');
    } catch (error) {
      handleError(error, {
        category: ErrorCategory.API,
        chatId,
        messageType: 'text'
      }, {
        log: true,
        customLogger: this.logger
      });
    }
  }

  /**
   * Send an interactive card message to Feishu.
   * Used for rich content like code diffs, formatted output, etc.
   *
   * @param chatId - Target chat ID
   * @param card - Card JSON structure
   * @param description - Optional description for logging
   */
  async sendCard(
    chatId: string,
    card: Record<string, unknown>,
    description?: string
  ): Promise<void> {
    const client = this.getClient();

    try {
      await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });

      const desc = description ? ` (${description})` : '';
      this.logger.debug({ chatId, description: desc }, 'Card sent');
    } catch (error) {
      handleError(error, {
        category: ErrorCategory.API,
        chatId,
        description,
        messageType: 'card'
      }, {
        log: true,
        customLogger: this.logger
      });
    }
  }

  /**
   * Process agent message with streaming response.
   * Each message is sent immediately without accumulation.
   * Returns accumulated response content for task persistence.
   * @param messageId - Reserved for future use in task tracking
   */
  async processAgentMessage(
    chatId: string,
    prompt: string,
    _messageId?: string,
    userId?: string
  ): Promise<string> {
    // Get previous session
    const sessionId = await this.sessionManager.getSessionId(chatId);

    // Add context metadata to message for Agent awareness
    // This helps Agent understand the message source without relying on env vars
    // Always inject chatId so Agent can use it for tool calls (e.g., send_file_to_feishu)
    const contextInfo = userId
      ? `[Current Chat ID: ${chatId}, User ID: ${userId}]`
      : `[Current Chat ID: ${chatId}]`;

    let enhancedPrompt = `${contextInfo}\n\n${prompt}`;
    this.logger.debug({ chatId, userId, promptLength: prompt.length }, 'Added chat context to prompt');

    // Check if there are pending attachments and include them in the prompt
    if (attachmentManager.hasAttachments(chatId)) {
      const attachmentInfo = attachmentManager.formatAttachmentsForPrompt(chatId);
      enhancedPrompt = `${enhancedPrompt}\n\n${attachmentInfo}`;
      this.logger.info({ chatId, attachmentCount: attachmentManager.getAttachmentCount(chatId) }, 'Including pending attachments in prompt');
    }

    // Create output adapter for this chat with both sendMessage and sendCard
    const adapter = new FeishuOutputAdapter({
      sendMessage: this.sendMessage.bind(this),
      sendCard: this.sendCard.bind(this),
      chatId,
    });

    // Clear throttle state for this chat
    adapter.clearThrottleState();

    // Accumulate response content for task persistence
    const responseChunks: string[] = [];

    try {
      // Stream agent response - send each message immediately
      for await (const message of this.agentClient.queryStream(
        enhancedPrompt,
        sessionId ?? undefined
      )) {
        const content = typeof message.content === 'string'
          ? message.content
          : this.agentClient.extractText(message);

        if (!content) {
          continue;
        }

        // Accumulate content for task record
        responseChunks.push(content);

        // Use adapter to write message with metadata
        await adapter.write(content, message.messageType ?? 'text', {
          toolName: message.metadata?.toolName as string | undefined,
          toolInputRaw: message.metadata?.toolInputRaw as Record<string, unknown> | undefined,
        });
      }

      // Clear attachments after successful processing
      if (attachmentManager.hasAttachments(chatId)) {
        const count = attachmentManager.getAttachmentCount(chatId);
        attachmentManager.clearAttachments(chatId);
        this.logger.info({ chatId, clearedCount: count }, 'Cleared processed attachments');
      }

      // Return accumulated response
      return responseChunks.join('\n');
    } catch (error) {
      const enriched = handleError(error, {
        category: ErrorCategory.SDK,
        chatId,
        sessionId,
        userMessage: 'Agent processing failed. Please try again.'
      }, {
        log: true,
        customLogger: this.logger
      });

      const errorMsg = `❌ ${enriched.userMessage || enriched.message}`;
      await this.sendMessage(chatId, errorMsg);

      // Don't clear attachments on error - user can retry
      return errorMsg;
    }
  }

  /**
   * Handle /long command - start long task workflow.
   */
  private async handleLongTask(
    chatId: string,
    userRequest: string,
    _messageId?: string
  ): Promise<void> {
    try {
      // Get agent configuration
      const agentConfig = Config.getAgentConfig();

      // Create or get long task manager for this chat
      let taskManager = this.longTaskManagers.get(chatId);

      if (taskManager) {
        await this.sendMessage(
          chatId,
          '⚠️ A long task is already running in this chat. Please wait for it to complete or use /cancel to stop it.'
        );
        return;
      }

      // Create new long task manager
      taskManager = new LongTaskManager(
        agentConfig.apiKey,
        agentConfig.model,
        agentConfig.apiBaseUrl,
        {
          workspaceBaseDir: Config.getWorkspaceDir(),
          sendMessage: this.sendMessage.bind(this),
          sendCard: this.sendCard.bind(this),
          chatId,
          apiBaseUrl: agentConfig.apiBaseUrl,
          // Add 24-hour timeout for long tasks
          taskTimeoutMs: 24 * 60 * 60 * 1000,
        }
      );

      // Set manager in map BEFORE starting to prevent race condition
      this.longTaskManagers.set(chatId, taskManager);

      // Start long task workflow (non-blocking)
      taskManager.startLongTask(userRequest)
        .then(() => {
          this.logger.info({ chatId }, 'Long task completed');
        })
        .catch((error) => {
          handleError(error, {
            category: ErrorCategory.SDK,
            chatId,
            userMessage: 'Long task failed'
          }, {
            log: true,
            customLogger: this.logger
          });
        })
        .finally(() => {
          // Clean up manager after completion (only if it's still the same manager)
          const currentManager = this.longTaskManagers.get(chatId);
          if (currentManager === taskManager) {
            this.longTaskManagers.delete(chatId);
          }
        });

    } catch (error) {
      const enriched = handleError(error, {
        category: ErrorCategory.UNKNOWN,
        chatId,
        userMessage: 'Failed to start long task. Please try again.'
      }, {
        log: true,
        customLogger: this.logger
      });

      const errorMsg = `❌ ${enriched.userMessage || enriched.message}`;
      await this.sendMessage(chatId, errorMsg);

      // Clean up manager on error
      this.longTaskManagers.delete(chatId);
    }
  }

  /**
   * Handle image/file message - download and store for later processing.
   */
  private async handleFileMessage(
    chatId: string,
    messageType: string,
    content: any,
    messageId: string,
    _sender?: any
  ): Promise<void> {
    try {
      this.logger.info({ chatId, messageType, messageId }, 'File/image message received');

      // Extract file_key from content based on message type
      let fileKey: string | undefined;
      let fileName: string | undefined;

      if (messageType === 'image') {
        // Image message content: {"image_key":"..."}
        const parsed = JSON.parse(content);
        fileKey = parsed.image_key;
        // Provide default filename with extension for better file handling
        fileName = `image_${fileKey?.substring(0, 8)}.jpg`;
      } else if (messageType === 'file') {
        // File message content: {"file_key":"...","file_name":"..."}
        const parsed = JSON.parse(content);
        fileKey = parsed.file_key;
        fileName = parsed.file_name;
      } else if (messageType === 'media') {
        // Audio/video message
        const parsed = JSON.parse(content);
        fileKey = parsed.file_key || parsed.media_key;
        fileName = parsed.file_name || `media_${fileKey?.substring(0, 8)}.mp4`;
      }

      if (!fileKey) {
        this.logger.warn({ messageType, content }, 'No file_key found in message');
        await this.sendMessage(chatId, '⚠️ Unable to process this file (missing file_key)');
        return;
      }

      // Create attachment metadata
      const attachment: FileAttachment = {
        fileKey,
        fileType: messageType,
        fileName,
        timestamp: Date.now(),
        messageId, // Store messageId for downloading user uploads
      };

      // Download file immediately
      const client = this.getClient();
      try {
        const localPath = await downloadFile(client, fileKey, messageType, fileName, messageId);
        attachment.localPath = localPath;

        // Get file stats
        const stats = await import('./file-downloader.js').then(m => m.getFileStats(localPath));
        if (stats) {
          attachment.fileSize = stats.size;
        }

        // Store attachment
        attachmentManager.addAttachment(chatId, attachment);

        // Send confirmation to user
        const count = attachmentManager.getAttachmentCount(chatId);
        const sizeText = attachment.fileSize
          ? `(${(attachment.fileSize / 1024 / 1024).toFixed(2)} MB)`
          : '';

        // Add local path information if available
        const pathInfo = attachment.localPath
          ? `\n📁 Local path: \`${attachment.localPath}\``
          : '';

        await this.sendMessage(
          chatId,
          `✅ File received: ${attachment.fileName || messageType} ${sizeText}${pathInfo}\n\nPlease send a text command to process this file.\n\nPending files: ${count}`
        );

        this.logger.info({ chatId, fileKey, localPath }, 'File downloaded and stored');

      } catch (downloadError) {
        this.logger.error({ err: downloadError, fileKey }, 'Failed to download file');
        await this.sendMessage(
          chatId,
          '⚠️ Failed to download file. Please try again or contact support.'
        );
        return;
      }

    } catch (error) {
      this.logger.error({ err: error, chatId, messageType }, 'Failed to handle file message');
    }
  }

  /**
   * Handle incoming message event from WebSocket.
   */
  private async handleMessageReceive(data: any): Promise<void> {
    if (!this.running) {return;}

    const { message } = data;
    if (!message) {return;}

    const { message_id, chat_id, content, message_type, sender, create_time } = message;

    // Defensive: Validate required fields
    if (!message_id) {
      this.logger.warn('Missing message_id in message');
      return;
    }

    if (!chat_id) {
      this.logger.warn('Missing chat_id in message');
      return;
    }

    if (!content) {
      this.logger.warn('Missing content in message');
      return;
    }

    if (!message_type) {
      this.logger.warn('Missing message_type in message');
      return;
    }

    // Debug: log full message structure
    this.logger.debug({ keys: Object.keys(message), messageId: message_id, createTime: create_time }, 'Message keys');

    // Deduplication: skip already processed messages
    if (message_id) {
      this.logger.debug({ messageId: message_id }, 'Checking deduplication');
      // First check: in-memory cache
      if (this.processedMessageIds.has(message_id)) {
        this.logger.debug({ messageId: message_id }, 'Skipped duplicate message (in-memory)');
        return;
      }

      // Second check: file-based deduplication
      this.logger.debug('Checking file-based deduplication');
      const hasRecord = await this.taskTracker.hasTaskRecord(message_id);
      this.logger.debug({ hasRecord }, 'File-based deduplication result');
      if (hasRecord) {
        this.logger.debug({ messageId: message_id }, 'Skipped duplicate message (file-based)');
        // Add to memory cache to avoid repeated file checks
        this.processedMessageIds.add(message_id);
        return;
      }

      // Add to memory cache
      this.logger.debug('Adding to memory cache');
      this.processedMessageIds.add(message_id);

      // Prevent memory leak - remove old entries when limit is reached
      if (this.processedMessageIds.size > this.MAX_PROCESSED_IDS) {
        const first = this.processedMessageIds.values().next().value;
        if (first) {
          this.processedMessageIds.delete(first);
        }
      }
    }

    this.logger.debug('Checking sender type');
    // CRITICAL: Ignore messages sent by the bot itself
    // When bot sends a message, Feishu may trigger an event for it
    // We must skip these to prevent infinite loops
    if (sender?.sender_type === 'app') {
      this.logger.debug({ senderType: sender.sender_type }, 'Skipped bot message');
      return;
    }

    // Check message age - ignore old messages to prevent delayed processing
    this.logger.debug('Checking message age');
    if (create_time) {
      const currentTime = Date.now();
      const messageAge = currentTime - create_time;
      this.logger.debug({ ageMs: messageAge, maxAgeMs: this.MAX_MESSAGE_AGE }, 'Message age');

      if (messageAge > this.MAX_MESSAGE_AGE) {
        const ageSeconds = Math.floor(messageAge / 1000);
        this.logger.debug({ messageId: message_id, ageSeconds }, 'Skipped old message');
        return;
      }
    }

    this.logger.debug({ messageType: message_type }, 'Checking message type');
    // Handle file/image messages - download and store for later processing
    if (message_type === 'image' || message_type === 'file' || message_type === 'media') {
      await this.handleFileMessage(chat_id, message_type, content, message_id, sender);
      return;
    }

    // Handle text and post messages
    if (message_type !== 'text' && message_type !== 'post') {
      this.logger.debug({ messageType: message_type }, 'Skipped unsupported message type');
      return;
    }

    this.logger.debug('Parsing content');
    // Parse content
    let text = '';
    try {
      // Defensive: Ensure content is valid before parsing
      if (typeof content !== 'string') {
        this.logger.warn({ contentType: typeof content }, 'Invalid content type');
        return;
      }

      const parsed = JSON.parse(content);

      if (message_type === 'text') {
        text = parsed.text?.trim() || '';
      } else if (message_type === 'post') {
        // Extract text from post type (rich text)
        // Post structure: {"title":"","content":[[{"tag":"text","text":"...","style":[]}],...]}
        if (parsed.content && Array.isArray(parsed.content)) {
          // content is a 2D array of text segments
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
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to parse content');
      return;
    }

    this.logger.debug({ length: text.length }, 'Parsed text');
    if (!text) {
      this.logger.debug('Skipped empty text');
      return;
    }

    this.logger.info({ messageId: message_id, chatId: chat_id, messageType: message_type, textLength: text.length }, 'Message received');

    // Save task record BEFORE processing to prevent loss on restart
    // For restart commands, use sync write to ensure record is persisted before process exits
    if (message_id) {
      const metadata = {
        chatId: chat_id,
        senderType: sender?.sender_type,
        senderId: sender?.sender_id,
        text,
        timestamp: create_time || new Date().toISOString(),
      };

      // Check if this is a restart command
      const isRestartCommand = text.toLowerCase().includes('restart') &&
                               text.toLowerCase().includes('pm2');

      if (isRestartCommand) {
        // Use synchronous write for restart commands to ensure record persists before process exits
        this.logger.debug('Restart command detected, using sync write for task record');
        this.taskTracker.saveTaskRecordSync(
          message_id,
          metadata,
          '[Processing...]'
        );
      } else {
        // For normal messages, async write is fine
        await this.taskTracker.saveTaskRecord(
          message_id,
          metadata,
          '[Processing...]'
        );
      }
    }

    // Check for commands
    if (CommandHandlers.isCommand(text)) {
      const commandContext: CommandHandlerContext = {
        chatId: chat_id,
        sendMessage: this.sendMessage.bind(this),
        sessionManager: this.sessionManager,
        longTaskManagers: this.longTaskManagers,
      };

      // Handle special case for /long command (needs additional logic)
      if (text.trim().startsWith('/long ')) {
        const longTaskText = text.trim().substring(6).trim();
        await CommandHandlers.handleLongTaskCommand(commandContext, longTaskText);

        if (longTaskText) {
          // Proceed with long task setup
          await this.handleLongTask(chat_id, longTaskText, message_id);
        }
        return;
      }

      // Handle all other commands
      const handled = await CommandHandlers.executeCommand(commandContext, text);
      if (handled) {
        return;
      }
    }

    {
      // All messages are processed by the agent (including slash commands for SDK skills)
      const response = await this.processAgentMessage(
        chat_id,
        text,
        message_id,
        sender?.sender_id // Pass userId for message context
      );

      // Update task record with actual response
      if (message_id) {
        await this.taskTracker.saveTaskRecord(
          message_id,
          {
            chatId: chat_id,
            senderType: sender?.sender_type,
            senderId: sender?.sender_id,
            text,
            timestamp: create_time || new Date().toISOString(),
          },
          response
        );
      }
    }
  }

  /**
   * Start Feishu WebSocket bot.
   */
  async start(): Promise<void> {
    this.running = true;
    const agentConfig = Config.getAgentConfig();
    this.logger.info({ model: agentConfig.model }, 'Feishu bot starting');

    // Create event dispatcher
    this.eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        try {
          await this.handleMessageReceive(data);
        } catch (error) {
          this.logger.error({ err: error }, 'Failed to handle message receive');
        }
      },
      // Suppress warnings for unhandled events
      'im.message.message_read_v1': async () => {
        // Silently ignore message read events
      },
      'im.chat.access_event.bot_p2p_chat_entered_v1': async () => {
        // Silently ignore bot p2p chat entered events
      },
    });

    // Create WebSocket client
    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
    });

    // Start WebSocket connection
    await this.wsClient.start({
      eventDispatcher: this.eventDispatcher,
    });

    this.logger.info('Feishu WebSocket bot started');

    // Handle shutdown
    process.on('SIGINT', () => this.stop());
  }

  /**
   * Stop bot.
   */
  stop(): void {
    this.running = false;
    this.wsClient = undefined;
    this.logger.info('Feishu bot stopped');
  }
}
