/**
 * Primary Node - Main node with both communication and execution capabilities.
 *
 * This module combines the capabilities of CommunicationNode and ExecutionRunner
 * into a single self-contained node that can:
 * - Handle multiple communication channels (Feishu, REST, etc.)
 * - Execute Agent tasks locally
 * - Accept connections from Worker Nodes for horizontal scaling
 *
 * Architecture:
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 *                      Primary Node                             │
 * │                                                             │
 *  ┌─────────────────────┐    ┌─────────────────────────┐    │
 *  │   Comm 能力          │    │   Exec 能力              │    │
 *  │   - Feishu Channel  │    │   - Pilot Agent         │    │
 *  │   - REST Channel    │    │   - Session Manager     │    │
 *  │   - WebSocket Srv   │    │   - Task Execution      │    │
 *  └─────────────────────┘    └─────────────────────────┘    │
 * │                                                             │
 *  特点：自包含，可独立运行                                     │
 * └─────────────────────────────────────────────────────────────┘
 * ```
 */

import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import * as path from 'path';
import { EventEmitter } from 'events';
import { Config } from '../config/index.js';
import { AgentFactory } from '../agents/index.js';
import { createLogger } from '../utils/logger.js';
import type { IChannel, IncomingMessage, OutgoingMessage, ControlCommand, ControlResponse } from '../channels/index.js';
import { FeishuChannel } from '../channels/feishu-channel.js';
import { RestChannel } from '../channels/rest-channel.js';
import type { PromptMessage, CommandMessage, FeedbackMessage, RegisterMessage } from '../types/websocket-messages.js';
import type { FileRef } from '../file-transfer/types.js';
import { FileStorageService, type FileStorageConfig } from '../file-transfer/node-transfer/file-storage.js';
import { createFileTransferAPIHandler } from '../file-transfer/node-transfer/file-api.js';
import {
  ScheduleManager,
  Scheduler,
  ScheduleFileWatcher,
} from '../schedule/index.js';
import { TaskFlowOrchestrator } from '../feishu/task-flow-orchestrator.js';
import { TaskTracker } from '../utils/task-tracker.js';
import type { PrimaryNodeConfig, ExecNodeInfo, NodeCapabilities } from './types.js';

const logger = createLogger('PrimaryNode');

/**
 * Internal representation of a connected execution node.
 */
interface ConnectedExecNode {
  ws?: WebSocket;
  nodeId: string;
  name: string;
  connectedAt: Date;
  clientIp?: string;
  isLocal: boolean;
}

/**
 * Feedback context for execution.
 */
interface FeedbackContext {
  sendFeedback: (feedback: FeedbackMessage) => void;
  threadId?: string;
}

/**
 * Primary Node - Self-contained node with both communication and execution capabilities.
 *
 * Responsibilities:
 * - Manages multiple communication channels (Feishu, REST, etc.)
 * - Runs WebSocket server for Worker Node connections
 * - Executes Agent tasks locally (when enableLocalExec is true)
 * - Routes messages between channels and execution nodes
 * - Supports horizontal scaling with Worker Nodes
 */
export class PrimaryNode extends EventEmitter {
  private port: number;
  private host: string;

  private httpServer?: http.Server;
  private wss?: WebSocketServer;
  private running = false;

  // Execution nodes (including local execution capability)
  private execNodes: Map<string, ConnectedExecNode> = new Map();
  private chatToNode: Map<string, string> = new Map(); // chatId -> nodeId
  private localNodeId: string;

  // Registered channels
  private channels: Map<string, IChannel> = new Map();

  // File storage service
  private fileStorageService?: FileStorageService;
  private fileStorageConfig?: FileStorageConfig;

  // Local execution
  private localExecEnabled: boolean;
  private sharedPilot?: ReturnType<typeof AgentFactory.createChatAgent>;
  private activeFeedbackChannels = new Map<string, FeedbackContext>();
  private scheduler?: Scheduler;
  private scheduleFileWatcher?: ScheduleFileWatcher;
  private taskFlowOrchestrator?: TaskFlowOrchestrator;

