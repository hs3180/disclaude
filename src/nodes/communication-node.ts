/**
 * Communication Node - Handles Feishu communication.
 *
 * This module manages the Feishu bot and forwards prompts to Execution Node via WebSocket.
 */

import * as lark from '@larksuiteoapi/node-sdk';
import WebSocket from 'ws';
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
import type { FeishuEventData, FeishuMessageEvent } from '../types/platform.js';

const logger = createLogger('CommunicationNode');

/**
 * Configuration for Communication Node.
 */
export interface CommunicationNodeConfig {
  /** URL of Execution Node WebSocket (e.g., ws://localhost:3002) */
  executionUrl: string;
  /** Feishu App ID */
  appId?: string;
  /** Feishu App Secret */
  appSecret?: string;
  /** Reconnect interval in ms */
  reconnectInterval?: number;
}

/**
 * WebSocket message types.
 */
interface PromptMessage {
  type: 'prompt';
  chatId: string;
  prompt: string;
  messageId: string;
  senderOpenId?: string;
}

interface FeedbackMessage {
  type: 'text' | 'card' | 'file' | 'done' | 'error';
  chatId: string;
  text?: string;
  card?: Record<string, unknown>;
  filePath?: string;
  error?: string;
}

/**
 * Communication Node - Manages Feishu bot and WebSocket communication with Execution Node.
 *
 * Responsibilities:
 * - Receives messages from Feishu
 * - Forwards prompts to Execution Node via WebSocket
 * - Receives feedback from Execution Node via WebSocket
 * - Sends messages to Feishu users
 */
export class CommunicationNode extends EventEmitter {
  private executionUrl: string;
  private appId: string;
  private appSecret: string;
  private reconnectInterval: number;

  private client?: lark.Client;
  private wsClient?: lark.WSClient;
  private eventDispatcher?: lark.EventDispatcher;
  private execWs?: WebSocket;
  private running = false;
  private reconnectTimer?: NodeJS.Timeout;

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
    this.executionUrl = config.executionUrl;
    this.appId = config.appId || Config.FEISHU_APP_ID;
    this.appSecret = config.appSecret || Config.FEISHU_APP_SECRET;
    this.reconnectInterval = config.reconnectInterval || 3000;
    this.taskTracker = new TaskTracker();

    // Initialize FileHandler
    this.fileHandler = new FileHandler(
      attachmentManager,
      async (fileKey: string, messageType: string, fileName?: string, messageId?: string) => {
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
      logger
    );

    // Register TaskFlowOrchestrator for task skill MCP tool access
    setTaskFlowOrchestrator(this.taskFlowOrchestrator);

    logger.info({ executionUrl: this.executionUrl }, 'CommunicationNode created');
  }

