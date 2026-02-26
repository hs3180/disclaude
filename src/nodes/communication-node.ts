/**
 * Communication Node - Handles multi-channel communication.
 *
 * This module manages multiple communication channels (Feishu, REST, etc.)
 * and forwards prompts to Execution Node via WebSocket.
 *
 * Architecture:
 * ```
 *                    ┌─────────────────────────────┐
 *   Feishu Channel ──│                             │
 *   REST Channel   ──│    Communication Node       │── Execution Node
 *   (future)       ──│    (Channel Multiplexer)    │    (via WebSocket)
 *                    │                             │
 *                    └─────────────────────────────┘
 */

import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import { EventEmitter } from 'events';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import type { IChannel, IncomingMessage, OutgoingMessage, ControlCommand, ControlResponse } from '../channels/index.js';
import { FeishuChannel } from '../channels/feishu-channel.js';
import { RestChannel } from '../channels/rest-channel.js';
import type { PromptMessage, CommandMessage, FeedbackMessage } from '../types/websocket-messages.js';
import type { FileReference } from '../types/file-reference.js';
import { FileStorageService, type FileStorageConfig } from '../services/file-storage-service.js';
import { createFileTransferAPIHandler } from '../services/file-transfer-api.js';

const logger = createLogger('CommunicationNode');

/**
 * Configuration for Communication Node.
 */
export interface CommunicationNodeConfig {
  /** Port for WebSocket server (default: 3001) */
  port: number;
  /** Host for WebSocket server */
  host?: string;
  /** Feishu App ID (for backward compatibility) */
  appId?: string;
  /** Feishu App Secret (for backward compatibility) */
  appSecret?: string;
  /** REST channel port (default: 3000) */
  restPort?: number;
  /** Enable REST channel */
  enableRestChannel?: boolean;
  /** REST channel auth token */
  restAuthToken?: string;
  /** Custom channels to register */
  channels?: IChannel[];
  /** File storage configuration */
  fileStorage?: FileStorageConfig;
}

/**
 * Communication Node - Manages multiple channels and WebSocket communication with Execution Node.
 *
 * Responsibilities:
 * - Manages multiple communication channels (Feishu, REST, etc.)
 * - Runs WebSocket server for Execution Nodes to connect
 * - Forwards prompts from channels to connected Execution Node via WebSocket
 * - Receives feedback from Execution Node via WebSocket
 * - Routes feedback back to appropriate channels
 */
export class CommunicationNode extends EventEmitter {
  private port: number;
  private host: string;

  private httpServer?: http.Server;
  private wss?: WebSocketServer;
  private execWs?: WebSocket;
  private running = false;

  // Registered channels
  private channels: Map<string, IChannel> = new Map();

  // File storage service
  private fileStorageService?: FileStorageService;
  private fileStorageConfig?: FileStorageConfig;

  constructor(config: CommunicationNodeConfig) {
    super();
    this.port = config.port;
    this.host = config.host || '0.0.0.0';

    // Store file storage config for later initialization
    this.fileStorageConfig = config.fileStorage;

    // Register custom channels if provided
    if (config.channels) {
      for (const channel of config.channels) {
        this.registerChannel(channel);
      }
    }

    // Create Feishu channel (for backward compatibility)
    const appId = config.appId || Config.FEISHU_APP_ID;
    const appSecret = config.appSecret || Config.FEISHU_APP_SECRET;
    if (appId && appSecret) {
      const feishuChannel = new FeishuChannel({
        id: 'feishu',
        appId,
        appSecret,
      });

      // Initialize TaskFlowOrchestrator for Feishu channel
      feishuChannel.initTaskFlowOrchestrator({
        sendMessage: this.sendMessage.bind(this),
        sendCard: this.sendCard.bind(this),
        sendFile: this.sendFileToUser.bind(this),
      });

      this.registerChannel(feishuChannel);
      logger.info('Feishu channel registered');
    }

    // Create REST channel if enabled
    if (config.enableRestChannel !== false) {
      const restChannel = new RestChannel({
        id: 'rest',
        port: config.restPort || 3000,
        authToken: config.restAuthToken,
      });
      this.registerChannel(restChannel);
      logger.info({ port: config.restPort || 3000 }, 'REST channel registered');
    }

    logger.info({ port: this.port, host: this.host }, 'CommunicationNode created');
  }