  constructor(config: PrimaryNodeConfig) {
    super();
    this.port = config.port || 3001;
    this.host = config.host || '0.0.0.0';
    this.localNodeId = config.nodeId || `primary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.localExecEnabled = config.enableLocalExec !== false;

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
      void feishuChannel.initTaskFlowOrchestrator({
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

    logger.info({
      port: this.port,
      host: this.host,
      nodeId: this.localNodeId,
      localExecEnabled: this.localExecEnabled
    }, 'PrimaryNode created');
  }

  /**
   * Get node capabilities.
   */
  getCapabilities(): NodeCapabilities {
    return {
      communication: true,
      execution: this.localExecEnabled || this.execNodes.size > 0,
    };
  }

  /**
   * Get node ID.
   */
  getNodeId(): string {
    return this.localNodeId;
  }

  /**
   * Register a local execution node (the built-in execution capability).
   */
  private registerLocalExecNode(): void {
    if (!this.localExecEnabled) {
      return;
    }

    this.execNodes.set(this.localNodeId, {
      nodeId: this.localNodeId,
      name: 'Local Execution',
      connectedAt: new Date(),
      isLocal: true,
    });

    logger.info({ nodeId: this.localNodeId }, 'Local execution capability registered');
  }

  /**
   * Register a remote execution node.
   */
  private registerExecNode(ws: WebSocket, msg: RegisterMessage, clientIp?: string): string {
    const { nodeId, name } = msg;

    // Close existing connection with same nodeId if exists
    const existing = this.execNodes.get(nodeId);
    if (existing && existing.ws) {
      logger.warn({ nodeId }, 'Closing existing connection for nodeId');
      existing.ws.close();
      this.execNodes.delete(nodeId);
    }

    // Register the new node
    this.execNodes.set(nodeId, {
      ws,
      nodeId,
      name: name || `Worker-${nodeId.slice(0, 8)}`,
      connectedAt: new Date(),
      clientIp,
      isLocal: false,
    });

    logger.info({ nodeId, name: msg.name, clientIp, totalNodes: this.execNodes.size }, 'Worker Node registered');
    this.emit('worker:connected', nodeId);

    return nodeId;
  }

  /**
   * Unregister a remote execution node.
   */
  private unregisterExecNode(nodeId: string): void {
    const node = this.execNodes.get(nodeId);
    if (!node || node.isLocal) {
      return;
    }

    this.execNodes.delete(nodeId);
    logger.info({ nodeId, totalNodes: this.execNodes.size }, 'Worker Node unregistered');

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

    this.emit('worker:disconnected', nodeId);
  }

  /**
   * Get the first available execution node.
   * Prefers local execution if available (lower latency).
   */
  private getFirstAvailableNode(): ConnectedExecNode | undefined {
    // Prefer local execution
    const localNode = this.execNodes.get(this.localNodeId);
    if (localNode && this.localExecEnabled) {
      return localNode;
    }

    // Fall back to remote nodes
    for (const node of this.execNodes.values()) {
      if (!node.isLocal && node.ws && node.ws.readyState === WebSocket.OPEN) {
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
      if (node) {
        // For local node, just return it
        if (node.isLocal && this.localExecEnabled) {
          return node;
        }
        // For remote node, check connection
        if (node.ws && node.ws.readyState === WebSocket.OPEN) {
          return node;
        }
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
    if (!targetNode) {
      logger.warn({ chatId, targetNodeId }, 'Target node not found');
      return false;
    }

    // For local node, just assign
    if (targetNode.isLocal) {
      this.chatToNode.set(chatId, targetNodeId);
      logger.info({ chatId, newNode: targetNodeId }, 'Switched chat to local execution');
      return true;
    }

    // For remote node, check connection
    if (!targetNode.ws || targetNode.ws.readyState !== WebSocket.OPEN) {
      logger.warn({ chatId, targetNodeId }, 'Target node not available for switch');
      return false;
    }

    const previousNodeId = this.chatToNode.get(chatId);
    this.chatToNode.set(chatId, targetNodeId);
    logger.info({ chatId, previousNode: previousNodeId, newNode: targetNodeId }, 'Switched chat to new execution node');
    return true;
  }

  /**
   * Get list of all execution nodes (local + remote).
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
        status: node.isLocal ? 'connected' :
          (node.ws && node.ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected'),
        activeChats,
        connectedAt: node.connectedAt,
        isLocal: node.isLocal,
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
   * Initialize local execution capability.
   */
  private async initLocalExecution(): Promise<void> {
    if (!this.localExecEnabled) {
      return;
    }

    console.log('Initializing local execution capability...');

    // Create shared Pilot instance
    this.sharedPilot = AgentFactory.createChatAgent('pilot', {
      sendMessage: (chatId: string, text: string, threadMessageId?: string): Promise<void> => {
        const ctx = this.activeFeedbackChannels.get(chatId);
        if (ctx) {
          ctx.sendFeedback({ type: 'text', chatId, text, threadId: threadMessageId || ctx.threadId });
        } else {
          logger.warn({ chatId }, 'No active feedback channel for sendMessage');
        }
        return Promise.resolve();
      },
      sendCard: (chatId: string, card: Record<string, unknown>, description?: string, threadMessageId?: string): Promise<void> => {
        const ctx = this.activeFeedbackChannels.get(chatId);
        if (ctx) {
          ctx.sendFeedback({ type: 'card', chatId, card, text: description, threadId: threadMessageId || ctx.threadId });
        } else {
          logger.warn({ chatId }, 'No active feedback channel for sendCard');
        }
        return Promise.resolve();
      },
      sendFile: async (chatId: string, filePath: string) => {
        const ctx = this.activeFeedbackChannels.get(chatId);
        if (!ctx) {
          logger.warn({ chatId }, 'No active feedback channel for sendFile');
          return;
        }

        try {
          // For local execution, we can directly send the file
          await this.sendFileToUser(chatId, filePath, ctx.threadId);
        } catch (error) {
          logger.error({ err: error, chatId, filePath }, 'Failed to send file');
          ctx.sendFeedback({
            type: 'error',
            chatId,
            error: `Failed to send file: ${(error as Error).message}`,
            threadId: ctx.threadId,
          });
        }
      },
      onDone: (chatId: string, threadMessageId?: string): Promise<void> => {
        const ctx = this.activeFeedbackChannels.get(chatId);
        if (ctx) {
          ctx.sendFeedback({ type: 'done', chatId, threadId: threadMessageId || ctx.threadId });
          logger.info({ chatId }, 'Task completed, sent done signal');
        } else {
          logger.warn({ chatId }, 'No active feedback channel for onDone');
        }
        return Promise.resolve();
      },
    });

    // Initialize Schedule Manager and Scheduler
    const workspaceDir = Config.getWorkspaceDir();
    const schedulesDir = path.join(workspaceDir, 'schedules');
    const scheduleManager = new ScheduleManager({ schedulesDir });
    this.scheduler = new Scheduler({
      scheduleManager,
      pilot: this.sharedPilot,
      callbacks: {
        sendMessage: (chatId: string, text: string, threadMessageId?: string): Promise<void> => {
          const ctx = this.activeFeedbackChannels.get(chatId);
          if (ctx) {
            ctx.sendFeedback({ type: 'text', chatId, text, threadId: threadMessageId || ctx.threadId });
          } else {
            logger.warn({ chatId }, 'No feedback channel for scheduled task, message not sent');
          }
          return Promise.resolve();
        },
        sendCard: (chatId: string, card: Record<string, unknown>, description?: string, threadMessageId?: string): Promise<void> => {
          const ctx = this.activeFeedbackChannels.get(chatId);
          if (ctx) {
            ctx.sendFeedback({ type: 'card', chatId, card, text: description, threadId: threadMessageId || ctx.threadId });
          }
          return Promise.resolve();
        },
        sendFile: async (chatId: string, filePath: string) => {
          const ctx = this.activeFeedbackChannels.get(chatId);
          if (ctx) {
            try {
              await this.sendFileToUser(chatId, filePath, ctx.threadId);
            } catch (error) {
              logger.error({ err: error, chatId, filePath }, 'Failed to send file for scheduled task');
            }
          }
        },
      },
      setFeedbackChannel: (chatId: string, context: { threadId?: string }) => {
        const actualContext = {
          sendFeedback: (feedback: FeedbackMessage) => {
            // For local execution, handle feedback directly
            void this.handleFeedback(feedback);
          },
          threadId: context.threadId,
        };
        this.activeFeedbackChannels.set(chatId, actualContext);
        logger.debug({ chatId }, 'Feedback channel set for scheduled task');
      },
      clearFeedbackChannel: (chatId: string) => {
        this.activeFeedbackChannels.delete(chatId);
        logger.debug({ chatId }, 'Feedback channel cleared for scheduled task');
      },
    });

    // Initialize file watcher for hot reload
    this.scheduleFileWatcher = new ScheduleFileWatcher({
      schedulesDir,
      onFileAdded: (task) => {
        logger.info({ taskId: task.id, name: task.name }, 'Schedule file added, adding to scheduler');
        this.scheduler?.addTask(task);
      },
      onFileChanged: (task) => {
        logger.info({ taskId: task.id, name: task.name }, 'Schedule file changed, updating scheduler');
        this.scheduler?.addTask(task);
      },
      onFileRemoved: (taskId) => {
        logger.info({ taskId }, 'Schedule file removed, removing from scheduler');
        this.scheduler?.removeTask(taskId);
      },
    });

    // Initialize TaskFlowOrchestrator
    const taskTracker = new TaskTracker();
    this.taskFlowOrchestrator = new TaskFlowOrchestrator(
      taskTracker,
      {
        sendMessage: (chatId: string, text: string, threadMessageId?: string): Promise<void> => {
          return this.sendMessage(chatId, text, threadMessageId);
        },
        sendCard: (chatId: string, card: Record<string, unknown>, _description?: string, threadMessageId?: string): Promise<void> => {
          return this.sendCard(chatId, card, undefined, threadMessageId);
        },
        sendFile: (chatId: string, filePath: string): Promise<void> => {
          return this.sendFileToUser(chatId, filePath);
        },
      },
      logger
    );

    // Start scheduler and file watcher
    await this.scheduler.start();
    await this.scheduleFileWatcher.start();
    await this.taskFlowOrchestrator.start();

    console.log('✓ Local execution capability initialized');
    console.log('✓ Scheduler started');
    console.log('✓ Schedule file watcher started');
    console.log('✓ TaskFlowOrchestrator started');
  }

  /**
   * Execute a prompt locally using the shared Pilot.
   */
  private executeLocally(message: PromptMessage): void {
    if (!this.sharedPilot) {
      throw new Error('Local execution not initialized');
    }

    const { chatId, prompt, messageId, senderOpenId, threadId, attachments } = message;
    logger.info({ chatId, messageId, promptLength: prompt.length, threadId, hasAttachments: !!attachments }, 'Executing prompt locally');

    // Create send feedback function
    const sendFeedback = (feedback: FeedbackMessage) => {
      void this.handleFeedback(feedback);
    };

    // Register feedback channel for this chatId with threadId
    this.activeFeedbackChannels.set(chatId, { sendFeedback, threadId });

    try {
      // Use processMessage for persistent session context
      this.sharedPilot.processMessage(chatId, prompt, messageId, senderOpenId, attachments);
    } catch (error) {
      const err = error as Error;
      logger.error({ err, chatId }, 'Local execution failed');
      sendFeedback({ type: 'error', chatId, error: err.message, threadId });
      sendFeedback({ type: 'done', chatId, threadId });
    }
  }

  /**
   * Start WebSocket server for Worker Node connections.
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
          mode: 'primary',
          nodeId: this.localNodeId,
          capabilities: this.getCapabilities(),
          channels: Array.from(this.channels.keys()),
          execNodes: this.getExecNodes().map(n => ({
            nodeId: n.nodeId,
            name: n.name,
            status: n.status,
            isLocal: n.isLocal,
          })),
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

      logger.info({ clientIp }, 'Worker Node connecting...');

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

          // Handle feedback message (from Worker Nodes)
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
        this.emit('worker:disconnected', currentNodeId);
      });

      ws.on('error', (error) => {
        logger.error({ err: error, nodeId: currentNodeId }, 'WebSocket error');
      });

      // Auto-register timeout for backward compatibility
      const registrationTimeout = setTimeout(() => {
        if (!currentNodeId && ws.readyState === WebSocket.OPEN) {
          const autoNodeId = `worker-${Date.now()}`;
          currentNodeId = this.registerExecNode(ws, { type: 'register', nodeId: autoNodeId, name: 'Auto-registered Worker' }, clientIp);
          logger.info({ nodeId: currentNodeId }, 'Auto-registered worker node (backward compatibility)');
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
    let attachments: FileRef[] | undefined;
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

    // Send prompt to execution node
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
          ? execNodesList.map(n => `${n.name} (${n.status}${n.isLocal ? ', local' : ''})`).join(', ')
          : 'None';
        const channelStatus = Array.from(this.channels.entries())
          .map(([_id, ch]) => `${ch.name}: ${ch.status}`)
          .join(', ');
        const currentNodeId = this.getChatNodeAssignment(command.chatId);
        const currentNode = execNodesList.find(n => n.nodeId === currentNodeId);
        return {
          success: true,
          message: `📊 **状态**\n\n状态: ${status}\n节点ID: ${this.localNodeId}\n执行节点: ${execStatus}\n当前节点: ${currentNode?.name || '未分配'}\n通道: ${channelStatus}`,
        };
      }

      case 'list-nodes': {
        const nodes = this.getExecNodes();
        if (nodes.length === 0) {
          return { success: true, message: '📋 **执行节点列表**\n\n暂无执行节点' };
        }
        const currentNodeId = this.getChatNodeAssignment(command.chatId);
        const nodesList = nodes.map(n => {
          const isCurrent = n.nodeId === currentNodeId ? ' ✓ (当前)' : '';
          const localTag = n.isLocal ? ' [本地]' : '';
          return `- ${n.name}${localTag} [${n.status}]${isCurrent} (${n.activeChats} 活跃会话)`;
        }).join('\n');
        return { success: true, message: `📋 **执行节点列表**\n\n${nodesList}` };
      }

      case 'switch-node': {
        const {targetNodeId} = command;
        if (!targetNodeId) {
          const nodes = this.getExecNodes();
          const nodesList = nodes.map(n => `- \`${n.nodeId}\` (${n.name}${n.isLocal ? ', local' : ''})`).join('\n');
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
   * Send prompt to execution node (local or remote).
   */
  private async sendPrompt(message: PromptMessage): Promise<void> {
    logger.debug({ chatId: message.chatId, messageId: message.messageId }, 'sendPrompt called');

    const execNode = this.getExecNodeForChat(message.chatId);
    if (!execNode) {
      logger.warn('No Execution Node available');
      await this.sendMessage(message.chatId, '❌ 没有可用的执行节点');
      throw new Error('No Execution Node available');
    }

    // Execute locally
    if (execNode.isLocal) {
      await this.executeLocally(message);
      logger.info({ chatId: message.chatId, messageId: message.messageId, threadId: message.threadId, nodeId: 'local' }, 'Prompt sent to local execution');
      return;
    }

    // Execute remotely
    if (execNode.ws) {
      execNode.ws.send(JSON.stringify(message));
      logger.info({ chatId: message.chatId, messageId: message.messageId, threadId: message.threadId, nodeId: execNode.nodeId }, 'Prompt sent to Worker Node');
    }
  }

