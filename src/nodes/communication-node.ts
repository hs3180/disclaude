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
import type { PromptMessage, CommandMessage, FeedbackMessage, RegisterMessage, ExecNodeInfo } from '../types/websocket-messages.js';
import type { FileReference } from '../types/file-reference.js';
import { FileStorageService, type FileStorageConfig, createFileTransferAPIHandler } from '../file-transfer/node-transfer/index.js';

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
 * Internal representation of a connected execution node.
 */
interface ConnectedExecNode {
  ws: WebSocket;
  nodeId: string;
  name: string;
  connectedAt: Date;
  clientIp?: string;
}

/**
 * Communication Node - Manages multiple channels and WebSocket communication with Execution Node.
 *
 * Responsibilities:
 * - Manages multiple communication channels (Feishu, REST, etc.)
 * - Runs WebSocket server for Execution Nodes to connect
 * - Supports multiple Execution Nodes with chat-level routing
 * - Forwards prompts from channels to assigned Execution Node via WebSocket
 * - Receives feedback from Execution Node via WebSocket
 * - Routes feedback back to appropriate channels
 */
export class CommunicationNode extends EventEmitter {
  private port: number;
  private host: string;

  private httpServer?: http.Server;
  private wss?: WebSocketServer;
  private running = false;

  // Multiple execution nodes support (Issue #38)
  private execNodes: Map<string, ConnectedExecNode> = new Map();
  private chatToNode: Map<string, string> = new Map(); // chatId -> nodeId

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
   * Register an execution node.
   * If a node with the same ID exists, close the old connection.
   */
  private registerExecNode(ws: WebSocket, msg: RegisterMessage, clientIp?: string): string {
    const { nodeId, name } = msg;

    // Close existing connection with same nodeId if exists
    const existing = this.execNodes.get(nodeId);
    if (existing) {
      logger.warn({ nodeId }, 'Closing existing connection for nodeId');
      existing.ws.close();
      this.execNodes.delete(nodeId);
    }

    // Register the new node
    this.execNodes.set(nodeId, {
      ws,
      nodeId,
      name: name || `ExecNode-${nodeId.slice(0, 8)}`,
      connectedAt: new Date(),
      clientIp,
    });

    logger.info({ nodeId, name: msg.name, clientIp, totalNodes: this.execNodes.size }, 'Execution Node registered');
    this.emit('exec:connected', nodeId);

    return nodeId;
  }

  /**
   * Unregister an execution node.
   * Reassign chats that were assigned to this node.
   */
  private unregisterExecNode(nodeId: string): void {
    const node = this.execNodes.get(nodeId);
    if (!node) {
      return;
    }

    this.execNodes.delete(nodeId);
    logger.info({ nodeId, totalNodes: this.execNodes.size }, 'Execution Node unregistered');

    // Reassign chats that were using this node
    const chatsToReassign: string[] = [];
    for (const [chatId, assignedNodeId] of this.chatToNode) {
      if (assignedNodeId === nodeId) {
        chatsToReassign.push(chatId);
      }
    }

    // Try to reassign to another available node
    const availableNode = this.getFirstAvailableNode();
    for (const chatId of chatsToReassign) {
      if (availableNode) {
        this.chatToNode.set(chatId, availableNode.nodeId);
        logger.info({ chatId, oldNode: nodeId, newNode: availableNode.nodeId }, 'Reassigned chat to available node');
      } else {
        this.chatToNode.delete(chatId);
        logger.warn({ chatId, oldNode: nodeId }, 'No available node to reassign chat');
      }
    }

    this.emit('exec:disconnected', nodeId);
  }

  /**
   * Get the first available execution node.
   */
  private getFirstAvailableNode(): ConnectedExecNode | undefined {
    for (const node of this.execNodes.values()) {
      if (node.ws.readyState === WebSocket.OPEN) {
        return node;
      }
    }
    return undefined;
  }

