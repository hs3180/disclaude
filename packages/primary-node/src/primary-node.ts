/**
 * Primary Node - Main node with both communication and execution capabilities.
 *
 * This self-contained node can:
 * - Handle multiple communication channels (Feishu, REST, etc.)
 * - Execute Agent tasks locally
 * - Accept connections from Worker Nodes for horizontal scaling
 *
 * Architecture (Refactored - Issue #435, Issue #695, Issue #1040):
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 * │                      Primary Node                           │
 * │                                                             │
 * │  ┌─────────────────────────────────────────────────────────┐│
 * │  │                    Coordination Layer                     ││
 * │  │   - Lifecycle management (start/stop)                     ││
 * │  │   - Channel registration                                   ││
 * │  │   - Local execution setup                                  ││
 * │  └─────────────────────────────────────────────────────────┘│
 * │                                                             │
 * │  ┌───────────────┐ ┌───────────────┐ ┌───────────────────┐   │
 * │  │ExecNodeRegistry│ │FeedbackRouter│ │WebSocketServerSvc │   │
 * │  └───────────────┘ └───────────────┘ └───────────────────┘   │
 * │                                                             │
 * │  ┌─────────────────────────────────────────────────────────┐│
 * │  │              SchedulerService + LocalExecution           ││
 * │  └─────────────────────────────────────────────────────────┘│
 * └─────────────────────────────────────────────────────────────┘
 * ```
 *
 * Issue #1040: Migrated to @disclaude/primary-node
 */

import * as path from 'path';
import { EventEmitter } from 'events';
import {
  createLogger,
  type IChannel,
  type OutgoingMessage,
  UnixSocketIpcServer,
  createInteractiveMessageHandler,
  generateSocketPath,
  type FeishuHandlersContainer,
  type FeishuApiHandlers,
  type InteractiveMessageHandlers,
  type IpcRequest,
  type IpcResponse,
  type IpcRequestPayloads,
  // Issue #1377: Scheduler integration
  Scheduler,
  ScheduleManager,
  ScheduleFileWatcher,
  CooldownManager,
  Config,
  type ScheduledTask,
  // Issue #1382: Unified schedule executor
  createScheduleExecutor,
  type SchedulerCallbacks,
} from '@disclaude/core';
import { AgentFactory, toPilotCallbacks } from '@disclaude/worker-node';
import { ExecNodeRegistry } from './exec-node-registry.js';
import { CardActionRouter } from './routers/card-action-router.js';
import { DebugGroupService, getDebugGroupService } from './services/debug-group-service.js';

const logger = createLogger('PrimaryNode');

/**
 * Primary Node Configuration.
 * Note: This is the local config type. For the full type, see PrimaryNodeConfig from @disclaude/core.
 */
export interface PrimaryNodeOptions {
  /** Node ID (unique identifier) */
  nodeId?: string;

  /** Host to bind to */
  host?: string;

  /** Port to listen on */
  port?: number;

  /** Enable local execution */
  enableLocalExec?: boolean;

  /** Feishu App ID */
  appId?: string;

  /** Feishu App Secret */
  appSecret?: string;

  /** Admin chat ID for debug messages */
  adminChatId?: string;

  /** Channels to register */
  channels?: IChannel[];

  /** Enable REST channel */
  enableRestChannel?: boolean;

  /** REST channel port */
  restPort?: number;
}

/**
 * Node capabilities.
 */
export interface NodeCapabilities {
  /** Can handle communication */
  communication: boolean;

  /** Can execute tasks */
  execution: boolean;
}

