/**
 * Primary Node - Main node with both communication and execution capabilities.
 *
 * This self-contained node can:
 * - Handle multiple communication channels (Feishu, REST, etc.)
 * - Execute Agent tasks locally
 * - Accept connections from Worker Nodes for horizontal scaling
 *
 * Architecture (Refactored - Issue #435, Issue #695):
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
import WebSocket from 'ws';
import { Config } from '../config/index.js';
import { AgentFactory, AgentPool } from '../agents/index.js';
import { createLogger } from '../utils/logger.js';
import type { IChannel, IncomingMessage, ControlCommand, ControlResponse } from '../channels/index.js';
import { FeishuChannel } from '../channels/feishu-channel.js';
import { RestChannel } from '../channels/rest-channel.js';
import type { PromptMessage, CommandMessage, FeedbackMessage, CardActionMessage, FeishuApiRequestMessage, FeishuApiResponseMessage } from '../types/websocket-messages.js';
import type { FileRef } from '../file-transfer/types.js';
import type { FileStorageConfig } from '../file-transfer/node-transfer/file-storage.js';
import { TaskFlowOrchestrator } from '../feishu/task-flow-orchestrator.js';
import { TaskTracker } from '../utils/task-tracker.js';
import { ExecNodeRegistry } from './exec-node-registry.js';
import { SchedulerService } from './scheduler-service.js';
import { UnifiedMessageRouter } from './unified-message-router.js';
import { WebSocketServerService } from './websocket-server-service.js';
import type { PrimaryNodeConfig, NodeCapabilities } from './types.js';
// Group management (Issue #486)
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
// Task management (Issue #468)
import { getTaskStateManager } from '../utils/task-state-manager.js';
// Extracted modules (Issue #695)
import { ScheduleManagement } from './schedule-management.js';
// Issue #893: Removed triggerNextStepRecommendation - now using in-prompt guidance
import { buildCommandServices } from './command-services.js';
// Issue #935: Card action routing to Worker Nodes
import { CardActionRouter } from './card-action-router.js';
// Issue #1085: Generate interaction prompt on Primary Node before routing
import { generateInteractionPrompt } from '../mcp/tools/interactive-message.js';
import { getIpcClient } from '../ipc/unix-socket-client.js';
// Issue #455: Skill Agent System
import { SkillAgentManager, initSkillAgentManager } from '../agents/skill-agent-manager.js';
// Issue #1032: Unified Lark Client Service
import { initLarkClientService, getLarkClientService, isLarkClientServiceInitialized } from '../services/index.js';

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
 * - ScheduleManagement: Schedule operations (Issue #695)
 * - NextStepRecommendation: Post-task recommendations (Issue #695)
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
  private messageRouter: UnifiedMessageRouter;
  private wsServerService?: WebSocketServerService;
  private schedulerService?: SchedulerService;
  // Issue #935: Card action routing to Worker Nodes
  private cardActionRouter: CardActionRouter;
  // Schedule management (Issue #469, #695)
  private scheduleManager?: ScheduleManager;
  private scheduleFileScanner?: ScheduleFileScanner;
  private scheduleManagement?: ScheduleManagement;
  // Skill Agent management (Issue #455)
  private skillAgentManager?: SkillAgentManager;

  // Local execution
  private agentPool?: AgentPool;
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

    // Issue #1032: Initialize unified LarkClientService
    if (this.feishuAppId && this.feishuAppSecret) {
      initLarkClientService({
        appId: this.feishuAppId,
        appSecret: this.feishuAppSecret,
      });
      logger.info('LarkClientService initialized in PrimaryNode');
    }

    // Initialize ExecNodeRegistry
    this.execNodeRegistry = new ExecNodeRegistry({
      localNodeId: this.localNodeId,
      localExecEnabled: this.localExecEnabled,
    });

    // Forward registry events
    this.execNodeRegistry.on('node:registered', (nodeId) => this.emit('worker:connected', nodeId));
    this.execNodeRegistry.on('node:unregistered', (nodeId) => this.emit('worker:disconnected', nodeId));

    // Issue #659: Initialize UnifiedMessageRouter (replaces FeedbackRouter)
    this.messageRouter = new UnifiedMessageRouter({
      sendFileToUser: this.sendFileToUser.bind(this),
      onTaskDone: undefined, // Issue #893: Removed next-step recommendation - now using in-prompt guidance
      // Admin chat can be configured via environment or config
      adminChatId: process.env.ADMIN_CHAT_ID || config.adminChatId
    });

    // Issue #935: Initialize CardActionRouter for Worker Node card routing
    this.cardActionRouter = new CardActionRouter({
      sendToRemoteNode: (nodeId: string, message: CardActionMessage) => {
        return this.sendCardActionToRemoteNode(nodeId, message);
      },
      isNodeConnected: (nodeId: string) => {
        return this.execNodeRegistry.isNodeConnected(nodeId);
      },
    });

    // Issue #463: Initialize CommandRegistry with default commands
    const commandRegistry = getCommandRegistry();
    registerDefaultCommands(commandRegistry, () => commandRegistry.generateHelpText());

    // Issue #455: Initialize SkillAgentManager
    this.skillAgentManager = initSkillAgentManager({
      sendMessage: this.sendMessage.bind(this),
      sendCard: this.sendCard.bind(this),
    });

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
        // Issue #935: Route card actions to Worker Nodes
        routeCardAction: (message) => {
          return this.routeCardAction({
            type: 'card_action',
            chatId: message.chatId,
            cardMessageId: message.cardMessageId,
            actionType: message.actionType,
            actionValue: message.actionValue,
            actionText: message.actionText,
            userId: message.userId,
            action: message.action,
          });
        },
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
      // Issue #1028: Use full REST channel config from config file if available
      const restConfig = config.restChannelConfig || {};
      const restChannel = new RestChannel({
        id: 'rest',
        port: config.restPort || restConfig.port || 3000,
        host: restConfig.host,
        apiPrefix: restConfig.apiPrefix,
        authToken: config.restAuthToken || restConfig.authToken,
        enableCors: restConfig.enableCors,
        fileStorageDir: restConfig.fileStorageDir,
        maxFileSize: restConfig.maxFileSize,
      });
      this.registerChannel(restChannel);
      logger.info({ port: config.restPort || restConfig.port || 3000 }, 'REST channel registered');
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
   * Issue #1032: Now uses unified LarkClientService when available.
   */
  private getFeishuClient(): lark.Client {
    // Prefer LarkClientService if initialized
    if (isLarkClientServiceInitialized()) {
      return getLarkClientService().getClient();
    }

    // Fallback to creating client directly (for backward compatibility)
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
    if (this.messageRouter.getChannels().some(c => c.id === channel.id)) {
      logger.warn({ channelId: channel.id }, 'Channel already registered, replacing');
    }

    // Register with FeedbackRouter
    this.messageRouter.registerChannel(channel);

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
    return this.messageRouter.getChannels().find(c => c.id === channelId);
  }

  /**
   * Get all registered channels.
   */
  getChannels(): IChannel[] {
    return this.messageRouter.getChannels();
  }

  /**
   * Get capabilities for a specific chatId.
   * Routes to the appropriate channel based on chatId prefix (Issue #582).
   *
   * ChatId patterns:
   * - 'oc_' or 'ou_' prefix: Feishu channel (full capabilities)
   * - 'cli-' prefix: CLI channel (limited capabilities)
   * - Others: REST channel or default
   *
   * @param chatId - Chat ID to get capabilities for
   * @returns Channel capabilities or undefined if no matching channel
   */
  getChannelCapabilities(chatId: string) {
    // Find the appropriate channel based on chatId
    const channels = this.messageRouter.getChannels();

    // Try to find a channel that matches the chatId pattern
    for (const channel of channels) {
      // Feishu channel handles oc_ and ou_ prefixed chatIds
      if (channel.id === 'feishu' && (chatId.startsWith('oc_') || chatId.startsWith('ou_'))) {
        return channel.getCapabilities();
      }
      // REST channel handles other chatIds (or as fallback)
      if (channel.id === 'rest' && !chatId.startsWith('oc_') && !chatId.startsWith('ou_') && !chatId.startsWith('cli-')) {
        return channel.getCapabilities();
      }
    }

    // Default: return capabilities from the first available channel
    // This handles CLI mode and other edge cases
    if (channels.length > 0) {
      return channels[0].getCapabilities();
    }

    // No channels available - return undefined
    return undefined;
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
   *
   * Issue #644: Uses AgentPool instead of sharedPilot.
   * Each chatId gets its own Pilot instance for complete isolation.
   */
  private async initLocalExecution(): Promise<void> {
    if (!this.localExecEnabled) {
      return;
    }

    console.log('Initializing local execution capability...');

    // Issue #644: Create AgentPool with factory function
    // Each chatId gets its own ChatAgent instance for complete isolation
    this.agentPool = new AgentPool({
      chatAgentFactory: (chatId: string) => {
        return AgentFactory.createChatAgent('pilot', chatId, {
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
          // Capability-aware prompt generation (Issue #582)
          getCapabilities: (chatId: string) => {
            return this.getChannelCapabilities(chatId);
          },
        });
      },
    });

    // Initialize SchedulerService
    // Issue #711: SchedulerService no longer needs AgentPool
    // Scheduler uses AgentFactory.createScheduleAgent directly
    this.schedulerService = new SchedulerService({
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

    // Initialize ScheduleManagement module (Issue #695)
    this.scheduleManagement = new ScheduleManagement({
      scheduleManager: this.scheduleManager,
      scheduleFileScanner: this.scheduleFileScanner,
      schedulerService: this.schedulerService,
      agentPool: this.agentPool ? {
        getOrCreateChatAgent: (chatId: string) => this.agentPool!.getOrCreateChatAgent(chatId),
      } : undefined,
      sendMessage: (chatId, text, threadId) => this.sendMessage(chatId, text, threadId),
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

    await this.taskFlowOrchestrator.start();

    console.log('✓ Local execution capability initialized');
    console.log('✓ Scheduler started');
    console.log('✓ Schedule file watcher started');
    console.log('✓ TaskFlowOrchestrator started');
  }

  /**
   * Execute a prompt locally using the AgentPool.
   *
   * Issue #644: Uses AgentPool to get Pilot for this chatId.
   */
  private executeLocally(message: PromptMessage): void {
    if (!this.agentPool) {
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
      // Issue #644: Get ChatAgent for this chatId from AgentPool
      const agent = this.agentPool.getOrCreateChatAgent(chatId);
      agent.processMessage(chatId, prompt, messageId, senderOpenId, attachments, chatHistoryContext);
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
   * Uses buildCommandServices factory (Issue #695).
   */
  private async handleControlCommand(command: ControlCommand): Promise<ControlResponse> {
    const commandRegistry = getCommandRegistry();

    // Build command context with services using factory (Issue #695)
    const debugGroupService = getDebugGroupService();
    const taskStateManager = getTaskStateManager();

    const services = buildCommandServices({
      isRunning: () => this.running,
      getLocalNodeId: () => this.localNodeId,
      execNodeRegistry: this.execNodeRegistry,
      sendCommand: async (cmd: 'reset' | 'restart', chatId: string) => {
        await this.sendCommand({ type: 'command', command: cmd, chatId });
      },
      getFeishuClient: () => this.getFeishuClient(),
      groupService: this.groupService,
      debugGroupService,
      scheduleManagement: this.scheduleManagement!,
      taskStateManager,
      getChannelStatus: () => this.messageRouter.getChannels().map(ch => `${ch.name}: ${ch.status}`).join(', '),
      getChannels: () => this.messageRouter.getChannels(),
      skillAgentManager: this.skillAgentManager!,
    });

    const context = {
      chatId: command.chatId,
      userId: command.data?.senderOpenId as string | undefined,
      args: (command.data?.args as string[]) || (command.type === 'switch-node' && command.targetNodeId ? [command.targetNodeId] : []),
      rawText: command.data?.rawText as string || '',
      data: command.data,
      services,
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
    if (execNode.isLocal && this.agentPool) {
      const { command, chatId } = message;
      logger.info({ command, chatId }, 'Executing command locally');

      try {
        if (command === 'reset' || command === 'restart') {
          // Issue #644: Reset the Pilot for this chatId via AgentPool
          this.agentPool.reset(chatId);
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
    await this.messageRouter.handleFeedback(message);
  }

  // ============================================================================
  // Card Action Routing (Issue #935)
  // ============================================================================

  /**
   * Route a card action to the appropriate handler.
   * If the card was sent by a Worker Node, forward the action to that node.
   *
   * Issue #1085: Primary Node generates prompt content before routing to Worker Node.
   * This ensures all interaction processing happens on Primary Node,
   * and Worker Node only receives the pre-processed prompt content.
   *
   * @param message - Card action message to route
   * @returns True if the action was routed to a Worker Node, false otherwise
   */
  async routeCardAction(message: CardActionMessage): Promise<boolean> {
    // Issue #1085: Generate prompt content on Primary Node before routing
    // Try IPC first (cross-process), then fall back to local function (same-process)
    let promptContent: string | undefined;

    try {
      const ipcClient = getIpcClient();
      if (ipcClient.isConnected()) {
        // Cross-process: query via IPC
        promptContent = await ipcClient.generateInteractionPrompt(
          message.cardMessageId,
          message.actionValue,
          message.actionText,
          message.actionType
        ) ?? undefined;
        if (promptContent) {
          logger.debug({ cardMessageId: message.cardMessageId }, 'Got prompt template via IPC');
        }
      }

      // Fallback to local function (same-process)
      if (!promptContent) {
        promptContent = generateInteractionPrompt(
          message.cardMessageId,
          message.actionValue,
          message.actionText,
          message.actionType
        );
        if (promptContent) {
          logger.debug({ cardMessageId: message.cardMessageId }, 'Got prompt template from local function');
        }
      }
    } catch (error) {
      logger.warn({ err: error, cardMessageId: message.cardMessageId }, 'Failed to generate interaction prompt');
    }

    // Add prompt content to message for Worker Node
    if (promptContent) {
      message.promptContent = promptContent;
    }

    return this.cardActionRouter.routeCardAction(message);
  }

  /**
   * Send a card action message to a remote Worker Node.
   * Used by CardActionRouter to forward card actions.
   *
   * @param nodeId - Target Worker Node ID
   * @param message - Card action message to send
   * @returns True if the message was sent successfully
   */
  private sendCardActionToRemoteNode(nodeId: string, message: CardActionMessage): Promise<boolean> {
    const node = this.execNodeRegistry.getNode(nodeId);
    if (!node || node.isLocal || !node.ws) {
      logger.warn({ nodeId }, 'Remote node not found or not connected');
      return Promise.resolve(false);
    }

    if (node.ws.readyState !== WebSocket.OPEN) {
      logger.warn({ nodeId }, 'Remote node WebSocket not open');
      return Promise.resolve(false);
    }

    try {
      node.ws.send(JSON.stringify(message));
      logger.debug({ nodeId, chatId: message.chatId }, 'Card action sent to remote Worker Node');
      return Promise.resolve(true);
    } catch (error) {
      logger.error({ err: error, nodeId }, 'Failed to send card action to remote Worker Node');
      return Promise.resolve(false);
    }
  }

  // ============================================================================
  // Feishu API Request Routing (Issue #1036)
  // ============================================================================

  /**
   * Handle Feishu API requests from Worker Nodes.
   * Routes requests through LarkClientService.
   *
   * @param request - Feishu API request message
   * @param sendResponse - Callback to send response back to Worker Node
   */
  private async handleFeishuApiRequest(
    request: FeishuApiRequestMessage,
    sendResponse: (response: FeishuApiResponseMessage) => void
  ): Promise<void> {
    const { requestId, action, params } = request;
    logger.debug({ requestId, action, params }, 'Handling Feishu API request from Worker Node');

    try {
      // Check if LarkClientService is available
      if (!isLarkClientServiceInitialized()) {
        sendResponse({
          type: 'feishu-api-response',
          requestId,
          success: false,
          error: 'LarkClientService not initialized on Primary Node',
        });
        return;
      }

      const service = getLarkClientService();
      let result: unknown;

      switch (action) {
        case 'sendMessage': {
          const { chatId, text, threadId } = params;
          if (!chatId || !text) {
            throw new Error('Missing required params: chatId or text');
          }
          await service.sendMessage(chatId, text, threadId ? { threadId } : undefined);
          result = { success: true };
          break;
        }

        case 'sendCard': {
          const { chatId, card, threadId, description } = params;
          if (!chatId || !card) {
            throw new Error('Missing required params: chatId or card');
          }
          await service.sendCard(
            chatId,
            card,
            description ? { description, threadId } : threadId ? { threadId } : undefined
          );
          result = { success: true };
          break;
        }

        case 'uploadFile': {
          const { chatId, filePath, threadId } = params;
          if (!chatId || !filePath) {
            throw new Error('Missing required params: chatId or filePath');
          }
          result = await service.uploadFile(chatId, filePath, threadId ? { threadId } : undefined);
          break;
        }

        case 'getBotInfo': {
          result = await service.getBotInfo();
          break;
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      logger.debug({ requestId, action }, 'Feishu API request completed successfully');
      sendResponse({
        type: 'feishu-api-response',
        requestId,
        success: true,
        data: result,
      });
    } catch (error) {
      const err = error as Error;
      logger.error({ err, requestId, action }, 'Feishu API request failed');
      sendResponse({
        type: 'feishu-api-response',
        requestId,
        success: false,
        error: err.message,
      });
    }
  }

  // ============================================================================
  // Public Message API
  // ============================================================================

  /**
   * Send a text message to all channels (broadcast mode).
   */
  async sendMessage(chatId: string, text: string, threadMessageId?: string): Promise<void> {
    await this.messageRouter.sendMessage(chatId, text, threadMessageId);
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
    await this.messageRouter.sendCard(chatId, card, description, threadMessageId);
  }

  /**
   * Send a file to all channels (broadcast mode).
   */
  async sendFileToUser(chatId: string, filePath: string, _threadId?: string): Promise<void> {
    // For now, broadcast file path as a message
    // TODO: Implement proper file handling through channels
    await this.messageRouter.sendMessage(chatId, `📎 文件: ${filePath}`, _threadId);
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
      getChannelIds: () => this.messageRouter.getChannels().map(c => c.id),
      // Issue #935: Register card context for Worker Node routing
      registerCardContext: (chatId: string, nodeId: string, isRemote: boolean) => {
        this.cardActionRouter.registerChatContext(chatId, nodeId, isRemote);
      },
      // Issue #1036: Handle Feishu API requests from Worker Nodes
      handleFeishuApiRequest: async (request, sendResponse) => {
        await this.handleFeishuApiRequest(request, sendResponse);
      },
    });

    // Start WebSocket server
    await this.wsServerService.start();

    // Initialize local execution capability
    await this.initLocalExecution();

    // Start all registered channels
    for (const channel of this.messageRouter.getChannels()) {
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
    for (const channel of this.messageRouter.getChannels()) {
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
    for (const channel of this.messageRouter.getChannels()) {
      try {
        await channel.stop();
        logger.info({ channelId: channel.id }, 'Channel stopped');
      } catch (error) {
        logger.error({ err: error, channelId: channel.id }, 'Failed to stop channel');
      }
    }

    // Clear execution nodes
    this.execNodeRegistry.clear();
    this.messageRouter.clear();

    logger.info('PrimaryNode stopped');
  }

  /**
   * Check if the node is running.
   */
  isRunning(): boolean {
    return this.running;
  }
}