  /**
   * Send command to execution node (local or remote).
   */
  private async sendCommand(message: CommandMessage): Promise<void> {
    const execNode = this.getExecNodeForChat(message.chatId);
    if (!execNode) {
      logger.warn('No Execution Node available');
      await this.sendMessage(message.chatId, '❌ 没有可用的执行节点');
      throw new Error('No Execution Node available');
    }

    // Handle locally
    if (execNode.isLocal && this.sharedPilot) {
      const { command, chatId } = message;
      logger.info({ command, chatId }, 'Executing command locally');

      try {
        if (command === 'reset' || command === 'restart') {
          this.sharedPilot.reset(chatId);
          logger.info({ chatId }, `Pilot ${command} executed for chatId`);
        }
      } catch (error) {
        const err = error as Error;
        logger.error({ err, command, chatId }, 'Command execution failed');
      }
      return;
    }

    // Send to remote node
    if (execNode.ws) {
      execNode.ws.send(JSON.stringify(message));
      logger.info({ chatId: message.chatId, command: message.command, nodeId: execNode.nodeId }, 'Command sent to Worker Node');
    }
  }

  /**
   * Handle feedback from execution node (remote or local).
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
          if (fileRef) {
            const localPath = this.fileStorageService?.getLocalPath(fileRef.id);
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
   */
  async sendFileToUser(chatId: string, filePath: string, _threadId?: string): Promise<void> {
    await this.broadcastToChannels({
      chatId,
      type: 'file',
      filePath,
    });
  }

