/**
 * Primary Node - Main node with both communication and execution capabilities.
 *
 * This self-contained node can:
 * - Handle multiple communication channels (Feishu, REST, etc.)
 * - Execute Agent tasks locally
 *
 * Architecture (Refactored - Issue #435, Issue #695, Issue #1040, Issue #2717):
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
 * │  ┌───────────────┐ ┌───────────────┐                        │
 * │  │CardActionRouter│ │FeedbackRouter│                        │
 * │  └───────────────┘ └───────────────┘                        │
 * │                                                             │
 * │  ┌─────────────────────────────────────────────────────────┐│
 * │  │              SchedulerService + LocalExecution           ││
 * │  └─────────────────────────────────────────────────────────┘│
 * └─────────────────────────────────────────────────────────────┘
 * ```
 *
 * Issue #1040: Migrated to @disclaude/primary-node
 * Issue #2717: Removed Worker Node / ExecNodeRegistry / WebSocketServerService
 */

import * as path from 'path';
import { EventEmitter } from 'events';
import {
  createLogger,
  type IChannel,
  UnixSocketIpcServer,
  createInteractiveMessageHandler,
  generateSocketPath,
  type FeishuHandlersContainer,
  type FeishuApiHandlers,
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
  // Issue #1703: Temp chat lifecycle management
  ChatStore,
  // Issue #1953: Event-driven trigger mechanism
  SignalWatcher,
} from '@disclaude/core';
import { AgentFactory, toChatAgentCallbacks } from './agents/factory.js';
import { CardActionRouter } from './routers/card-action-router.js';
import { DebugGroupService, getDebugGroupService } from './services/debug-group-service.js';
import { ChannelManager } from './channel-manager.js';
import { InteractiveContextStore } from './interactive-context.js';

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
 * - CardActionRouter: Card action routing to channels
 * - FeedbackRouter: Feedback routing to channels
 * - SchedulerService: Scheduler and file watcher management
 *
 * Issue #2717: Removed Worker Node architecture (ExecNodeRegistry, ExecNodeManager,
 * WebSocketServerService). Multi-machine deployment should use multiple independent
 * Primary Node instances instead.
 */
export class PrimaryNode extends EventEmitter {
  protected port: number;
  protected host: string;
  protected running = false;

  // Node configuration
  protected localNodeId: string;
  protected localExecEnabled: boolean;

  // Services
  protected cardActionRouter: CardActionRouter;
  protected debugGroupService: DebugGroupService;

  // Channel management (Issue #1594: unified channel lifecycle)
  protected channelManager: ChannelManager;

  // IPC Server for MCP Server connections (Issue #1042)
  protected ipcServer: UnixSocketIpcServer | null = null;
  protected feishuHandlersContainer: FeishuHandlersContainer = { handlers: undefined };

  // Scheduler (Issue #1377)
  protected scheduler?: Scheduler;
  protected scheduleManager?: ScheduleManager;
  protected scheduleFileWatcher?: ScheduleFileWatcher;
  protected cooldownManager?: CooldownManager;
  // Signal watcher (Issue #1953)
  protected signalWatcher?: SignalWatcher;

  // Interactive context store (Issue #1572: Phase 3 of #1568)
  protected interactiveContextStore: InteractiveContextStore;

  // Temp chat data store (Issue #1703)
  protected chatStore: ChatStore;

