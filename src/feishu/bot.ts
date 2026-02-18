/**
 * Feishu/Lark bot using WebSocket API.
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { EventEmitter } from 'events';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { Config } from '../config/index.js';
import { DEDUPLICATION } from '../config/constants.js';
import { TaskTracker } from '../utils/task-tracker.js';
import { createLogger } from '../utils/logger.js';
import { attachmentManager } from './attachment-manager.js';
import { downloadFile } from './file-downloader.js';
import { messageLogger } from './message-logger.js';
import { Pilot } from '../agents/pilot.js';
import { FileHandler } from './file-handler.js';
import { MessageSender } from './message-sender.js';
import { TaskFlowOrchestrator } from './task-flow-orchestrator.js';
import { setTaskFlowOrchestrator } from '../mcp/task-skill-mcp.js';
import type { FeishuEventData, FeishuMessageEvent } from '../types/platform.js';

const execAsync = promisify(exec);

/**
 * Feishu/Lark bot using WebSocket.
 */
export class FeishuBot extends EventEmitter {
  readonly appId: string;
  readonly appSecret: string;

  private client?: lark.Client;
  private wsClient?: lark.WSClient;
  private eventDispatcher?: lark.EventDispatcher;
  private running = false;
  private logger = createLogger('FeishuBot');

  // Track processed message IDs to prevent duplicate processing
  // Note: processedMessageIds moved to MessageLogger for deduplication via MD files
  private readonly MAX_MESSAGE_AGE = DEDUPLICATION.MAX_MESSAGE_AGE;

  // Task tracker for persistent deduplication
  private taskTracker: TaskTracker;

  // File handler for file/image message processing
  private fileHandler: FileHandler;

  // Message sender for sending messages
  private messageSender?: MessageSender;

  // Task flow orchestrator for dialogue execution (triggered by start_dialogue tool)
  private taskFlowOrchestrator: TaskFlowOrchestrator;

  // Pilot instance for all message handling
  private pilot: Pilot;

