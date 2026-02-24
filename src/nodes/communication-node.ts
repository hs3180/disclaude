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
 * ```
 */

import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import { EventEmitter } from 'events';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import type { IChannel, IncomingMessage, ControlCommand, ControlResponse } from '../channels/index.js';
import { FeishuChannel } from '../channels/feishu-channel.js';
import { RestChannel } from '../channels/rest-channel.js';

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
  /** Parent message ID for thread replies */
  parentId?: string;
}

interface CommandMessage {
  type: 'command';
  command: 'reset' | 'restart';
  chatId: string;
}

interface FeedbackMessage {
  type: 'text' | 'card' | 'file' | 'done' | 'error';
  chatId: string;
  text?: string;
  card?: Record<string, unknown>;
  filePath?: string;
  error?: string;
  /** Parent message ID for thread replies */
  parentId?: string;
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

  // Channel routing: chatId -> channelId
  private chatToChannel: Map<string, string> = new Map();

  constructor(config: CommunicationNodeConfig) {
    super();
    this.port = config.port;
    this.host = config.host || '0.0.0.0';

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
      await this.handleChannelMessage(channel.id, message);
    });

    // Set up control handler
    channel.onControl(async (command: ControlCommand) => {
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
  private startWebSocketServer(): void {
    // Create HTTP server for health check and WebSocket upgrade
    this.httpServer = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          mode: 'communication',
          channels: Array.from(this.channels.keys()),
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
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
          this.handleFeedback(message);
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
  private async handleChannelMessage(channelId: string, message: IncomingMessage): Promise<void> {
    // Route chat to channel
    this.chatToChannel.set(message.chatId, channelId);

    // Send prompt to Execution Node
    await this.sendPrompt({
      type: 'prompt',
      chatId: message.chatId,
      prompt: message.content,
      messageId: message.messageId,
      senderOpenId: message.userId,
      parentId: message.parentId,
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
    if (!this.execWs || this.execWs.readyState !== WebSocket.OPEN) {
      logger.warn('No Execution Node connected');
      await this.sendMessage(message.chatId, '❌ 没有可用的执行节点');
      throw new Error('No Execution Node connected');
    }

    this.execWs.send(JSON.stringify(message));
    logger.info({ chatId: message.chatId, messageId: message.messageId, parentId: message.parentId }, 'Prompt sent to Execution Node');
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
    const { chatId, type, text, card, filePath, error, parentId } = message;

    try {
      switch (type) {
        case 'text':
          if (text) {
            await this.sendMessage(chatId, text, parentId);
          }
          break;
        case 'card':
          await this.sendCard(chatId, card || {}, undefined, parentId);
          break;
        case 'file':
          if (filePath) {
            await this.sendFileToUser(chatId, filePath, parentId);
          }
          break;
        case 'done':
          logger.info({ chatId }, 'Execution completed');
          break;
        case 'error':
          logger.error({ chatId, error }, 'Execution error');
          await this.sendMessage(chatId, `❌ 执行错误: ${error || 'Unknown error'}`, parentId);
          break;
      }
    } catch (err) {
      logger.error({ err, message }, 'Failed to handle feedback');
    }
  }

  /**
   * Send a text message to the appropriate channel.
   */
  async sendMessage(chatId: string, text: string, parentMessageId?: string): Promise<void> {
    const channelId = this.chatToChannel.get(chatId);
    if (!channelId) {
      logger.warn({ chatId }, 'No channel found for chat');
      return;
    }

    const channel = this.channels.get(channelId);
    if (!channel) {
      logger.warn({ chatId, channelId }, 'Channel not found');
      return;
    }

    await channel.sendMessage({
      chatId,
      type: 'text',
      text,
      parentId: parentMessageId,
    });
  }

  /**
   * Send an interactive card to the appropriate channel.
   */
  async sendCard(
    chatId: string,
    card: Record<string, unknown>,
    description?: string,
    parentMessageId?: string
  ): Promise<void> {
    const channelId = this.chatToChannel.get(chatId);
    if (!channelId) {
      logger.warn({ chatId }, 'No channel found for chat');
      return;
    }

    const channel = this.channels.get(channelId);
    if (!channel) {
      logger.warn({ chatId, channelId }, 'Channel not found');
      return;
    }

    await channel.sendMessage({
      chatId,
      type: 'card',
      card,
      description,
      parentId: parentMessageId,
    });
  }

  /**
   * Send a file to the appropriate channel.
   */
  async sendFileToUser(chatId: string, filePath: string, _parentId?: string): Promise<void> {
    const channelId = this.chatToChannel.get(chatId);
    if (!channelId) {
      logger.warn({ chatId }, 'No channel found for chat');
      return;
    }

    const channel = this.channels.get(channelId);
    if (!channel) {
      logger.warn({ chatId, channelId }, 'Channel not found');
      return;
    }

    // TODO: Pass parentId when Issue #68 is implemented
    await channel.sendMessage({
      chatId,
      type: 'file',
      filePath,
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
    this.startWebSocketServer();

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
    if (!this.running) return;

    this.running = false;

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