  constructor(config: PrimaryNodeOptions = {}) {
    super();
    this.port = config.port || 3001;
    this.host = config.host || '0.0.0.0';
    this.localNodeId = config.nodeId || `primary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.localExecEnabled = config.enableLocalExec !== false;

    // Initialize CardActionRouter (Issue #2939: removed remote node stubs)
    this.cardActionRouter = new CardActionRouter();

    // Initialize DebugGroupService
    this.debugGroupService = getDebugGroupService();

    // Initialize ChannelManager (Issue #1594: unified channel lifecycle)
    this.channelManager = new ChannelManager();

    // Initialize InteractiveContextStore (Issue #1572)
    this.interactiveContextStore = new InteractiveContextStore();

    // Initialize ChatStore for temp chat record management (Issue #1703)
    // Note: TempChatLifecycleService was removed per Issue #2067 direction update.
    // ChatStore is retained for use by channel wiring (wired-descriptors.ts).
    const workspaceDir = Config.getWorkspaceDir();
    const tempChatStoreDir = path.join(workspaceDir, 'schedules', '.temp-chats');
    this.chatStore = new ChatStore({ storeDir: tempChatStoreDir });

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
      execution: this.localExecEnabled,
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
   * Get the InteractiveContextStore.
   * Issue #1572: Phase 3 of IPC layer responsibility refactoring.
   */
  getInteractiveContextStore(): InteractiveContextStore {
    return this.interactiveContextStore;
  }

  /**
   * Get the ChatStore for temp chat lifecycle management.
   * Issue #1703: Temp chat lifecycle management.
   */
  getChatStore(): ChatStore {
    return this.chatStore;
  }

  /**
   * Register a communication channel.
   * Delegates to ChannelManager (Issue #1594: unified channel lifecycle).
   */
  registerChannel(channel: IChannel): void {
    this.channelManager.register(channel);
  }

  /**
   * Unregister a communication channel.
   */
  unregisterChannel(channelId: string): boolean {
    return this.channelManager.unregister(channelId);
  }

  /**
   * Get the ChannelManager for advanced channel operations.
   * Issue #1594: unified channel lifecycle.
   */
  getChannelManager(): ChannelManager {
    return this.channelManager;
  }

  // ============================================================================
  // IPC Server (Issue #1042)
  // ============================================================================

  /**
   * Start the IPC server for MCP Server connections.
   *
   * The IPC server accepts connections from MCP Server child processes
   * and allows them to call Feishu API handlers directly (no WebSocket bridging needed
   * since Primary Node has direct access to the channels).
   */
  protected async startIpcServer(): Promise<void> {
    if (this.ipcServer) {
      logger.warn('IPC server already running');
      return;
    }

    // Issue #1572: Use real InteractiveContextStore for prompt registration (Phase 3 of #1568).
    // Issue #1573: Phase 4 — simplified to a single registerActionPrompts callback.
    // State management dispatch cases removed from IPC; only the callback for
    // sendInteractive's internal prompt registration remains.
    const contextStore = this.interactiveContextStore;

    // Create the request handler with Feishu handlers container
    const requestHandler = createInteractiveMessageHandler(
      (messageId: string, chatId: string, actionPrompts: Record<string, string>) => {
        contextStore.register(messageId, chatId, actionPrompts);
      },
      this.feishuHandlersContainer
    );

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
    return this.channelManager.getAll();
  }

  /**
   * Get a channel by ID.
   */
  getChannel(channelId: string): IChannel | undefined {
    return this.channelManager.get(channelId);
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
        // Find channel and send message via ChannelManager (Issue #1594)
        // Issue #1594 Phase 3: Use getFirstChannel() instead of getAll()[0]
        const channel = this.channelManager.getFirstChannel();
        if (channel) {
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
    // Issue #1412: Use toChatAgentCallbacks helper to convert SchedulerCallbacks to ChatAgentCallbacks
    // Issue #1338: Pass model override for per-task model selection
    const executor = createScheduleExecutor({
      agentFactory: (chatId, callbacks, model) => {
        return AgentFactory.createAgent(chatId, toChatAgentCallbacks(callbacks), model ? { model } : {});
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

    // Issue #1953: Initialize signal file watcher for event-driven triggers
    const schedulerRef = this.scheduler;
    this.signalWatcher = new SignalWatcher({
      schedulesDir,
      onTrigger: async (taskId, context) => {
        return await schedulerRef?.triggerTask(taskId, context) ?? { ok: false as const, error: 'Scheduler not initialized' };
      },
    });
    await this.signalWatcher.start();

    console.log('✓ Scheduler started');
    console.log('✓ Schedule file watcher started');
    console.log('✓ Signal file watcher started');
    logger.info('Scheduler initialized');
  }

  /**
   * Stop the scheduler.
   */
  protected stopScheduler(): void {
    this.signalWatcher?.stop();
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