  constructor(
    appId: string,
    appSecret: string
  ) {
    super();
    this.appId = appId;
    this.appSecret = appSecret;
    this.taskTracker = new TaskTracker();

    // Initialize FileHandler with a wrapped downloadFile that will be bound later
    // The client is not available yet, so we pass a placeholder that will be replaced
    this.fileHandler = new FileHandler(
      attachmentManager,
      async (
        fileKey: string,
        messageType: string,
        fileName?: string,
        messageId?: string
      ): Promise<{ success: boolean; filePath?: string }> => {
        if (!this.client) {
          this.logger.error({ fileKey }, 'Client not initialized for file download');
          return { success: false };
        }
        try {
          const filePath = await downloadFile(this.client, fileKey, messageType, fileName, messageId);
          return {
            success: true,
            filePath
          };
        } catch (error) {
          this.logger.error({ err: error, fileKey, messageType }, 'File download failed');
          return { success: false };
        }
      }
    );

    // Initialize TaskFlowOrchestrator for dialogue phase
    this.taskFlowOrchestrator = new TaskFlowOrchestrator(
      this.taskTracker,
      {
        sendMessage: this.sendMessage.bind(this),
        sendCard: this.sendCard.bind(this),
        sendFile: this.sendFileToUser.bind(this),
      },
      this.logger
    );

    // Register TaskFlowOrchestrator for task skill MCP tool access
    setTaskFlowOrchestrator(this.taskFlowOrchestrator);

    // Initialize Pilot with Feishu-specific callbacks
    const agentConfig = Config.getAgentConfig();
    this.pilot = new Pilot({
      apiKey: agentConfig.apiKey,
      model: agentConfig.model,
      apiBaseUrl: agentConfig.apiBaseUrl,
      callbacks: {
        sendMessage: this.sendMessage.bind(this),
        sendCard: this.sendCard.bind(this),
        sendFile: this.sendFileToUser.bind(this),
      },
    });
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
      // Initialize MessageSender when client is created
      this.messageSender = new MessageSender({
        client: this.client,
        logger: this.logger,
      });
    }
    return this.client;
  }

  /**
   * Send a message to Feishu.
   * Currently using plain text format only (rich text temporarily disabled).
   */
  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.messageSender) {
      this.getClient(); // Initialize messageSender
    }
    // After getClient(), messageSender is guaranteed to be initialized
    const sender = this.messageSender;
    if (!sender) {
      throw new Error('MessageSender not initialized');
    }
    await sender.sendText(chatId, text);
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
    if (!this.messageSender) {
      this.getClient(); // Initialize messageSender
    }
    // After getClient(), messageSender is guaranteed to be initialized
    const sender = this.messageSender;
    if (!sender) {
      throw new Error('MessageSender not initialized');
    }
    await sender.sendCard(chatId, card, description);
  }

  /**
   * Send a file to Feishu user as an attachment.
   * Uploads the file and sends it as a file message.
   *
   * @param chatId - Target chat ID
   * @param filePath - Local file path to send
   */
  async sendFileToUser(chatId: string, filePath: string): Promise<void> {
    if (!this.messageSender) {
      this.getClient(); // Initialize messageSender
    }
    // After getClient(), messageSender is guaranteed to be initialized
    const sender = this.messageSender;
    if (!sender) {
      throw new Error('MessageSender not initialized');
    }
    await sender.sendFile(chatId, filePath);
  }


  /**
   * Extract open_id from sender object.
   * Feishu event structure: sender.sender_id.open_id
   *
   * @param sender - Sender object from Feishu event
   * @returns open_id string or undefined
   */
  private extractOpenId(sender?: { sender_type?: string; sender_id?: unknown }): string | undefined {
    if (!sender?.sender_id) {
      return undefined;
    }
    // Feishu event: sender_id is an object containing open_id
    if (typeof sender.sender_id === 'object' && sender.sender_id !== null) {
      const senderId = sender.sender_id as { open_id?: string; union_id?: string; user_id?: string };
      return senderId.open_id;
    }
    // Fallback: if sender_id is a string (legacy format)
    if (typeof sender.sender_id === 'string') {
      return sender.sender_id;
    }
    return undefined;
  }

  /**
   * Handle direct chat mode - All messages go through Pilot.
   *
   * Pilot handles:
   * - Direct chat for simple queries
   * - Task skill activation for complex requests
   * - Task.md creation and start_dialogue tool calling
   *
   * @param chatId - Feishu chat ID
   * @param text - User's message text
   * @param messageId - Unique message identifier (for tracking only)
   * @param sender - Message sender info (contains open_id for @ mentions)
   * @returns Accumulated response content
   */
  private handleDirectChat(
    chatId: string,
    text: string,
    messageId: string,
    sender?: { sender_type?: string; sender_id?: unknown }
  ): string {
    // Clear attachments after processing (they were already notified via buildFileUploadPrompt)
    if (attachmentManager.hasAttachments(chatId)) {
      attachmentManager.clearAttachments(chatId);
      this.logger.debug({ chatId }, 'Attachments cleared after system notification');
    }

    // Extract sender's open_id for @ mention capability
    const senderOpenId = this.extractOpenId(sender);

    // Delegate to Pilot for all message handling
    this.pilot.processMessage(chatId, text, messageId, senderOpenId);

    return '';
  }

  /**
   * Handle incoming message event from WebSocket.
   */
  private async handleMessageReceive(data: FeishuEventData): Promise<void> {
    if (!this.running) { return; }

    // Ensure client is initialized before processing any message
    // This is critical for file/image downloads which need the client
    this.getClient();

    // Feishu event structure: data.event contains both sender and message
    // See: https://open.feishu.cn/document/server-docs/im-v1/message/events/receive_v1
    const event = (data.event || data) as FeishuMessageEvent;
    const { message, sender } = event;

    if (!message) { return; }

    const { message_id, chat_id, content, message_type, create_time } = message;

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

      // Use MessageLogger (all message IDs loaded at startup)
      if (messageLogger.isMessageProcessed(message_id)) {
        this.logger.debug({ messageId: message_id }, 'Skipped duplicate message');
        return;
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
      const result = await this.fileHandler.handleFileMessage(chat_id, message_type, content, message_id);
      if (!result.success) {
        // Send error feedback to user
        await this.sendMessage(
          chat_id,
          `❌ 处理${message_type === 'image' ? '图片' : '文件'}失败：无法从飞书下载文件。这可能是因为文件已过期或权限不足。`
        );
        return;
      }

      // File downloaded successfully - notify Pilot with preset prompt
      const attachments = attachmentManager.getAttachments(chat_id);
      if (attachments.length > 0) {
        const latestAttachment = attachments[attachments.length - 1];
        const uploadPrompt = this.fileHandler.buildUploadPrompt(latestAttachment);

        // Add Feishu chat context to prompt
        const enhancedPrompt = `You are responding in a Feishu chat.

**Chat ID for sending files/messages:** ${chat_id}

When using tools like send_file_to_feishu or send_user_feedback, use this exact Chat ID value.

---- User Message ---
${uploadPrompt}`;

        // Log to file upload to message history (this also marks message as processed)
        await messageLogger.logIncomingMessage(
          message_id,
          this.extractOpenId(sender) || 'unknown',
          chat_id,
          `[File uploaded: ${latestAttachment.fileName}]`,
          message_type,
          create_time
        );

        // Process file upload notification via Pilot
        this.pilot.processMessage(chat_id, enhancedPrompt, message_id);

        this.logger.info({
          chatId: chat_id,
          fileKey: latestAttachment.fileKey,
          fileName: latestAttachment.fileName
        }, 'File upload notification sent to Pilot');
      }

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
        // Post structure: {"title":"","content":[{"tag":"text","text":"...","style":[]},...]}
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

    // Log to persistent MD file (replaces in-memory history)
    await messageLogger.logIncomingMessage(
      message_id,
      this.extractOpenId(sender) || 'unknown',
      chat_id,
      text,
      message_type,
      create_time
    );

    // Check for /reset command
    if (text.trim() === '/reset') {
      this.logger.info({ chatId: chat_id }, 'Reset command triggered');
      this.pilot.resetAll();
      await this.sendMessage(
        chat_id,
        '✅ **对话已重置**\n\n新的会话已启动，之前的上下文已清除。'
      );
      return;
    }

    // Check for /restart command
    if (text.trim() === '/restart') {
      this.logger.info({ chatId: chat_id }, 'Restart command triggered');
      await this.sendMessage(
        chat_id,
        '🔄 **正在重启服务...**\n\nPM2 服务即将重启，请稍候。'
      );
      try {
        await execAsync('pm2 restart disclaude-feishu');
        this.logger.info('PM2 service restarted successfully');
      } catch (error) {
        this.logger.error({ err: error }, 'Failed to restart PM2 service');
      }
      return;
    }

    // DEFAULT: All messages go through Pilot
    // Pilot handles task skill activation internally
    await this.handleDirectChat(chat_id, text, message_id, sender);
  }

  /**
   * Start Feishu WebSocket bot.
   */
  async start(): Promise<void> {
    this.running = true;
    const agentConfig = Config.getAgentConfig();
    this.logger.info({ model: agentConfig.model }, 'Feishu bot starting');

    // Initialize message logger BEFORE processing any messages
    this.logger.debug('Initializing message logger...');
    await messageLogger.init();
    this.logger.debug('Message logger initialized');

    // Create event dispatcher
    this.eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        try {
          await this.handleMessageReceive(data as FeishuEventData);
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

    // Create SDK logger adapter to integrate Lark SDK logs with Pino
    const sdkLogger = {
      error: (...msg: unknown[]) => this.logger.error({ context: 'LarkSDK' }, String(msg)),
      warn: (...msg: unknown[]) => this.logger.warn({ context: 'LarkSDK' }, String(msg)),
      info: (...msg: unknown[]) => this.logger.info({ context: 'LarkSDK' }, String(msg)),
      debug: (...msg: unknown[]) => this.logger.debug({ context: 'LarkSDK' }, String(msg)),
      trace: (...msg: unknown[]) => this.logger.trace({ context: 'LarkSDK' }, String(msg)),
    };

    // Create WebSocket client with custom logger
    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      logger: sdkLogger,
      loggerLevel: lark.LoggerLevel.info,
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
