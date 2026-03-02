/**
 * Primary Node - Main node with both communication and execution capabilities.
 *
 * This module combines the capabilities of CommunicationNode and ExecutionRunner
 * into a single self-contained node that can:
 * - Handle multiple communication channels (Feishu, REST, etc.)
 * - Execute Agent tasks locally
 * - Accept connections from Worker Nodes for horizontal scaling
 *
 * Architecture (Refactored - Issue #435):
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 *                      Primary Node                             │
 * │                                                             │
 *  ┌─────────────────────────────────────────────────────────┐  │
 *  │                    Coordination Layer                     │  │
 *  │   - Lifecycle management (start/stop)                     │  │
 *  │   - Channel registration                                   │  │
 *  │   - Local execution setup                                  │  │
 *  └─────────────────────────────────────────────────────────┘  │
 * │                                                             │
 *  ┌───────────────┐ ┌───────────────┐ ┌───────────────────┐   │
 *  │ExecNodeRegistry│ │FeedbackRouter│ │WebSocketServerSvc │   │
 *  └───────────────┘ └───────────────┘ └───────────────────┘   │
 * │                                                             │
 *  ┌─────────────────────────────────────────────────────────┐  │
 *  │              SchedulerService + LocalExecution           │  │
 *  └─────────────────────────────────────────────────────────┘  │
 * └─────────────────────────────────────────────────────────────┘
 * ```
 */

import { EventEmitter } from 'events';
import { Config } from '../config/index.js';
import { AgentFactory } from '../agents/index.js';
import { createLogger } from '../utils/logger.js';
import type { IChannel, IncomingMessage, ControlCommand, ControlResponse } from '../channels/index.js';
import { FeishuChannel } from '../channels/feishu-channel.js';
import { RestChannel } from '../channels/rest-channel.js';
import type { PromptMessage, CommandMessage, FeedbackMessage } from '../types/websocket-messages.js';
import type { FileRef } from '../file-transfer/types.js';
import type { FileStorageConfig } from '../file-transfer/node-transfer/file-storage.js';
import { TaskFlowOrchestrator } from '../feishu/task-flow-orchestrator.js';
import { TaskTracker } from '../utils/task-tracker.js';
import { ExecNodeRegistry } from './exec-node-registry.js';
import { SchedulerService } from './scheduler-service.js';
import { FeedbackRouter } from './feedback-router.js';
import { WebSocketServerService } from './websocket-server-service.js';
import { TaskManagerService } from './task-manager-service.js';
import type { PrimaryNodeConfig, NodeCapabilities } from './types.js';

const logger = createLogger('PrimaryNode');

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
 * Responsibilities (after refactoring):
 * - Lifecycle management (start/stop)
 * - Channel registration and setup
 * - Local execution initialization
 * - Coordination between services
 *
 * Delegated concerns:
 * - ExecNodeRegistry: Execution node management
 * - FeedbackRouter: Feedback routing to channels
 * - WebSocketServerService: WebSocket/HTTP server management
 * - SchedulerService: Scheduler and file watcher management
 */
export class PrimaryNode extends EventEmitter {
  private port: number;
  private host: string;
  private running = false;

  // Node configuration
  private localNodeId: string;
  private localExecEnabled: boolean;
  private fileStorageConfig?: FileStorageConfig;

  // Services (refactored)
  private execNodeRegistry: ExecNodeRegistry;
  private feedbackRouter: FeedbackRouter;
  private wsServerService?: WebSocketServerService;
  private schedulerService?: SchedulerService;
  private taskManager: TaskManagerService;

  // Local execution
  private sharedPilot?: ReturnType<typeof AgentFactory.createChatAgent>;
  private activeFeedbackChannels = new Map<string, FeedbackContext>();
  private taskFlowOrchestrator?: TaskFlowOrchestrator;