  /**
   * Get the execution node assigned to a chat, or assign the first available one.
   */
  private getExecNodeForChat(chatId: string): ConnectedExecNode | undefined {
    // Check if chat already has an assigned node
    const assignedNodeId = this.chatToNode.get(chatId);
    if (assignedNodeId) {
      const node = this.execNodes.get(assignedNodeId);
      if (node && node.ws.readyState === WebSocket.OPEN) {
        return node;
      }
      // Assigned node is not available, fall through to assign new one
    }

    // Assign first available node
    const availableNode = this.getFirstAvailableNode();
    if (availableNode) {
      this.chatToNode.set(chatId, availableNode.nodeId);
      logger.debug({ chatId, nodeId: availableNode.nodeId }, 'Assigned chat to execution node');
    }
    return availableNode;
  }

  /**
   * Switch a chat to a specific execution node.
   */
  switchChatNode(chatId: string, targetNodeId: string): boolean {
    const targetNode = this.execNodes.get(targetNodeId);
    if (!targetNode || targetNode.ws.readyState !== WebSocket.OPEN) {
      logger.warn({ chatId, targetNodeId }, 'Target node not available for switch');
      return false;
    }

    const previousNodeId = this.chatToNode.get(chatId);
    this.chatToNode.set(chatId, targetNodeId);
    logger.info({ chatId, previousNode: previousNodeId, newNode: targetNodeId }, 'Switched chat to new execution node');
    return true;
  }

  /**
   * Get list of all connected execution nodes.
   */
  getExecNodes(): ExecNodeInfo[] {
    const result: ExecNodeInfo[] = [];
    for (const [nodeId, node] of this.execNodes) {
      // Count active chats for this node
      let activeChats = 0;
      for (const assignedNodeId of this.chatToNode.values()) {
        if (assignedNodeId === nodeId) {
          activeChats++;
        }
      }

      result.push({
        nodeId,
        name: node.name,
        status: node.ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
        activeChats,
        connectedAt: node.connectedAt,
      });
    }
    return result;
  }

  /**
   * Get the node assignment for a specific chat.
   */
  getChatNodeAssignment(chatId: string): string | undefined {
    return this.chatToNode.get(chatId);
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
      let currentNodeId: string | undefined;

      logger.info({ clientIp }, 'Execution Node connecting...');

      // Handle incoming messages
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());

          // Handle registration message
          if (message.type === 'register') {
            const regMsg = message as RegisterMessage;
            currentNodeId = this.registerExecNode(ws, regMsg, clientIp);
            return;
          }

