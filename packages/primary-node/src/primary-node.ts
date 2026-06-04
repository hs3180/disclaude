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
import { promises as fsp } from 'node:fs';
import { EventEmitter } from 'events';
import {
  createLogger,
  type IChannel,
  type OutgoingMessage,
  UnixSocketIpcServer,
  createInteractiveMessageHandler,
  generateSocketPath,
  IPC_SOCKET_PATH_FILE,
  type FeishuHandlersContainer,
  type FeishuApiHandlers,
  type ChannelApiHandlers,
  type ChannelHandlersContainer,
  // Issue #1377: Scheduler integration
  Scheduler,
  ScheduleManager,
  ScheduleFileWatcher,
  CooldownManager,
  Config,
  type ScheduledTask,
  type SchedulerCallbacks,
  // Issue #3582: Input MessageRouter for unified routing
  MessageRouter as InputMessageRouter,
} from '@disclaude/core';
import { CardActionRouter } from './routers/card-action-router.js';
import { DebugGroupService, getDebugGroupService } from './services/debug-group-service.js';
import { ChannelManager } from './channel-manager.js';
import { InteractiveContextStore } from './interactive-context.js';
import { AgentPoolMessageHandler } from './messaging/agent-pool-handler.js';

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
  // Issue #3814: Multi-channel IPC handler routing
  protected channelHandlersMap = new Map<string, { handlers: ChannelApiHandlers; channel: IChannel }>();

  // Scheduler (Issue #1377)
  protected scheduler?: Scheduler;
  protected scheduleManager?: ScheduleManager;
  protected scheduleFileWatcher?: ScheduleFileWatcher;
  protected cooldownManager?: CooldownManager;
  /** Issue #3931: Callback to check if agent is busy for a chatId */
  protected isAgentBusy?: (chatId: string) => boolean;

  // Input MessageRouter for unified routing (Issue #3582 Phase 3)
  protected inputMessageRouter?: InputMessageRouter;

  // Interactive context store (Issue #1572: Phase 3 of #1568)
  protected interactiveContextStore: InteractiveContextStore;

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

    // Create the request handler with channel handlers container.
    // Issue #3814: Use composite container that routes IPC requests to the
    // correct channel's handlers based on chatId ownership.
    const compositeContainer = this.createCompositeHandlersContainer();
    const requestHandler = createInteractiveMessageHandler(
      (messageId: string, chatId: string, actionPrompts: Record<string, string>) => {
        contextStore.register(messageId, chatId, actionPrompts);
      },
      compositeContainer
    );

    this.ipcServer = new UnixSocketIpcServer(requestHandler, {
      socketPath: generateSocketPath(),
    });

    await this.ipcServer.start();

    // Set environment variable for child processes (MCP Server)
    const socketPath = this.ipcServer.getSocketPath();
    process.env.DISCLAUDE_WORKER_IPC_SOCKET = socketPath;

    // Issue #3808: Write socket path to well-known file for external processes.
    // External scripts (e.g., cron jobs) read this file to discover the IPC socket.
    // Includes PID for stale file detection by CLI consumers.
    try {
      const content = `${socketPath}\n${process.pid}`;
      await fsp.writeFile(IPC_SOCKET_PATH_FILE, content, 'utf-8');
      logger.debug({ path: IPC_SOCKET_PATH_FILE }, 'IPC socket path written to discovery file');
    } catch (error) {
      logger.warn({ err: error }, 'Failed to write IPC socket path discovery file');
    }

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

    // Issue #3808: Clean up socket path discovery file
    try {
      await fsp.unlink(IPC_SOCKET_PATH_FILE);
    } catch {
      // Ignore cleanup errors (file may not exist)
    }

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
   * Register channel API handlers for IPC routing.
   * Issue #3814: Generalized handler registration for multi-channel IPC.
   *
   * Handlers are stored with their channel instance for chatId-based routing.
   * The IPC dispatch resolves the correct handlers by checking which channel
   * owns a given chatId via `channel.ownsChatId(chatId)`.
   */
  registerChannelHandlers(channelType: string, handlers: ChannelApiHandlers, channel: IChannel): void {
    this.channelHandlersMap.set(channelType, { handlers, channel });
    logger.info({ channelType }, 'Channel API handlers registered for IPC');
  }

  /**
   * Create a composite ChannelHandlersContainer that routes IPC requests
   * to the correct channel's handlers based on chatId ownership.
   *
   * Issue #3814: Multi-channel IPC routing.
   *
   * Resolution order:
   * 1. Check registered channel handlers (channelHandlersMap) for chatId ownership
   * 2. Fall back to feishuHandlersContainer for backward compatibility
   */
  protected createCompositeHandlersContainer(): ChannelHandlersContainer {
    const container: ChannelHandlersContainer = { handlers: undefined };

    const resolveHandlers = (chatId?: string): ChannelApiHandlers | undefined => {
      // Try multi-channel routing first
      if (chatId) {
        for (const { handlers, channel } of this.channelHandlersMap.values()) {
          if (channel.ownsChatId(chatId)) {
            return handlers;
          }
        }
      }
      // Fall back to Feishu handlers (backward compat)
      return this.feishuHandlersContainer.handlers;
    };

    // Create proxy handlers that delegate to the resolved channel
    container.handlers = {
      sendMessage: (chatId, text, threadId, mentions) => {
        const h = resolveHandlers(chatId);
        if (!h) {throw new Error('No channel handlers available');}
        return h.sendMessage(chatId, text, threadId, mentions);
      },
      sendCard: (chatId, card, threadId, description) => {
        const h = resolveHandlers(chatId);
        if (!h) {throw new Error('No channel handlers available');}
        return h.sendCard(chatId, card, threadId, description);
      },
      uploadFile: (chatId, filePath, threadId) => {
        const h = resolveHandlers(chatId);
        if (!h) {throw new Error('No channel handlers available');}
        return h.uploadFile(chatId, filePath, threadId);
      },
      sendInteractive: (chatId, params) => {
        const h = resolveHandlers(chatId);
        if (!h?.sendInteractive) {
          throw new Error('sendInteractive not supported by this channel');
        }
        return h.sendInteractive(chatId, params);
      },

      // Issue #3814 fix: proxy all optional handlers to prevent regression
      pushToAgent: (chatId, message) => {
        const h = resolveHandlers(chatId);
        if (!h?.pushToAgent) {
          throw new Error('pushToAgent not supported by this channel');
        }
        return h.pushToAgent(chatId, message);
      },

      uploadImage: (filePath) => {
        // uploadImage is channel-agnostic (no chatId routing needed)
        const h = resolveHandlers();
        if (!h?.uploadImage) {
          throw new Error('uploadImage not supported by this channel');
        }
        return h.uploadImage(filePath);
      },

      listTempChats: () => {
        const h = resolveHandlers();
        if (!h?.listTempChats) {
          throw new Error('listTempChats not supported by this channel');
        }
        return h.listTempChats();
      },

      markChatResponded: (chatId, response) => {
        const h = resolveHandlers(chatId);
        if (!h?.markChatResponded) {
          throw new Error('markChatResponded not supported by this channel');
        }
        return h.markChatResponded(chatId, response);
      },
    };

    return container;
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
   *
   * Issue #3361: Scheduler initialization is now non-fatal.
   * If scheduler fails, PrimaryNode still starts (Feishu, REST channels work).
   * Scheduler status is logged and queryable via getSchedulerStatus().
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
    // Issue #3361: Wrap in try-catch to prevent scheduler failure from
    // blocking the entire PrimaryNode startup. Main channels (Feishu, REST)
    // should still work even if the scheduler is down.
    try {
      await this.initScheduler();
    } catch (error) {
      logger.error(
        { err: error, nodeId: this.localNodeId },
        '⚠️ Scheduler initialization failed — scheduled tasks will not run. ' +
        'PrimaryNode continues without scheduler. Check logs above for details.'
      );
    }

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
    await this.stopScheduler();

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
   * Issue #3582: Route tasks through InputMessageRouter to existing agents
   * Issue #3361: Added step-by-step logging for diagnostics.
   *   Each initialization phase logs success/failure explicitly so that
   *   operators can pinpoint which step failed when scheduler appears silent.
   */
  protected async initScheduler(): Promise<void> {
    const workspaceDir = Config.getWorkspaceDir();
    const schedulesDir = path.join(workspaceDir, 'schedules');
    const cooldownDir = path.join(schedulesDir, '.cooldown');

    logger.info({ schedulesDir }, 'Initializing scheduler...');

    // Step 1: Initialize CooldownManager
    logger.info('Scheduler init step 1/6: Initializing CooldownManager');
    this.cooldownManager = new CooldownManager({ cooldownDir });
    logger.info({ cooldownDir }, 'Scheduler init step 1/6: ✓ CooldownManager ready');

    // Step 2: Initialize ScheduleManager
    logger.info('Scheduler init step 2/6: Initializing ScheduleManager');
    this.scheduleManager = new ScheduleManager({ schedulesDir });
    logger.info({ schedulesDir }, 'Scheduler init step 2/6: ✓ ScheduleManager ready');

    // Step 3: Create callbacks
    logger.info('Scheduler init step 3/6: Creating schedule callbacks');
    const schedulerCallbacks: SchedulerCallbacks = {
      sendMessage: async (chatId: string, message: string): Promise<void> => {
        const outgoingMessage: OutgoingMessage = {
          type: 'text',
          chatId,
          text: message,
        };
        await this.channelManager.broadcast(outgoingMessage);
      },
    };
    logger.info('Scheduler init step 3/6: ✓ Schedule callbacks created');

    // Step 4: Initialize Scheduler and schedule tasks
    logger.info('Scheduler init step 4/6: Creating Scheduler and loading tasks');
    this.scheduler = new Scheduler({
      scheduleManager: this.scheduleManager,
      cooldownManager: this.cooldownManager,
      callbacks: schedulerCallbacks,
      // Issue #3582: Route through InputMessageRouter to existing agents
      inputMessageRouter: this.inputMessageRouter,
      // Issue #3931: Skip blocking tasks when agent is busy
      isAgentBusy: this.isAgentBusy,
    });

    // Issue #3860 P1: Start file watcher BEFORE scheduler.start() to close the
    // race window between initial load and watcher startup. File events that
    // arrive during scheduler.start() will now be captured by the watcher.
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
      onFileRemoved: (taskId: string, _filePath: string) => {
        logger.info({ taskId }, 'Schedule file removed, removing from scheduler');
        this.scheduler?.removeTask(taskId);
      },
    });

    await this.scheduleFileWatcher.start();
    logger.info('Scheduler init step 5/6: ✓ File watcher started (before scheduler.load)');

    await this.scheduler.start();
    const activeJobCount = this.scheduler.getActiveJobs().length;

    // Sync watcher's known task IDs and mtimes with the scheduler's loaded tasks
    const activeJobs = this.scheduler.getActiveJobs();
    const taskMtimes = new Map<string, Date>();
    for (const job of activeJobs) {
      // Use current time as baseline mtime since we don't have file stats at this point
      taskMtimes.set(job.taskId, new Date());
    }
    this.scheduleFileWatcher.setKnownTaskIds(
      new Set(activeJobs.map(j => j.taskId)),
      taskMtimes
    );

    logger.info(
      { activeJobCount },
      'Scheduler init step 6/6: ✓ Scheduler started'
    );

    logger.info(
      { schedulesDir, activeJobCount },
      'Scheduler fully initialized'
    );
  }

  /**
   * Stop the scheduler.
   * Issue #3415: Made async to allow graceful shutdown of running tasks.
   */
  protected async stopScheduler(): Promise<void> {
    this.scheduleFileWatcher?.stop();
    await this.scheduler?.stop();
    logger.info('Scheduler stopped');
  }

  /**
   * Get the Scheduler instance.
   */
  getScheduler(): Scheduler | undefined {
    return this.scheduler;
  }

  /**
   * Set the callback to check if an agent is busy processing.
   * Issue #3931: Must be called before initScheduler() to take effect.
   *
   * @param callback - Function that returns true if the agent for the given chatId is busy
   */
  setIsAgentBusy(callback: (chatId: string) => boolean): void {
    this.isAgentBusy = callback;
  }

  /**
   * Get the InputMessageRouter instance.
   * Issue #3582: Unified message routing (Phase 3).
   */
  getInputMessageRouter(): InputMessageRouter | undefined {
    return this.inputMessageRouter;
  }

  /**
   * Initialize the InputMessageRouter with the given agent pool and callbacks.
   * Issue #3582: Creates the unified input routing layer (Phase 3).
   *
   * Should be called after agent pool is set up but before channels are started.
   *
   * @param agentPool - Agent pool for creating/getting persistent agents
   * @param callbacksFactory - Factory for creating ChatAgentCallbacks per chat
   */
  initInputMessageRouter(
    agentPool: { getOrCreateChatAgent: (chatId: string, callbacks: import('./agents/types.js').ChatAgentCallbacks) => import('./agents/chat-agent.js').ChatAgent },
    callbacksFactory: (chatId: string) => import('./agents/types.js').ChatAgentCallbacks,
  ): void {
    const handler = new AgentPoolMessageHandler({
      agentPool,
      callbacksFactory,
    });

    this.inputMessageRouter = new InputMessageRouter({ handler });
    logger.info('InputMessageRouter initialized');
  }

  /**
   * Get the ScheduleManager instance.
   */
  getScheduleManager(): ScheduleManager | undefined {
    return this.scheduleManager;
  }

  /**
   * Get scheduler status for health monitoring.
   * Issue #3361: Exposes scheduler health so operators can detect
   * silent failures without digging through log files.
   *
   * @returns Structured scheduler status object
   */
  getSchedulerStatus(): {
    initialized: boolean;
    running: boolean;
    activeJobCount: number;
    activeJobs: Array<{ taskId: string; cron: string; name: string }>;
    fileWatcherRunning: boolean;
  } {
    const activeJobs = this.scheduler?.getActiveJobs() ?? [];
    return {
      initialized: this.scheduler !== undefined,
      running: this.scheduler?.isRunning() ?? false,
      activeJobCount: activeJobs.length,
      activeJobs: activeJobs.map(j => ({
        taskId: j.taskId,
        cron: j.task.cron,
        name: j.task.name,
      })),
      fileWatcherRunning: this.scheduleFileWatcher?.isRunning() ?? false,
    };
  }
}