  constructor(config: PrimaryNodeConfig) {
    super();
    this.port = config.port || 3001;
    this.host = config.host || '0.0.0.0';
    this.localNodeId = config.nodeId || `primary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.localExecEnabled = config.enableLocalExec !== false;
    this.fileStorageConfig = config.fileStorage;

    // Initialize ExecNodeRegistry
    this.execNodeRegistry = new ExecNodeRegistry({
      localNodeId: this.localNodeId,
      localExecEnabled: this.localExecEnabled,
    });

    // Forward registry events
    this.execNodeRegistry.on('node:registered', (nodeId) => this.emit('worker:connected', nodeId));
    this.execNodeRegistry.on('node:unregistered', (nodeId) => this.emit('worker:disconnected', nodeId));

    // Initialize FeedbackRouter
    this.feedbackRouter = new FeedbackRouter({
      sendFileToUser: this.sendFileToUser.bind(this),
    });

    // Initialize TaskManagerService
    this.taskManager = new TaskManagerService();

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
      execution: this.localExecEnabled || this.execNodeRegistry.hasAvailableNode(),
    };
  }

  /**
   * Get node ID.
   */
  getNodeId(): string {
    return this.localNodeId;
  }

  // ============================================================================
  // Channel Management
  // ============================================================================

  /**
   * Register a communication channel.
   */
  registerChannel(channel: IChannel): void {
    if (this.feedbackRouter.getChannels().some(c => c.id === channel.id)) {
      logger.warn({ channelId: channel.id }, 'Channel already registered, replacing');
    }

    // Register with FeedbackRouter
    this.feedbackRouter.registerChannel(channel);

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
    return this.feedbackRouter.getChannels().find(c => c.id === channelId);
  }

  /**
   * Get all registered channels.
   */
  getChannels(): IChannel[] {
    return this.feedbackRouter.getChannels();
  }

  // ============================================================================
  // Execution Node Management (delegated to ExecNodeRegistry)
  // ============================================================================

  /**
   * Switch a chat to a specific execution node.
   */
  switchChatNode(chatId: string, targetNodeId: string): boolean {
    return this.execNodeRegistry.switchChatNode(chatId, targetNodeId);
  }

  /**
   * Get list of all execution nodes (local + remote).
   */
  getExecNodes() {
    return this.execNodeRegistry.getNodes();
  }

  /**
   * Get the node assignment for a specific chat.
   */
  getChatNodeAssignment(chatId: string): string | undefined {
    return this.execNodeRegistry.getChatNodeAssignment(chatId);
  }

  // ============================================================================
  // Local Execution
  // ============================================================================

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

    // Initialize SchedulerService
    this.schedulerService = new SchedulerService({
      pilot: this.sharedPilot,
      callbacks: {
        sendMessage: async (chatId, text, threadId) => {
          await this.sendMessage(chatId, text, threadId);
        },
        sendCard: async (chatId, card, description, threadId) => {
          await this.sendCard(chatId, card, description, threadId);
        },
        sendFile: async (chatId, filePath) => {
          await this.sendFileToUser(chatId, filePath);
        },
        handleFeedback: (feedback) => {
          void this.handleFeedback(feedback);
        },
      },
    });

    await this.schedulerService.start();

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
    logger.info(
      { chatId, messageId, promptLength: prompt.length, threadId, hasAttachments: !!attachments },
      'Executing prompt locally'
    );

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

  // ============================================================================
  // Message Handling
  // ============================================================================

  /**
   * Handle message from a channel.
   */
  private async handleChannelMessage(_channelId: string, message: IncomingMessage): Promise<void> {
    logger.info(
      { chatId: message.chatId, messageId: message.messageId },
      'Processing channel message'
    );

    // Process attachments if present
    let attachments: FileRef[] | undefined;
    const fileStorageService = this.wsServerService?.getFileStorageService();
    if (message.attachments && message.attachments.length > 0 && fileStorageService) {
      attachments = [];
      for (const att of message.attachments) {
        try {
          const fileRef = await fileStorageService.storeFromLocal(
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
        const execNodesList = this.execNodeRegistry.getNodes();
        const execStatus = execNodesList.length > 0
          ? execNodesList.map(n => `${n.name} (${n.status}${n.isLocal ? ', local' : ''})`).join(', ')
          : 'None';
        const channelStatus = this.feedbackRouter.getChannels()
          .map(ch => `${ch.name}: ${ch.status}`)
          .join(', ');
        const currentNodeId = this.execNodeRegistry.getChatNodeAssignment(command.chatId);
        const currentNode = execNodesList.find(n => n.nodeId === currentNodeId);
        return {
          success: true,
          message: `📊 **状态**\n\n状态: ${status}\n节点ID: ${this.localNodeId}\n执行节点: ${execStatus}\n当前节点: ${currentNode?.name || '未分配'}\n通道: ${channelStatus}`,
        };
      }

      case 'list-nodes': {
        const nodes = this.execNodeRegistry.getNodes();
        if (nodes.length === 0) {
          return { success: true, message: '📋 **执行节点列表**\n\n暂无执行节点' };
        }
        const currentNodeId = this.execNodeRegistry.getChatNodeAssignment(command.chatId);
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
          const nodes = this.execNodeRegistry.getNodes();
          const nodesList = nodes.map(n => `- \`${n.nodeId}\` (${n.name}${n.isLocal ? ', local' : ''})`).join('\n');
          return {
            success: false,
            error: `请指定目标节点ID。\n\n可用节点:\n${nodesList}`,
          };
        }

        const success = this.execNodeRegistry.switchChatNode(command.chatId, targetNodeId);
        if (success) {
          const node = this.execNodeRegistry.getNode(targetNodeId);
          return { success: true, message: `✅ **已切换执行节点**\n\n当前节点: ${node?.name || targetNodeId}` };
        } else {
          return { success: false, error: `切换失败，节点 \`${targetNodeId}\` 不可用` };
        }
      }

      case 'task': {
        const args = command.data?.args as string[] | undefined;
        const subCommand = args?.[0]?.toLowerCase();

        // /task <prompt> - Start a new task
        if (subCommand && !['status', 'list', 'cancel', 'pause', 'resume'].includes(subCommand)) {
          const prompt = (args as string[]).join(' ');
          const task = await this.taskManager.startTask(prompt, command.chatId);

          // Send the prompt to the agent for execution
          await this.sendPrompt({
            type: 'prompt',
            chatId: command.chatId,
            prompt,
            messageId: `task-${task.id}`,
          });

          return {
            success: true,
            message: `✅ **任务已启动**\n\n任务 ID: \`${task.id}\`\n提示: ${prompt}`,
          };
        }

        // /task status - View current task status
        if (subCommand === 'status') {
          const task = await this.taskManager.getStatus();
          if (!task) {
            return { success: true, message: '📊 **当前任务状态**\n\n暂无进行中的任务' };
          }

          const statusEmoji = {
            running: '🔄',
            paused: '⏸️',
            completed: '✅',
            cancelled: '❌',
          }[task.status];

          const progress = task.progress > 0 ? `\n进度: ${task.progress}%` : '';
          const error = task.error ? `\n错误: ${task.error}` : '';
          const result = task.result ? `\n结果: ${task.result}` : '';

          return {
            success: true,
            message: `📊 **当前任务状态**\n\n任务: ${task.prompt}\n状态: ${statusEmoji} ${task.status}\nID: \`${task.id}\`${progress}${error}${result}`,
          };
        }

        // /task list - List task history
        if (subCommand === 'list') {
          const history = await this.taskManager.listHistory(10);
          if (history.length === 0) {
            return { success: true, message: '📋 **任务历史**\n\n暂无任务历史' };
          }

          const historyList = history.map(t => {
            const statusEmoji = {
              running: '🔄',
              paused: '⏸️',
              completed: '✅',
              cancelled: '❌',
            }[t.status];
            const date = new Date(t.createdAt).toLocaleString('zh-CN');
            return `- ${statusEmoji} ${t.prompt.slice(0, 50)}${t.prompt.length > 50 ? '...' : ''} (${date})`;
          }).join('\n');

          return { success: true, message: `📋 **任务历史**\n\n${historyList}` };
        }

        // /task cancel - Cancel current task
        if (subCommand === 'cancel') {
          const task = await this.taskManager.cancelTask();
          if (!task) {
            return { success: false, error: '没有进行中的任务可取消' };
          }
          return { success: true, message: `✅ **任务已取消**\n\n任务: ${task.prompt}` };
        }

        // /task pause - Pause current task
        if (subCommand === 'pause') {
          const task = await this.taskManager.pauseTask();
          if (!task) {
            return { success: false, error: '没有运行中的任务可暂停' };
          }
          return { success: true, message: `⏸️ **任务已暂停**\n\n任务: ${task.prompt}\n使用 \`/task resume\` 恢复任务` };
        }

        // /task resume - Resume paused task
        if (subCommand === 'resume') {
          const task = await this.taskManager.resumeTask();
          if (!task) {
            return { success: false, error: '没有已暂停的任务可恢复' };
          }

          // Resume the task by sending the prompt again
          await this.sendPrompt({
            type: 'prompt',
            chatId: task.chatId,
            prompt: `继续执行任务: ${task.prompt}`,
            messageId: `task-resume-${task.id}`,
          });

          return { success: true, message: `▶️ **任务已恢复**\n\n任务: ${task.prompt}` };
        }

        // /task without arguments - Show help
        return {
          success: true,
          message: '📋 **任务控制指令**\n\n可用命令:\n- `/task <提示>` - 启动新任务\n- `/task status` - 查看当前任务状态\n- `/task list` - 列出任务历史\n- `/task cancel` - 取消当前任务\n- `/task pause` - 暂停当前任务\n- `/task resume` - 恢复暂停的任务',
        };
      }

      default:
        return { success: false, error: `Unknown command: ${command.type}` };
    }
  }

  /**
   * Send prompt to execution node (local or remote).
   */
  private async sendPrompt(message: PromptMessage): Promise<void> {
    const execNode = this.execNodeRegistry.getNodeForChat(message.chatId);
    if (!execNode) {
      logger.warn('No Execution Node available');
      await this.sendMessage(message.chatId, '❌ 没有可用的执行节点');
      throw new Error('No Execution Node available');
    }

    // Execute locally
    if (execNode.isLocal) {
      await this.executeLocally(message);
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
    const execNode = this.execNodeRegistry.getNodeForChat(message.chatId);
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
    await this.feedbackRouter.handleFeedback(message);
  }

  // ============================================================================
  // Public Message API
  // ============================================================================

  /**
   * Send a text message to all channels (broadcast mode).
   */
  async sendMessage(chatId: string, text: string, threadMessageId?: string): Promise<void> {
    await this.feedbackRouter.sendMessage(chatId, text, threadMessageId);
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
    await this.feedbackRouter.sendCard(chatId, card, description, threadMessageId);
  }

  /**
   * Send a file to all channels (broadcast mode).
   */
  async sendFileToUser(chatId: string, filePath: string, _threadId?: string): Promise<void> {
    // For now, broadcast file path as a message
    // TODO: Implement proper file handling through channels
    await this.feedbackRouter.sendMessage(chatId, `📎 文件: ${filePath}`, _threadId);
  }

  // ============================================================================
  // Lifecycle Management
  // ============================================================================

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
    this.execNodeRegistry.registerLocalNode();

    // Initialize WebSocket server service
    this.wsServerService = new WebSocketServerService({
      port: this.port,
      host: this.host,
      localNodeId: this.localNodeId,
      fileStorageConfig: this.fileStorageConfig,
      execNodeRegistry: this.execNodeRegistry,
      handleFeedback: (feedback) => {
        void this.handleFeedback(feedback);
      },
      getCapabilities: () => this.getCapabilities(),
      getChannelIds: () => this.feedbackRouter.getChannels().map(c => c.id),
    });

    // Start WebSocket server
    await this.wsServerService.start();

    // Initialize local execution capability
    await this.initLocalExecution();

    // Start all registered channels
    for (const channel of this.feedbackRouter.getChannels()) {
      try {
        await channel.start();
        logger.info({ channelId: channel.id }, 'Channel started');
      } catch (error) {
        logger.error({ err: error, channelId: channel.id }, 'Failed to start channel');
      }
    }

    logger.info('PrimaryNode started');
    console.log('✓ Primary Node ready');
    console.log();
    console.log(`Node ID: ${this.localNodeId}`);
    console.log(`WebSocket Server: ws://${this.host}:${this.port}`);
    console.log('Channels:');
    for (const channel of this.feedbackRouter.getChannels()) {
      console.log(`  - ${channel.name} (${channel.id}): ${channel.status}`);
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

    // Stop scheduler service
    this.schedulerService?.stop();
    await this.taskFlowOrchestrator?.stop();

    // Stop WebSocket server
    await this.wsServerService?.stop();

    // Stop all channels
    for (const channel of this.feedbackRouter.getChannels()) {
      try {
        await channel.stop();
        logger.info({ channelId: channel.id }, 'Channel stopped');
      } catch (error) {
        logger.error({ err: error, channelId: channel.id }, 'Failed to stop channel');
      }
    }

    // Clear execution nodes
    this.execNodeRegistry.clear();
    this.feedbackRouter.clear();

    logger.info('PrimaryNode stopped');
  }

  /**
   * Check if the node is running.
   */
  isRunning(): boolean {
    return this.running;
  }
}
