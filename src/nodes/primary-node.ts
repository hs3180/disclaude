/**
 * Primary Node - Main node with both communication and execution capabilities.
 *
 * This self-contained node can:
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
import * as path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';
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
import type { PrimaryNodeConfig, NodeCapabilities } from './types.js';
// Group management (Issue #486)
import {
  createDiscussionChat,
  dissolveChat,
  addMembers,
  removeMembers,
  getMembers,
} from '../platforms/feishu/chat-ops.js';
import { GroupService, getGroupService } from '../platforms/feishu/group-service.js';
import { createFeishuClient } from '../platforms/feishu/create-feishu-client.js';
// Debug group (Issue #487)
import { getDebugGroupService } from './debug-group-service.js';
// Command system (Issue #463)
import {
  getCommandRegistry,
  registerDefaultCommands,
} from './commands/index.js';
// Welcome service (Issue #463)
import {
  initWelcomeService,
} from '../platforms/feishu/welcome-service.js';
// Schedule management (Issue #469)
import { ScheduleManager } from '../schedule/schedule-manager.js';
import { ScheduleFileScanner } from '../schedule/schedule-watcher.js';
import type { ScheduleTaskInfo } from './commands/types.js';
// Task management (Issue #468)
import { getTaskStateManager } from '../utils/task-state-manager.js';

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
  // Schedule management (Issue #469)
  private scheduleManager?: ScheduleManager;
  private scheduleFileScanner?: ScheduleFileScanner;

  // Local execution
  private sharedPilot?: ReturnType<typeof AgentFactory.createChatAgent>;
  private activeFeedbackChannels = new Map<string, FeedbackContext>();
  private taskFlowOrchestrator?: TaskFlowOrchestrator;

  // Group management (Issue #486)
  private groupService: GroupService;
  private feishuClient?: lark.Client;
  private feishuAppId?: string;
  private feishuAppSecret?: string;

  constructor(config: PrimaryNodeConfig) {
    super();
    this.port = config.port || 3001;
    this.host = config.host || '0.0.0.0';
    this.localNodeId = config.nodeId || `primary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.localExecEnabled = config.enableLocalExec !== false;
    this.fileStorageConfig = config.fileStorage;

    // Initialize GroupService
    this.groupService = getGroupService();

    // Store Feishu credentials for group management
    this.feishuAppId = config.appId || Config.FEISHU_APP_ID;
    this.feishuAppSecret = config.appSecret || Config.FEISHU_APP_SECRET;

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

    // Issue #463: Initialize CommandRegistry with default commands
    const commandRegistry = getCommandRegistry();
    registerDefaultCommands(commandRegistry, () => commandRegistry.generateHelpText());

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

      // Issue #463: Initialize WelcomeService and set to FeishuChannel
      const welcomeService = initWelcomeService({
        generateWelcomeMessage: () => commandRegistry.generateWelcomeMessage(),
        sendMessage: this.sendMessage.bind(this),
      });
      feishuChannel.setWelcomeService(welcomeService);

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

  /**
   * Get or create Feishu client for group management with timeout configuration.
   */
  private getFeishuClient(): lark.Client {
    if (!this.feishuClient) {
      if (!this.feishuAppId || !this.feishuAppSecret) {
        throw new Error('Feishu credentials not configured');
      }
      this.feishuClient = createFeishuClient(this.feishuAppId, this.feishuAppSecret);
    }
    return this.feishuClient;
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
          // Fallback for scheduled tasks: route directly through handleFeedback
          void this.handleFeedback({ type: 'text', chatId, text, threadId: threadMessageId });
        }
        return Promise.resolve();
      },
      sendCard: (chatId: string, card: Record<string, unknown>, description?: string, threadMessageId?: string): Promise<void> => {
        const ctx = this.activeFeedbackChannels.get(chatId);
        if (ctx) {
          ctx.sendFeedback({ type: 'card', chatId, card, text: description, threadId: threadMessageId || ctx.threadId });
        } else {
          // Fallback for scheduled tasks: route directly through handleFeedback
          void this.handleFeedback({ type: 'card', chatId, card, text: description, threadId: threadMessageId });
        }
        return Promise.resolve();
      },
      sendFile: async (chatId: string, filePath: string) => {
        const ctx = this.activeFeedbackChannels.get(chatId);
        if (ctx) {
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
        } else {
          // Fallback for scheduled tasks: send file without threadId
          try {
            await this.sendFileToUser(chatId, filePath);
          } catch (error) {
            logger.error({ err: error, chatId, filePath }, 'Failed to send file for scheduled task');
          }
        }
      },
      onDone: (chatId: string, threadMessageId?: string): Promise<void> => {
        const ctx = this.activeFeedbackChannels.get(chatId);
        if (ctx) {
          ctx.sendFeedback({ type: 'done', chatId, threadId: threadMessageId || ctx.threadId });
          logger.info({ chatId }, 'Task completed, sent done signal');
        } else {
          // Fallback for scheduled tasks: route directly through handleFeedback
          void this.handleFeedback({ type: 'done', chatId, threadId: threadMessageId });
          logger.info({ chatId }, 'Task completed (scheduled task)');
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

    // Initialize ScheduleManager and FileScanner for command access (Issue #469)
    const workspaceDir = Config.getWorkspaceDir();
    const schedulesDir = path.join(workspaceDir, 'schedules');
    this.scheduleManager = new ScheduleManager({ schedulesDir });
    this.scheduleFileScanner = new ScheduleFileScanner({ schedulesDir });

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

    const { chatId, prompt, messageId, senderOpenId, threadId, attachments, chatHistoryContext } = message;
    logger.info(
      { chatId, messageId, promptLength: prompt.length, threadId, hasAttachments: !!attachments, hasChatHistory: !!chatHistoryContext },
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
      this.sharedPilot.processMessage(chatId, prompt, messageId, senderOpenId, attachments, chatHistoryContext);
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
      chatHistoryContext: message.metadata?.chatHistoryContext as string | undefined,
    });
  }

  /**
   * Handle control command using CommandRegistry (Issue #537).
   */
  private async handleControlCommand(command: ControlCommand): Promise<ControlResponse> {
    const commandRegistry = getCommandRegistry();

    // Build command context with services
    const debugGroupService = getDebugGroupService();
    const taskStateManager = getTaskStateManager();
    const context = {
      chatId: command.chatId,
      userId: command.data?.senderOpenId as string | undefined,
      args: (command.data?.args as string[]) || (command.type === 'switch-node' && command.targetNodeId ? [command.targetNodeId] : []),
      rawText: command.data?.rawText as string || '',
      data: command.data,
      services: {
        isRunning: () => this.running,
        getLocalNodeId: () => this.localNodeId,
        getExecNodes: () => this.execNodeRegistry.getNodes(),
        getChatNodeAssignment: (chatId: string) => this.execNodeRegistry.getChatNodeAssignment(chatId),
        switchChatNode: (chatId: string, targetNodeId: string) => this.execNodeRegistry.switchChatNode(chatId, targetNodeId),
        getNode: (nodeId: string) => this.execNodeRegistry.getNode(nodeId),
        sendCommand: async (cmd: 'reset' | 'restart', chatId: string) => {
          await this.sendCommand({ type: 'command', command: cmd, chatId });
        },
        getFeishuClient: () => this.getFeishuClient(),
        createDiscussionChat,
        addMembers,
        removeMembers,
        getMembers,
        dissolveChat,
        registerGroup: (group: Parameters<typeof this.groupService.registerGroup>[0]) => this.groupService.registerGroup(group),
        unregisterGroup: (chatId: string) => this.groupService.unregisterGroup(chatId),
        listGroups: () => this.groupService.listGroups(),
        setDebugGroup: (chatId: string, name?: string) => debugGroupService.setDebugGroup(chatId, name),
        getDebugGroup: () => debugGroupService.getDebugGroup(),
        clearDebugGroup: () => debugGroupService.clearDebugGroup(),
        getChannelStatus: () => this.feedbackRouter.getChannels().map(ch => `${ch.name}: ${ch.status}`).join(', '),
        // Schedule management (Issue #469)
        listSchedules: () => this.listSchedules(),
        getSchedule: (nameOrId: string) => this.getSchedule(nameOrId),
        enableSchedule: (nameOrId: string) => this.enableSchedule(nameOrId),
        disableSchedule: (nameOrId: string) => this.disableSchedule(nameOrId),
        runSchedule: (nameOrId: string) => this.runSchedule(nameOrId),
        isScheduleRunning: (taskId: string) => this.schedulerService?.getScheduler()?.isTaskRunning(taskId) ?? false,
        // Task management methods (Issue #468)
        startTask: (prompt: string, chatId: string, userId?: string) => taskStateManager.startTask(prompt, chatId, userId),
        getCurrentTask: () => taskStateManager.getCurrentTask(),
        updateTaskProgress: (progress: number, currentStep?: string) => taskStateManager.updateProgress(progress, currentStep),
        pauseTask: () => taskStateManager.pauseTask(),
        resumeTask: () => taskStateManager.resumeTask(),
        cancelTask: () => taskStateManager.cancelTask(),
        completeTask: () => taskStateManager.completeTask(),
        setTaskError: (error: string) => taskStateManager.setTaskError(error),
        listTaskHistory: (limit?: number) => taskStateManager.listTaskHistory(limit),
      },
    };

    // Execute command via registry
    const result = await commandRegistry.execute(command.type, context);


    if (result === null) {
      return { success: false, error: `Unknown command: ${command.type}` };
    }

    return result;
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

  // ============================================================================
  // Schedule Management (Issue #469)
  // ============================================================================

  /**
   * List all scheduled tasks.
   */
  private async listSchedules(): Promise<ScheduleTaskInfo[]> {
    if (!this.scheduleManager) {
      return [];
    }

    const tasks = await this.scheduleManager.listAll();
    const scheduler = this.schedulerService?.getScheduler();
    const activeJobs = scheduler?.getActiveJobs() ?? [];

    return tasks.map(task => {
      const activeJob = activeJobs.find(j => j.taskId === task.id);
      return {
        id: task.id,
        name: task.name,
        cron: task.cron,
        enabled: task.enabled,
        isScheduled: !!activeJob,
        isRunning: scheduler?.isTaskRunning(task.id) ?? false,
        chatId: task.chatId,
        createdAt: task.createdAt,
      };
    });
  }

  /**
   * Get a schedule by name or ID.
   */
  private async getSchedule(nameOrId: string): Promise<ScheduleTaskInfo | undefined> {
    const tasks = await this.listSchedules();

    // Try to find by ID first, then by name
    return tasks.find(t => t.id === nameOrId || t.id === `schedule-${nameOrId}` || t.name === nameOrId);
  }

  /**
   * Enable a schedule.
   */
  private async enableSchedule(nameOrId: string): Promise<boolean> {
    const task = await this.getSchedule(nameOrId);
    if (!task) {
      return false;
    }

    // If already enabled, return false
    if (task.enabled) {
      return false;
    }

    // Update the task file
    const fullTask = await this.scheduleManager?.get(task.id);
    if (!fullTask) {
      return false;
    }

    const updatedTask = { ...fullTask, enabled: true };
    await this.scheduleFileScanner?.writeTask(updatedTask);

    return true;
  }

  /**
   * Disable a schedule.
   */
  private async disableSchedule(nameOrId: string): Promise<boolean> {
    const task = await this.getSchedule(nameOrId);
    if (!task) {
      return false;
    }

    // If already disabled, return false
    if (!task.enabled) {
      return false;
    }

    // Update the task file
    const fullTask = await this.scheduleManager?.get(task.id);
    if (!fullTask) {
      return false;
    }

    const updatedTask = { ...fullTask, enabled: false };
    await this.scheduleFileScanner?.writeTask(updatedTask);

    return true;
  }

  /**
   * Manually trigger a schedule.
   */
  private async runSchedule(nameOrId: string): Promise<boolean> {
    const task = await this.getSchedule(nameOrId);
    if (!task) {
      return false;
    }

    // Get the full task
    const fullTask = await this.scheduleManager?.get(task.id);
    if (!fullTask) {
      return false;
    }

    // Execute the task directly
    try {
      // Send start notification
      await this.sendMessage(fullTask.chatId, `🚀 手动触发定时任务「${fullTask.name}」开始执行...`);

      // Execute task using Pilot
      if (this.sharedPilot) {
        await this.sharedPilot.executeOnce(
          fullTask.chatId,
          fullTask.prompt,
          undefined,
          fullTask.createdBy
        );
      }

      return true;
    } catch (error) {
      logger.error({ err: error, taskId: task.id }, 'Failed to run schedule manually');
      return false;
    }
  }
}
