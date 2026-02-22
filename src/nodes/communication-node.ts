/**
 * Communication Node - Handles Feishu communication.
 *
 * This module manages the Feishu bot and connects it to the Transport layer,
 * allowing it to send tasks to the Execution Node and receive message callbacks.
 *
 * In single-process mode, this runs alongside the Execution Node.
 * In multi-process mode, this runs in a separate process.
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { EventEmitter } from 'events';
import { Config } from '../config/index.js';
import { DEDUPLICATION } from '../config/constants.js';
import { TaskTracker } from '../utils/task-tracker.js';
import { createLogger } from '../utils/logger.js';
import { attachmentManager } from '../feishu/attachment-manager.js';
import { downloadFile } from '../feishu/file-downloader.js';
import { messageLogger } from '../feishu/message-logger.js';
import { FileHandler } from '../feishu/file-handler.js';
import { MessageSender } from '../feishu/message-sender.js';
import { TaskFlowOrchestrator } from '../feishu/task-flow-orchestrator.js';
import { setTaskFlowOrchestrator } from '../mcp/task-skill-mcp.js';
import type { ITransport, TaskRequest, MessageContent } from '../transport/index.js';
import type { ControlCommand } from '../transport/types.js';
import type { FeishuEventData, FeishuMessageEvent } from '../types/platform.js';

/**
 * Configuration for Communication Node.
 */
export interface CommunicationNodeConfig {
  /** Transport layer for communication */
  transport: ITransport;
  /** Feishu App ID */
  appId?: string;
  /** Feishu App Secret */
  appSecret?: string;
}

/**
 * Communication Node - Manages Feishu bot and Transport connection.
 *
 * Responsibilities:
 * - Receives messages from Feishu
 * - Sends tasks to Execution Node via Transport
 * - Receives message callbacks from Transport
 * - Sends messages to Feishu users
 */
export class CommunicationNode extends EventEmitter {
  private transport: ITransport;
  private appId: string;
  private appSecret: string;

  private client?: lark.Client;
  private wsClient?: lark.WSClient;
  private eventDispatcher?: lark.EventDispatcher;
  private running = false;
  private logger = createLogger('CommunicationNode');

  // Track processed message IDs to prevent duplicate processing
  private readonly MAX_MESSAGE_AGE = DEDUPLICATION.MAX_MESSAGE_AGE;

  // Task tracker for persistent deduplication
  private taskTracker: TaskTracker;

  // File handler for file/image message processing
  private fileHandler: FileHandler;

  // Message sender for sending messages
  private messageSender?: MessageSender;

  // Task flow orchestrator for dialogue execution
  private taskFlowOrchestrator: TaskFlowOrchestrator;

  constructor(config: CommunicationNodeConfig) {
    super();
    this.transport = config.transport;
    this.appId = config.appId || Config.FEISHU_APP_ID;
    this.appSecret = config.appSecret || Config.FEISHU_APP_SECRET;
    this.taskTracker = new TaskTracker();

    // Initialize FileHandler
    this.fileHandler = new FileHandler(
      attachmentManager,
      async (fileKey: string, messageType: string, fileName?: string, messageId?: string) => {
        if (!this.client) {
          this.logger.error({ fileKey }, 'Client not initialized for file download');
          return { success: false };
        }
        try {
          const filePath = await downloadFile(this.client, fileKey, messageType, fileName, messageId);
          return { success: true, filePath };
        } catch (error) {
          this.logger.error({ err: error, fileKey, messageType }, 'File download failed');
          return { success: false };
        }
      }
    );

    // Initialize TaskFlowOrchestrator
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

    // Register message handler with Transport
    this.transport.onMessage(this.handleTransportMessage.bind(this));

    this.logger.info('CommunicationNode created');
  }

  /**
   * Handle messages from Execution Node via Transport.
   */
  private async handleTransportMessage(content: MessageContent): Promise<void> {
    try {
      switch (content.type) {
        case 'text':
          if (content.text) {
            await this.sendMessage(content.chatId, content.text);
          }
          break;
        case 'card':
          await this.sendCard(content.chatId, content.card || {}, content.description);
          break;
        case 'file':
          if (content.filePath) {
            await this.sendFileToUser(content.chatId, content.filePath);
          }
          break;
        default:
          this.logger.warn({ type: content.type }, 'Unknown message type from Transport');
      }
    } catch (error) {
      this.logger.error({ err: error, content }, 'Failed to handle Transport message');
    }
  }