  /**
   * Broadcast a message to all registered channels.
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
   * Start the Primary Node.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('PrimaryNode already running');
      return;
    }

    this.running = true;

    // Register local execution capability first
    this.registerLocalExecNode();

    // Start WebSocket server for Worker Node connections
    await this.startWebSocketServer();

    // Initialize local execution capability
    await this.initLocalExecution();

    // Start all registered channels
    for (const [channelId, channel] of this.channels) {
      try {
        await channel.start();
        logger.info({ channelId }, 'Channel started');
      } catch (error) {
        logger.error({ err: error, channelId }, 'Failed to start channel');
      }
    }

    logger.info('PrimaryNode started');
    console.log('✓ Primary Node ready');
    console.log();
    console.log(`Node ID: ${this.localNodeId}`);
    console.log(`WebSocket Server: ws://${this.host}:${this.port}`);
    console.log('Channels:');
    for (const [id, channel] of this.channels) {
      console.log(`  - ${channel.name} (${id}): ${channel.status}`);
    }
    console.log('Execution:');
    console.log(`  - Local: ${this.localExecEnabled ? 'Enabled' : 'Disabled'}`);
    console.log('Waiting for Worker Nodes to connect...');
    console.log();
    console.log('Control commands available:');
    console.log('  /list-nodes  - List all execution nodes');
    console.log('  /switch-node <nodeId> - Switch to a specific execution node');
  }

  /**
   * Stop the Primary Node.
   */
  async stop(): Promise<void> {
    if (!this.running) {return;}

    this.running = false;

    // Stop scheduler and file watcher
    this.scheduler?.stop();
    this.scheduleFileWatcher?.stop();
    await this.taskFlowOrchestrator?.stop();

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

    // Close all remote Worker Node connections
    for (const [nodeId, node] of this.execNodes) {
      if (!node.isLocal && node.ws) {
        try {
          node.ws.close();
          logger.info({ nodeId }, 'Worker Node connection closed');
        } catch (error) {
          logger.error({ err: error, nodeId }, 'Failed to close Worker Node connection');
        }
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

    logger.info('PrimaryNode stopped');
  }

  /**
   * Check if the node is running.
   */
  isRunning(): boolean {
    return this.running;
  }
}