          // Handle feedback message
          const feedbackMsg = message as FeedbackMessage;
          void this.handleFeedback(feedbackMsg);
        } catch (error) {
          logger.error({ err: error }, 'Failed to parse message');
        }
      });

      ws.on('close', () => {
        if (currentNodeId) {
          this.unregisterExecNode(currentNodeId);
        }
        this.emit('exec:disconnected', currentNodeId);
      });

      ws.on('error', (error) => {
        logger.error({ err: error, nodeId: currentNodeId }, 'WebSocket error');
      });

      // Send a prompt to register (backward compatibility for nodes that don't auto-register)
      // Set a timeout to auto-register if no registration received
      const registrationTimeout = setTimeout(() => {
        if (!currentNodeId && ws.readyState === WebSocket.OPEN) {
          // Auto-register with generated ID for backward compatibility
          const autoNodeId = `exec-${Date.now()}`;
          currentNodeId = this.registerExecNode(ws, { type: 'register', nodeId: autoNodeId, name: 'Auto-registered Node' }, clientIp);
          logger.info({ nodeId: currentNodeId }, 'Auto-registered execution node (backward compatibility)');
        }
      }, 1000);

      ws.on('close', () => clearTimeout(registrationTimeout));
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

      case 'status': {
        const status = this.running ? 'Running' : 'Stopped';
        const execNodesList = this.getExecNodes();
        const execStatus = execNodesList.length > 0
          ? execNodesList.map(n => `${n.name} (${n.status})`).join(', ')
          : 'None';
        const channelStatus = Array.from(this.channels.entries())
          .map(([_id, ch]) => `${ch.name}: ${ch.status}`)
          .join(', ');
        const currentNodeId = this.getChatNodeAssignment(command.chatId);
        const currentNode = execNodesList.find(n => n.nodeId === currentNodeId);
        return {
          success: true,
          message: `📊 **状态**\n\n状态: ${status}\n执行节点: ${execStatus}\n当前节点: ${currentNode?.name || '未分配'}\n通道: ${channelStatus}`,
        };
      }

      case 'list-nodes': {
        const nodes = this.getExecNodes();
        if (nodes.length === 0) {
          return { success: true, message: '📋 **执行节点列表**\n\n暂无连接的执行节点' };
        }
        const currentNodeId = this.getChatNodeAssignment(command.chatId);
        const nodesList = nodes.map(n => {
          const isCurrent = n.nodeId === currentNodeId ? ' ✓ (当前)' : '';
          return `- ${n.name} [${n.status}]${isCurrent} (${n.activeChats} 活跃会话)`;
        }).join('\n');
        return { success: true, message: `📋 **执行节点列表**\n\n${nodesList}` };
      }

      case 'switch-node': {
        const targetNodeId = command.targetNodeId;
        if (!targetNodeId) {
          // Show usage hint
          const nodes = this.getExecNodes();
          const nodesList = nodes.map(n => `- \`${n.nodeId}\` (${n.name})`).join('\n');
          return {
            success: false,
            error: `请指定目标节点ID。\n\n可用节点:\n${nodesList}`,
          };
        }

        const success = this.switchChatNode(command.chatId, targetNodeId);
        if (success) {
          const node = this.execNodes.get(targetNodeId);
          return { success: true, message: `✅ **已切换执行节点**\n\n当前节点: ${node?.name || targetNodeId}` };
        } else {
          return { success: false, error: `切换失败，节点 \`${targetNodeId}\` 不可用` };
        }
      }

      default:
        return { success: false, error: `Unknown command: ${command.type}` };
    }
  }

  /**
   * Send prompt to Execution Node via WebSocket.
   */
  private async sendPrompt(message: PromptMessage): Promise<void> {
    logger.debug({ chatId: message.chatId, messageId: message.messageId }, 'sendPrompt called');

    const execNode = this.getExecNodeForChat(message.chatId);
    if (!execNode) {
      logger.warn('No Execution Node available');
      await this.sendMessage(message.chatId, '❌ 没有可用的执行节点');
      throw new Error('No Execution Node available');
    }

    execNode.ws.send(JSON.stringify(message));
    logger.info({ chatId: message.chatId, messageId: message.messageId, threadId: message.threadId, nodeId: execNode.nodeId }, 'Prompt sent to Execution Node');
  }

  /**
   * Send command to Execution Node via WebSocket.
   */
  private async sendCommand(message: CommandMessage): Promise<void> {
    const execNode = this.getExecNodeForChat(message.chatId);
    if (!execNode) {
      logger.warn('No Execution Node available');
      await this.sendMessage(message.chatId, '❌ 没有可用的执行节点');
      throw new Error('No Execution Node available');
    }

    execNode.ws.send(JSON.stringify(message));
    logger.info({ chatId: message.chatId, command: message.command, nodeId: execNode.nodeId }, 'Command sent to Execution Node');
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
    console.log('Waiting for Execution Nodes to connect...');
    console.log();
    console.log('Control commands available:');
    console.log('  /list-nodes  - List all connected execution nodes');
    console.log('  /switch-node <nodeId> - Switch to a specific execution node');
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

    // Close all Execution Node connections
    for (const [nodeId, node] of this.execNodes) {
      try {
        node.ws.close();
        logger.info({ nodeId }, 'Execution Node connection closed');
      } catch (error) {
        logger.error({ err: error, nodeId }, 'Failed to close Execution Node connection');
      }
    }
    this.execNodes.clear();
    this.chatToNode.clear();

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