  /**
   * Send a task to the Execution Node via Transport.
   */
  private async sendTaskToExecution(request: TaskRequest): Promise<void> {
    const response = await this.transport.sendTask(request);
    if (!response.success) {
      this.logger.error({ taskId: request.taskId, error: response.error }, 'Task send failed');
      await this.sendMessage(
        request.chatId,
        `❌ 任务发送失败: ${response.error || 'Unknown error'}`
      );
    }
  }

  /**
   * Get or create Lark HTTP client.
   */
  private getClient(): lark.Client {
    if (!this.client) {
      this.client = new lark.Client({
        appId: this.appId,
        appSecret: this.appSecret,
      });
      this.messageSender = new MessageSender({
        client: this.client,
        logger: this.logger,
      });
    }
    return this.client;
  }

  /**
   * Send a text message to Feishu.
   */
  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.messageSender) {
      this.getClient();
    }
    const sender = this.messageSender;
    if (!sender) {
      throw new Error('MessageSender not initialized');
    }
    await sender.sendText(chatId, text);
  }

  /**
   * Send an interactive card to Feishu.
   */
  async sendCard(
    chatId: string,
    card: Record<string, unknown>,
    description?: string
  ): Promise<void> {
    if (!this.messageSender) {
      this.getClient();
    }
    const sender = this.messageSender;
    if (!sender) {
      throw new Error('MessageSender not initialized');
    }
    await sender.sendCard(chatId, card, description);
  }

  /**
   * Send a file to Feishu user.
   */
  async sendFileToUser(chatId: string, filePath: string): Promise<void> {
    if (!this.messageSender) {
      this.getClient();
    }
    const sender = this.messageSender;
    if (!sender) {
      throw new Error('MessageSender not initialized');
    }
    await sender.sendFile(chatId, filePath);
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
   * Handle incoming message event from WebSocket.
   */
  private async handleMessageReceive(data: FeishuEventData): Promise<void> {
    if (!this.running) return;

    this.getClient();

    const event = (data.event || data) as FeishuMessageEvent;
    const { message, sender } = event;

    if (!message) return;

    const { message_id, chat_id, content, message_type, create_time } = message;

    if (!message_id || !chat_id || !content || !message_type) {
      this.logger.warn('Missing required message fields');
      return;
    }

    // Deduplication
    if (messageLogger.isMessageProcessed(message_id)) {
      this.logger.debug({ messageId: message_id }, 'Skipped duplicate message');
      return;
    }

    // Ignore bot messages
    if (sender?.sender_type === 'app') {
      this.logger.debug('Skipped bot message');
      return;
    }

    // Check message age
    if (create_time) {
      const messageAge = Date.now() - create_time;
      if (messageAge > this.MAX_MESSAGE_AGE) {
        this.logger.debug({ messageId: message_id }, 'Skipped old message');
        return;
      }
    }

    // Handle file/image messages
    if (message_type === 'image' || message_type === 'file' || message_type === 'media') {
      const result = await this.fileHandler.handleFileMessage(chat_id, message_type, content, message_id);
      if (!result.success) {
        await this.sendMessage(
          chat_id,
          `❌ 处理${message_type === 'image' ? '图片' : '文件'}失败`
        );
        return;
      }

      const attachments = attachmentManager.getAttachments(chat_id);
      if (attachments.length > 0) {
        const latestAttachment = attachments[attachments.length - 1];
        const uploadPrompt = this.fileHandler.buildUploadPrompt(latestAttachment);
        const enhancedPrompt = `You are responding in a Feishu chat.\n\n**Chat ID:** ${chat_id}\n\n---- User Message ---\n${uploadPrompt}`;

        await messageLogger.logIncomingMessage(
          message_id,
          this.extractOpenId(sender) || 'unknown',
          chat_id,
          `[File uploaded: ${latestAttachment.fileName}]`,
          message_type,
          create_time
        );

        // Send task to Execution Node
        await this.sendTaskToExecution({
          taskId: `${message_id}-file`,
          chatId: chat_id,
          message: enhancedPrompt,
          messageId: message_id,
          senderOpenId: this.extractOpenId(sender),
        });
      }
      return;
    }

    // Handle text and post messages
    if (message_type !== 'text' && message_type !== 'post') {
      this.logger.debug({ messageType: message_type }, 'Skipped unsupported message type');
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
      this.logger.error('Failed to parse content');
      return;
    }

    if (!text) {
      this.logger.debug('Skipped empty text');
      return;
    }

    this.logger.info({ messageId: message_id, chatId: chat_id }, 'Message received');

    // Log message
    await messageLogger.logIncomingMessage(
      message_id,
      this.extractOpenId(sender) || 'unknown',
      chat_id,
      text,
      message_type,
      create_time
    );

    // Handle special commands
    if (text.trim() === '/reset') {
      this.logger.info({ chatId: chat_id }, 'Reset command triggered');

      // Send reset control command to Execution Node
      const controlCommand: ControlCommand = {
        type: 'reset',
        chatId: chat_id,
      };
      const response = await this.transport.sendControl(controlCommand);

      if (response.success) {
        await this.sendMessage(chat_id, '✅ **对话已重置**\n\n新的会话已启动，之前的上下文已清除。');
      } else {
        await this.sendMessage(chat_id, `❌ 重置失败: ${response.error || 'Unknown error'}`);
      }
      return;
    }

    // Handle /restart command
    if (text.trim() === '/restart') {
      this.logger.info({ chatId: chat_id }, 'Restart command triggered');

      await this.sendMessage(chat_id, '🔄 **正在重启服务...**\n\nPM2 服务即将重启，请稍候。');

      // Send restart control command
      const controlCommand: ControlCommand = {
        type: 'restart',
        chatId: chat_id,
      };
      await this.transport.sendControl(controlCommand);

      // Execute PM2 restart
      try {
        const { exec } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execAsync = promisify(exec);
        await execAsync('pm2 restart disclaude-feishu');
        this.logger.info('PM2 service restarted successfully');
      } catch (error) {
        this.logger.error({ err: error }, 'Failed to restart PM2 service');
      }
      return;
    }

    // Send task to Execution Node
    await this.sendTaskToExecution({
      taskId: message_id,
      chatId: chat_id,
      message: text,
      messageId: message_id,
      senderOpenId: this.extractOpenId(sender),
    });
  }

  /**
   * Start the Communication Node.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('CommunicationNode already running');
      return;
    }

    this.running = true;

    // Start Transport
    await this.transport.start();

    // Initialize message logger
    await messageLogger.init();

    // Create event dispatcher
    this.eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        try {
          await this.handleMessageReceive(data as FeishuEventData);
        } catch (error) {
          this.logger.error({ err: error }, 'Failed to handle message receive');
        }
      },
      'im.message.message_read_v1': async () => {},
      'im.chat.access_event.bot_p2p_chat_entered_v1': async () => {},
    });

    // Create WebSocket client
    const sdkLogger = {
      error: (...msg: unknown[]) => this.logger.error({ context: 'LarkSDK' }, String(msg)),
      warn: (...msg: unknown[]) => this.logger.warn({ context: 'LarkSDK' }, String(msg)),
      info: (...msg: unknown[]) => this.logger.info({ context: 'LarkSDK' }, String(msg)),
      debug: (...msg: unknown[]) => this.logger.debug({ context: 'LarkSDK' }, String(msg)),
      trace: (...msg: unknown[]) => this.logger.trace({ context: 'LarkSDK' }, String(msg)),
    };

    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      logger: sdkLogger,
      loggerLevel: lark.LoggerLevel.info,
    });

    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });

    this.logger.info('CommunicationNode started');
  }

  /**
   * Stop the Communication Node.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;
    this.wsClient = undefined;
    await this.transport.stop();
    this.logger.info('CommunicationNode stopped');
  }

  /**
   * Check if the node is running.
   */
  isRunning(): boolean {
    return this.running;
  }
}