  /**
   * Connect to Execution Node via WebSocket.
   */
  private connectToExecutionNode(): void {
    if (this.execWs?.readyState === WebSocket.OPEN) {
      return;
    }

    logger.info({ url: this.executionUrl }, 'Connecting to Execution Node...');

    this.execWs = new WebSocket(this.executionUrl);

    this.execWs.on('open', () => {
      logger.info('Connected to Execution Node');
      this.emit('exec:connected');
    });

    this.execWs.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as FeedbackMessage;
        this.handleFeedback(message);
      } catch (error) {
        logger.error({ err: error }, 'Failed to parse feedback');
      }
    });

    this.execWs.on('close', () => {
      logger.info('Disconnected from Execution Node');
      this.emit('exec:disconnected');

      // Reconnect if still running
      if (this.running) {
        this.scheduleReconnect();
      }
    });

    this.execWs.on('error', (error) => {
      logger.error({ err: error }, 'WebSocket error');
    });
  }

  /**
   * Schedule reconnection to Execution Node.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      if (this.running) {
        this.connectToExecutionNode();
      }
    }, this.reconnectInterval);
  }

  /**
   * Send prompt to Execution Node via WebSocket.
   */
  private async sendPrompt(message: PromptMessage): Promise<void> {
    if (!this.execWs || this.execWs.readyState !== WebSocket.OPEN) {
      logger.warn('Not connected to Execution Node, reconnecting...');
      this.connectToExecutionNode();

      // Wait for connection
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, 5000);

        this.once('exec:connected', () => {
          clearTimeout(timeout);
          resolve();
        });
      }).catch(async (error) => {
        logger.error({ err: error }, 'Failed to connect to Execution Node');
        await this.sendMessage(message.chatId, '❌ 无法连接到执行节点');
        throw error;
      });
    }

    this.execWs!.send(JSON.stringify(message));
    logger.info({ chatId: message.chatId, messageId: message.messageId }, 'Prompt sent to Execution Node');
  }

  /**
   * Handle feedback from Execution Node.
   */
  private async handleFeedback(message: FeedbackMessage): Promise<void> {
    const { chatId, type, text, card, filePath, error } = message;

    try {
      switch (type) {
        case 'text':
          if (text) {
            await this.sendMessage(chatId, text);
          }
          break;
        case 'card':
          await this.sendCard(chatId, card || {});
          break;
        case 'file':
          if (filePath) {
            await this.sendFileToUser(chatId, filePath);
          }
          break;
        case 'done':
          logger.info({ chatId }, 'Execution completed');
          break;
        case 'error':
          logger.error({ chatId, error }, 'Execution error');
          await this.sendMessage(chatId, `❌ 执行错误: ${error || 'Unknown error'}`);
          break;
      }
    } catch (err) {
      logger.error({ err, message }, 'Failed to handle feedback');
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
        logger,
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
      logger.warn('Missing required message fields');
      return;
    }

    // Deduplication
    if (messageLogger.isMessageProcessed(message_id)) {
      logger.debug({ messageId: message_id }, 'Skipped duplicate message');
      return;
    }

    // Ignore bot messages
    if (sender?.sender_type === 'app') {
      logger.debug('Skipped bot message');
      return;
    }

    // Check message age
    if (create_time) {
      const messageAge = Date.now() - create_time;
      if (messageAge > this.MAX_MESSAGE_AGE) {
        logger.debug({ messageId: message_id }, 'Skipped old message');
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

        // Send prompt to Execution Node
        await this.sendPrompt({
          type: 'prompt',
          chatId: chat_id,
          prompt: enhancedPrompt,
          messageId: `${message_id}-file`,
          senderOpenId: this.extractOpenId(sender),
        });
      }
      return;
    }

    // Handle text and post messages
    if (message_type !== 'text' && message_type !== 'post') {
      logger.debug({ messageType: message_type }, 'Skipped unsupported message type');
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

    // Handle /reset command
    if (text.trim() === '/reset') {
      logger.info({ chatId: chat_id }, 'Reset command triggered');
      await this.sendMessage(chat_id, '✅ **对话已重置**\n\n新的会话已启动，之前的上下文已清除。');
      return;
    }

    // Handle /restart command
    if (text.trim() === '/restart') {
      logger.info({ chatId: chat_id }, 'Restart command triggered');
      await this.sendMessage(chat_id, '🔄 **正在重启服务...**\n\nPM2 服务即将重启，请稍候。');

      try {
        const { exec } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execAsync = promisify(exec);
        await execAsync('pm2 restart disclaude-feishu');
        logger.info('PM2 service restarted successfully');
      } catch (error) {
        logger.error({ err: error }, 'Failed to restart PM2 service');
      }
      return;
    }

    // Handle /status command
    if (text.trim() === '/status') {
      const status = this.running ? 'Running' : 'Stopped';
      const execConnected = this.execWs?.readyState === WebSocket.OPEN ? 'Connected' : 'Disconnected';
      await this.sendMessage(chat_id, `📊 **状态**\n\n状态: ${status}\nExecution Node: ${execConnected}\nURL: ${this.executionUrl}`);
      return;
    }

    // Send prompt to Execution Node
    await this.sendPrompt({
      type: 'prompt',
      chatId: chat_id,
      prompt: text,
      messageId: message_id,
      senderOpenId: this.extractOpenId(sender),
    });
  }

  /**
   * Start the Communication Node.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('CommunicationNode already running');
      return;
    }

    this.running = true;

    // Connect to Execution Node
    this.connectToExecutionNode();

    // Initialize message logger
    await messageLogger.init();

    // Create event dispatcher
    this.eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        try {
          await this.handleMessageReceive(data as FeishuEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle message receive');
        }
      },
      'im.message.message_read_v1': async () => {},
      'im.chat.access_event.bot_p2p_chat_entered_v1': async () => {},
    });

    // Create WebSocket client
    const sdkLogger = {
      error: (...msg: unknown[]) => logger.error({ context: 'LarkSDK' }, String(msg)),
      warn: (...msg: unknown[]) => logger.warn({ context: 'LarkSDK' }, String(msg)),
      info: (...msg: unknown[]) => logger.info({ context: 'LarkSDK' }, String(msg)),
      debug: (...msg: unknown[]) => logger.debug({ context: 'LarkSDK' }, String(msg)),
      trace: (...msg: unknown[]) => logger.trace({ context: 'LarkSDK' }, String(msg)),
    };

    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      logger: sdkLogger,
      loggerLevel: lark.LoggerLevel.info,
    });

    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });

    logger.info('CommunicationNode started');
    console.log('✓ Communication Node ready');
    console.log();
    console.log(`Execution Node: ${this.executionUrl}`);
  }

  /**
   * Stop the Communication Node.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    // Close WebSocket connection to Execution Node
    if (this.execWs) {
      this.execWs.close();
      this.execWs = undefined;
    }

    this.wsClient = undefined;

    logger.info('CommunicationNode stopped');
  }

  /**
   * Check if the node is running.
   */
  isRunning(): boolean {
    return this.running;
  }
}