/**
 * Primary Node - Self-contained node with both communication and execution capabilities.
 *
 * Responsibilities:
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
  protected port: number;
  protected host: string;
  protected running = false;

  // Node configuration
  protected localNodeId: string;
  protected localExecEnabled: boolean;

  // Services
  protected execNodeRegistry: ExecNodeRegistry;
  protected cardActionRouter: CardActionRouter;
  protected debugGroupService: DebugGroupService;

  // Registered channels
  protected channels: Map<string, IChannel> = new Map();

  // IPC Server for MCP Server connections (Issue #1042)
  protected ipcServer: UnixSocketIpcServer | null = null;
  protected feishuHandlersContainer: FeishuHandlersContainer = { handlers: undefined };

  // Scheduler (Issue #1377)
  protected scheduler?: Scheduler;
  protected scheduleManager?: ScheduleManager;
  protected scheduleFileWatcher?: ScheduleFileWatcher;
  protected cooldownManager?: CooldownManager;

  constructor(config: PrimaryNodeOptions = {}) {
    super();
    this.port = config.port || 3001;
    this.host = config.host || '0.0.0.0';
    this.localNodeId = config.nodeId || `primary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.localExecEnabled = config.enableLocalExec !== false;

    // Initialize ExecNodeRegistry
    this.execNodeRegistry = new ExecNodeRegistry({
      localNodeId: this.localNodeId,
      localExecEnabled: this.localExecEnabled,
    });

    // Forward registry events
    this.execNodeRegistry.on('node:registered', (nodeId: string) => this.emit('worker:connected', nodeId));
    this.execNodeRegistry.on('node:unregistered', (nodeId: string) => this.emit('worker:disconnected', nodeId));

    // Initialize CardActionRouter
    this.cardActionRouter = new CardActionRouter({
      // eslint-disable-next-line require-await
      sendToRemoteNode: async () => false, // Override in subclass
      isNodeConnected: () => false,
    });

    // Initialize DebugGroupService
    this.debugGroupService = getDebugGroupService();

    logger.info({
      nodeId: this.localNodeId,
      port: this.port,
      host: this.host,
      localExecEnabled: this.localExecEnabled,
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
   * Check if the node is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the ExecNodeRegistry.
   */
  getExecNodeRegistry(): ExecNodeRegistry {
    return this.execNodeRegistry;
  }

  /**
   * Get the CardActionRouter.
   */
  getCardActionRouter(): CardActionRouter {
    return this.cardActionRouter;
  }

  /**
   * Get the DebugGroupService.
   */
  getDebugGroupService(): DebugGroupService {
    return this.debugGroupService;
  }

  /**
   * Register a communication channel.
   */
  registerChannel(channel: IChannel): void {
    if (this.channels.has(channel.id)) {
      logger.warn({ channelId: channel.id }, 'Channel already registered, replacing');
    }

    this.channels.set(channel.id, channel);
    logger.info({ channelId: channel.id }, 'Channel registered');
  }

  /**
   * Unregister a communication channel.
   */
  unregisterChannel(channelId: string): boolean {
    const removed = this.channels.delete(channelId);
    if (removed) {
      logger.info({ channelId }, 'Channel unregistered');
    }
    return removed;
  }

  // ============================================================================
  // IPC Server (Issue #1042)
  // ============================================================================

  /**
   * Start the IPC server for MCP Server connections.
   *
   * The IPC server accepts connections from MCP Server child processes
   * and allows them to call channel API handlers directly (no WebSocket bridging needed
   * since Primary Node has direct access to the channels).
   *
   * Issue #1523: Routes IPC requests to the correct channel based on chatId,
   * instead of hardcoding Feishu handlers for all requests.
   */
  protected async startIpcServer(): Promise<void> {
    if (this.ipcServer) {
      logger.warn('IPC server already running');
      return;
    }

    // Create stub interactive message handlers (Primary Node doesn't need interaction prompts)
    const stubHandlers: InteractiveMessageHandlers = {
      getActionPrompts: () => undefined,
      registerActionPrompts: () => {},
      unregisterActionPrompts: () => false,
      generateInteractionPrompt: () => undefined,
      cleanupExpiredContexts: () => 0,
    };

    // Create channel-aware request handler (Issue #1523)
    const requestHandler = this.createChannelAwareHandler(stubHandlers);

    this.ipcServer = new UnixSocketIpcServer(requestHandler, {
      socketPath: generateSocketPath(),
    });

    await this.ipcServer.start();

    // Set environment variable for child processes (MCP Server)
    const socketPath = this.ipcServer.getSocketPath();
    process.env.DISCLAUDE_WORKER_IPC_SOCKET = socketPath;

    logger.info({ socketPath }, 'IPC server started for MCP Server connections');
  }

  /**
   * Resolve the appropriate channel for a given chatId.
   *
   * Uses channel type and chatId format to determine the target channel:
   * - Feishu chatIds (starting with 'oc_') → Feishu channel
   * - Other chatIds → first non-Feishu channel (e.g., REST)
   *
   * Issue #1523: Channel-aware routing for IPC requests.
   */
  protected resolveChannelForChatId(chatId: string): IChannel | undefined {
    const isFeishuChatId = chatId.startsWith('oc_');

    for (const channel of this.channels.values()) {
      if (channel.status !== 'running') {
        continue;
      }
      if (isFeishuChatId && channel.name === 'Feishu') {
        return channel;
      }
      if (!isFeishuChatId && channel.name !== 'Feishu') {
        return channel;
      }
    }

    // Fallback: if no specific match, try any running channel
    for (const channel of this.channels.values()) {
      if (channel.status === 'running') {
        return channel;
      }
    }

    return undefined;
  }

  /**
   * Create a channel-aware IPC request handler.
   *
   * Routes IPC message operations (feishuSendMessage, feishuSendCard, etc.)
   * to the correct channel based on chatId, instead of always routing to Feishu.
   *
   * Issue #1523: Fix IPC handler routing REST channel requests to FeishuChannel.
   */
  protected createChannelAwareHandler(
    interactiveHandlers: InteractiveMessageHandlers
  ): (request: IpcRequest) => Promise<IpcResponse> {
    // Use the core createInteractiveMessageHandler for interactive message operations
    const baseHandler = createInteractiveMessageHandler(
      interactiveHandlers,
      this.feishuHandlersContainer
    );

    return async (request: IpcRequest): Promise<IpcResponse> => {
      // For non-message operations, delegate to base handler
      if (request.type !== 'feishuSendMessage' &&
          request.type !== 'feishuSendCard' &&
          request.type !== 'feishuUploadFile') {
        return baseHandler(request);
      }

      // Channel-aware routing for message operations
      try {
        switch (request.type) {
          case 'feishuSendMessage': {
            const { chatId, text, threadId } =
              request.payload as IpcRequestPayloads['feishuSendMessage'];
            const channel = this.resolveChannelForChatId(chatId);
            if (!channel) {
              return { id: request.id, success: false, error: `No channel found for chatId: ${chatId}` };
            }
            await channel.sendMessage({
              chatId,
              type: 'text',
              text,
              threadId,
            } as OutgoingMessage);
            return { id: request.id, success: true, payload: { success: true } };
          }

          case 'feishuSendCard': {
            const { chatId, card, threadId, description } =
              request.payload as IpcRequestPayloads['feishuSendCard'];
            const channel = this.resolveChannelForChatId(chatId);
            if (!channel) {
              return { id: request.id, success: false, error: `No channel found for chatId: ${chatId}` };
            }
            await channel.sendMessage({
              chatId,
              type: 'card',
              card,
              threadId,
              description,
            } as OutgoingMessage);
            return { id: request.id, success: true, payload: { success: true } };
          }

          case 'feishuUploadFile': {
            const { chatId, filePath, threadId } =
              request.payload as IpcRequestPayloads['feishuUploadFile'];
            const channel = this.resolveChannelForChatId(chatId);
            if (!channel) {
              return { id: request.id, success: false, error: `No channel found for chatId: ${chatId}` };
            }
            await channel.sendMessage({
              chatId,
              type: 'file',
              filePath,
              threadId,
            } as OutgoingMessage);
            return {
              id: request.id,
              success: true,
              payload: { success: true, fileKey: '', fileType: 'file', fileName: filePath.split('/').pop() || 'file', fileSize: 0 },
            };
          }

          default:
            return baseHandler(request);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ err: error, requestType: request.type }, 'Error handling channel-aware IPC request');
        return { id: request.id, success: false, error: errorMessage };
      }
    };
  }

  /**
   * Stop the IPC server.
   */
  protected async stopIpcServer(): Promise<void> {
    if (!this.ipcServer) {
      return;
    }

    await this.ipcServer.stop();
    this.ipcServer = null;

    // Clear environment variable
    delete process.env.DISCLAUDE_WORKER_IPC_SOCKET;

    logger.info('IPC server stopped');
  }

  /**
   * Register Feishu API handlers for IPC calls.
   *
   * This method should be called after FeishuChannel starts to enable
   * MCP Server tools to send messages via IPC.
   */
  registerFeishuHandlers(handlers: FeishuApiHandlers): void {
    this.feishuHandlersContainer.handlers = handlers;
    logger.info('Feishu API handlers registered for IPC');
  }

  /**
   * Get all registered channels.
   */
  getChannels(): IChannel[] {
    return Array.from(this.channels.values());
  }

  /**
   * Get a channel by ID.
   */
  getChannel(channelId: string): IChannel | undefined {
    return this.channels.get(channelId);
  }

  /**
   * Start the Primary Node.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('PrimaryNode already running');
      return;
    }

    logger.info({ nodeId: this.localNodeId }, 'Starting PrimaryNode');

    // Start IPC server for MCP Server connections (Issue #1042)
    await this.startIpcServer();

    // Initialize Scheduler (Issue #1377)
    await this.initScheduler();

    this.running = true;
    this.emit('started');
    logger.info({ nodeId: this.localNodeId }, 'PrimaryNode started');
  }

  /**
   * Stop the Primary Node.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      logger.warn('PrimaryNode not running');
      return;
    }

    logger.info({ nodeId: this.localNodeId }, 'Stopping PrimaryNode');

    // Stop Scheduler (Issue #1377)
    this.stopScheduler();

    // Stop IPC server (Issue #1042)
    await this.stopIpcServer();

    this.running = false;
    this.emit('stopped');
    logger.info({ nodeId: this.localNodeId }, 'PrimaryNode stopped');
  }

  // ============================================================================
  // Scheduler (Issue #1377)
  // ============================================================================

  /**
   * Initialize the scheduler for scheduled task execution.
   *
   * Issue #1377: Scheduler integration for Primary Node
   * Issue #1382: Use unified createScheduleExecutor for task execution
   */
  protected async initScheduler(): Promise<void> {
    const workspaceDir = Config.getWorkspaceDir();
    const schedulesDir = path.join(workspaceDir, 'schedules');
    const cooldownDir = path.join(schedulesDir, '.cooldown');

    // Initialize CooldownManager
    this.cooldownManager = new CooldownManager({ cooldownDir });

    // Initialize ScheduleManager
    this.scheduleManager = new ScheduleManager({ schedulesDir });

    // Issue #1382: Create callbacks for scheduler
    // Issue #1384: Fixed sendMessage to construct proper OutgoingMessage object
    const schedulerCallbacks: SchedulerCallbacks = {
      sendMessage: async (chatId: string, message: string): Promise<void> => {
        // Find channel and send message
        const channel = this.channels.values().next().value;
        if (channel && 'sendMessage' in channel) {
          // Construct proper OutgoingMessage object (Issue #1384)
          await channel.sendMessage({
            type: 'text',
            chatId,
            text: message,
          });
        } else {
          logger.warn({ chatId }, 'No channel available for scheduler message');
        }
      },
    };

    // Issue #1382: Use unified createScheduleExecutor
    // Issue #1412: Use toPilotCallbacks helper to convert SchedulerCallbacks to PilotCallbacks
    // Issue #1446: ChatAgent naturally satisfies ScheduleAgent (no type assertion needed)
    const executor = createScheduleExecutor({
      agentFactory: (chatId, callbacks) => {
        return AgentFactory.createScheduleAgent(chatId, toPilotCallbacks(callbacks));
      },
      callbacks: schedulerCallbacks,
    });

    // Initialize Scheduler
    this.scheduler = new Scheduler({
      scheduleManager: this.scheduleManager,
      cooldownManager: this.cooldownManager,
      callbacks: schedulerCallbacks,
      executor,
    });

    // Initialize file watcher for hot reload
    this.scheduleFileWatcher = new ScheduleFileWatcher({
      schedulesDir,
      onFileAdded: (task: ScheduledTask) => {
        logger.info({ taskId: task.id, name: task.name }, 'Schedule file added, adding to scheduler');
        this.scheduler?.addTask(task);
      },
      onFileChanged: (task: ScheduledTask) => {
        logger.info({ taskId: task.id, name: task.name }, 'Schedule file changed, updating scheduler');
        this.scheduler?.addTask(task);
      },
      onFileRemoved: (taskId: string) => {
        logger.info({ taskId }, 'Schedule file removed, removing from scheduler');
        this.scheduler?.removeTask(taskId);
      },
    });

    // Start scheduler and file watcher
    await this.scheduler.start();
    await this.scheduleFileWatcher.start();

    console.log('✓ Scheduler started');
    console.log('✓ Schedule file watcher started');
    logger.info('Scheduler initialized');
  }

  /**
   * Stop the scheduler.
   */
  protected stopScheduler(): void {
    this.scheduleFileWatcher?.stop();
    this.scheduler?.stop();
    logger.info('Scheduler stopped');
  }

  /**
   * Get the Scheduler instance.
   */
  getScheduler(): Scheduler | undefined {
    return this.scheduler;
  }

  /**
   * Get the ScheduleManager instance.
   */
  getScheduleManager(): ScheduleManager | undefined {
    return this.scheduleManager;
  }
}