  /**
   * Register a communication channel.
   */
  registerChannel(channel: IChannel): void {
    if (this.channels.has(channel.id)) {
      logger.warn({ channelId: channel.id }, 'Channel already registered, replacing');
    }

    this.channels.set(channel.id, channel);

    // Set up message handler
    channel.onMessage(async (message: IncomingMessage) => {
      try {
        logger.debug({ channelId: channel.id, messageId: message.messageId }, 'handleChannelMessage invoked');
        await this.handleChannelMessage(channel.id, message);
        logger.debug({ channelId: channel.id, messageId: message.messageId }, 'handleChannelMessage completed');
      } catch (error) {
        logger.error({ err: error, channelId: channel.id, messageId: message.messageId }, 'Failed to handle channel message');
      }
    });

    // Set up control handler
    channel.onControl((command: ControlCommand) => {
      return this.handleControlCommand(command);
    });

    logger.info({ channelId: channel.id, channelName: channel.name }, 'Channel registered');
  }

  /**
   * Get a registered channel by ID.
   */
  getChannel(channelId: string): IChannel | undefined {
    return this.channels.get(channelId);
  }

  /**
   * Get all registered channels.
   */
  getChannels(): IChannel[] {
    return Array.from(this.channels.values());
  }

  /**
   * Start WebSocket server for Execution Node connections.
   */
  private async startWebSocketServer(): Promise<void> {
    // Initialize file storage service if configured
    if (this.fileStorageConfig) {
      this.fileStorageService = new FileStorageService(this.fileStorageConfig);
      await this.fileStorageService.initialize();
      logger.info('File storage service initialized');
    }

    // Create file API handler
    const fileApiHandler = this.fileStorageService
      ? createFileTransferAPIHandler({ storageService: this.fileStorageService })
      : null;

    // Create HTTP server for health check, file API, and WebSocket upgrade
    this.httpServer = http.createServer(async (req, res) => {
      const url = req.url || '/';

      // Handle file API requests
      if (fileApiHandler && url.startsWith('/api/files')) {
        const handled = await fileApiHandler(req, res);
        if (handled) {return;}
      }

      // Health check
      if (url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          mode: 'communication',
          channels: Array.from(this.channels.keys()),
          fileStorage: this.fileStorageService?.getStats(),
        }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    // Create WebSocket server
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws, req) => {
      const clientIp = req.socket.remoteAddress;
      logger.info({ clientIp }, 'Execution Node connected');

      // Store the connection
      if (this.execWs && this.execWs.readyState === WebSocket.OPEN) {
        logger.warn('Closing previous Execution Node connection');
        this.execWs.close();
      }
      this.execWs = ws;

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString()) as FeedbackMessage;
          void this.handleFeedback(message);
        } catch (error) {
          logger.error({ err: error }, 'Failed to parse feedback');
        }
      });

      ws.on('close', () => {
        logger.info({ clientIp }, 'Execution Node disconnected');
        if (this.execWs === ws) {
          this.execWs = undefined;
        }
        this.emit('exec:disconnected');
      });

      ws.on('error', (error) => {
        logger.error({ err: error }, 'WebSocket error');
      });

      this.emit('exec:connected');
    });

    // Start server
    this.httpServer.listen(this.port, this.host, () => {
      logger.info({ port: this.port, host: this.host }, 'WebSocket server started');
    });
  }

  /**
   * Handle message from a channel.
   */
  private async handleChannelMessage(_channelId: string, message: IncomingMessage): Promise<void> {
    logger.debug({ chatId: message.chatId, messageId: message.messageId, content: message.content?.substring(0, 100) }, 'Processing channel message');

    // Process attachments if present
    let attachments: FileReference[] | undefined;
    if (message.attachments && message.attachments.length > 0 && this.fileStorageService) {
      attachments = [];
      for (const att of message.attachments) {
        try {
          const fileRef = await this.fileStorageService.storeFromLocal(
            att.filePath,
            att.fileName,
            att.mimeType,
            'user',
            message.chatId
          );
          attachments.push(fileRef);
          logger.info({ fileId: fileRef.id, fileName: att.fileName }, 'Attachment stored');
        } catch (error) {
          logger.error({ err: error, fileName: att.fileName }, 'Failed to store attachment');
        }
      }
    }

    // Send prompt to Execution Node
    logger.debug({ chatId: message.chatId, messageId: message.messageId }, 'Calling sendPrompt');
    await this.sendPrompt({
      type: 'prompt',
      chatId: message.chatId,
      prompt: message.content,
      messageId: message.messageId,
      senderOpenId: message.userId,
      threadId: message.threadId,
      attachments,
    });
  }

  /**
   * Handle control command.
   */
  private async handleControlCommand(command: ControlCommand): Promise<ControlResponse> {
    switch (command.type) {
      case 'reset':
        await this.sendCommand({ type: 'command', command: 'reset', chatId: command.chatId });
        return { success: true, message: '✅ **对话已重置**\n\n新的会话已启动，之前的上下文已清除。' };

      case 'restart':
        await this.sendCommand({ type: 'command', command: 'restart', chatId: command.chatId });
        return { success: true, message: '🔄 **正在重启服务...**' };

      case 'status':
        const status = this.running ? 'Running' : 'Stopped';
        const execConnected = this.execWs?.readyState === WebSocket.OPEN ? 'Connected' : 'Disconnected';
        const channelStatus = Array.from(this.channels.entries())
          .map(([_id, ch]) => `${ch.name}: ${ch.status}`)
          .join(', ');
        return {
          success: true,
          message: `📊 **状态**\n\n状态: ${status}\nExecution Node: ${execConnected}\nChannels: ${channelStatus}`,
        };

      default:
        return { success: false, error: `Unknown command: ${command.type}` };
    }
  }

  /**
   * Send prompt to Execution Node via WebSocket.
   */
  private async sendPrompt(message: PromptMessage): Promise<void> {
    logger.debug({ chatId: message.chatId, messageId: message.messageId, wsState: this.execWs?.readyState }, 'sendPrompt called');

    if (!this.execWs || this.execWs.readyState !== WebSocket.OPEN) {
      logger.warn('No Execution Node connected');
      await this.sendMessage(message.chatId, '❌ 没有可用的执行节点');
      throw new Error('No Execution Node connected');
    }

    this.execWs.send(JSON.stringify(message));
    logger.info({ chatId: message.chatId, messageId: message.messageId, threadId: message.threadId }, 'Prompt sent to Execution Node');
  }

  /**
   * Send command to Execution Node via WebSocket.
   */
  private async sendCommand(message: CommandMessage): Promise<void> {
    if (!this.execWs || this.execWs.readyState !== WebSocket.OPEN) {
      logger.warn('No Execution Node connected');
      await this.sendMessage(message.chatId, '❌ 没有可用的执行节点');
      throw new Error('No Execution Node connected');
    }

    this.execWs.send(JSON.stringify(message));
    logger.info({ chatId: message.chatId, command: message.command }, 'Command sent to Execution Node');
  }

  /**
   * Handle feedback from Execution Node.
   */
  private async handleFeedback(message: FeedbackMessage): Promise<void> {
    const { chatId, type, text, card, error, threadId, fileRef } = message;

    try {
      switch (type) {
        case 'text':
          if (text) {
            await this.sendMessage(chatId, text, threadId);
          }
          break;
        case 'card':
          await this.sendCard(chatId, card || {}, undefined, threadId);
          break;
        case 'file':
          if (fileRef && this.fileStorageService) {
            const localPath = this.fileStorageService.getLocalPath(fileRef.id);
            if (localPath) {
              await this.sendFileToUser(chatId, localPath, threadId);
            } else {
              logger.error({ fileId: fileRef.id }, 'File not found in storage');
              await this.sendMessage(chatId, `❌ 文件未找到: ${fileRef.fileName}`, threadId);
            }
          }
          break;
        case 'done':
          logger.info({ chatId }, 'Execution completed');
          // Broadcast done signal to all channels (important for REST sync mode)
          await this.broadcastToChannels({ type: 'done', chatId, threadId });
          break;
        case 'error':
          logger.error({ chatId, error }, 'Execution error');
          await this.sendMessage(chatId, `❌ 执行错误: ${error || 'Unknown error'}`, threadId);
          break;
      }
    } catch (err) {
      logger.error({ err, message }, 'Failed to handle feedback');
    }
  }

  /**
   * Send a text message to all channels (broadcast mode).
   * Each channel will handle the message if it recognizes the chatId.
   */
  async sendMessage(chatId: string, text: string, threadMessageId?: string): Promise<void> {
    await this.broadcastToChannels({
      chatId,
      type: 'text',
      text,
      threadId: threadMessageId,
    });
  }

  /**
   * Send an interactive card to all channels (broadcast mode).
   * Each channel will handle the message if it recognizes the chatId.
   */
  async sendCard(
    chatId: string,
    card: Record<string, unknown>,
    description?: string,
    threadMessageId?: string
  ): Promise<void> {
    await this.broadcastToChannels({
      chatId,
      type: 'card',
      card,
      description,
      threadId: threadMessageId,
    });
  }

  /**
   * Send a file to all channels (broadcast mode).
   * Each channel will handle the message if it recognizes the chatId.
   */
  async sendFileToUser(chatId: string, filePath: string, _threadId?: string): Promise<void> {
    // TODO: Pass threadId when Issue #68 is implemented
    await this.broadcastToChannels({
      chatId,
      type: 'file',
      filePath,
    });
  }

  /**
   * Broadcast a message to all registered channels.
   * Uses Promise.allSettled to ensure one channel's failure doesn't affect others.
   */
  private async broadcastToChannels(message: OutgoingMessage): Promise<void> {
    if (this.channels.size === 0) {
      logger.warn({ chatId: message.chatId }, 'No channels registered');
      return;
    }

    const results = await Promise.allSettled(
      Array.from(this.channels.values()).map(async (channel) => {
        try {
          await channel.sendMessage(message);
        } catch (error) {
          logger.warn(
            { channelId: channel.id, chatId: message.chatId, error },
            'Channel failed to send message'
          );
          throw error;
        }
      })
    );

    // Log any failures
    const channelArray = Array.from(this.channels.values());
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.warn(
          { channelId: channelArray[index].id, chatId: message.chatId },
          'Message delivery failed'
        );
      }
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

    // Start WebSocket server for Execution Node connections
    await this.startWebSocketServer();

    // Start all registered channels
    for (const [channelId, channel] of this.channels) {
      try {
        await channel.start();
        logger.info({ channelId }, 'Channel started');
      } catch (error) {
        logger.error({ err: error, channelId }, 'Failed to start channel');
      }
    }

    logger.info('CommunicationNode started');
    console.log('✓ Communication Node ready');
    console.log();
    console.log(`WebSocket Server: ws://${this.host}:${this.port}`);
    console.log('Channels:');
    for (const [id, channel] of this.channels) {
      console.log(`  - ${channel.name} (${id}): ${channel.status}`);
    }
    console.log('Waiting for Execution Node to connect...');
  }

  /**
   * Stop the Communication Node.
   */
  async stop(): Promise<void> {
    if (!this.running) {return;}

    this.running = false;

    // Shutdown file storage service
    if (this.fileStorageService) {
      this.fileStorageService.shutdown();
      this.fileStorageService = undefined;
    }

    // Stop all channels
    for (const [channelId, channel] of this.channels) {
      try {
        await channel.stop();
        logger.info({ channelId }, 'Channel stopped');
      } catch (error) {
        logger.error({ err: error, channelId }, 'Failed to stop channel');
      }
    }

    // Close WebSocket connection from Execution Node
    if (this.execWs) {
      this.execWs.close();
      this.execWs = undefined;
    }

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = undefined;
    }

    // Close HTTP server
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = undefined;
    }

    logger.info('CommunicationNode stopped');
  }

  /**
   * Check if the node is running.
   */
  isRunning(): boolean {
    return this.running;
  }
}
