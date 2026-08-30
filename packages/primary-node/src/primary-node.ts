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
  type OutgoingMessage,
  // Issue #4280 (part 5): the IPC server import is gone — PrimaryNode serves
  // REST-only via its HttpApiServer (cli.ts --api-port). Only the handler-
  // container types remain: resolveApiHandlers still routes REST-facing calls
  // to the owning channel's handlers.
  type FeishuHandlersContainer,
  type FeishuApiHandlers,
  type ChannelApiHandlers,
  // Issue #1377: Scheduler integration
  Scheduler,
  ScheduleManager,
  ScheduleFileWatcher,
  CooldownManager,
  Config,
  // Issue #4388: select Agent SDK backend from config at boot.
  setDefaultProvider,
  // Issue #4629: fail-fast availability probe of the selected backend.
  getProvider,
  type ScheduledTask,
  type SchedulerCallbacks,
  // Issue #3582: Input MessageRouter for unified routing
  MessageRouter as InputMessageRouter,
  // Issue #4279: FeishuCard type for REST sendCard parity.
  type FeishuCard,
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

  // Issue #4280 (part 5): the UnixSocketIpcServer field is gone — PrimaryNode
  // no longer starts an IPC server; MCP tools / push-cli reach it over the
  // REST API (--api-port). The handler containers below stay: REST-facing
  // methods (uploadFile/sendCard/… via resolveApiHandlers) route through them.
  protected feishuHandlersContainer: FeishuHandlersContainer = { handlers: undefined };
  // Issue #3814: Multi-channel handler routing (chatId ownership)
  protected channelHandlersMap = new Map<string, { handlers: ChannelApiHandlers; channel: IChannel }>();

  // Scheduler (Issue #1377)
  protected scheduler?: Scheduler;
  protected scheduleManager?: ScheduleManager;
  protected scheduleFileWatcher?: ScheduleFileWatcher;
  protected cooldownManager?: CooldownManager;

  // Input MessageRouter for unified routing (Issue #3582 Phase 3)
  protected inputMessageRouter?: InputMessageRouter;

  // Issue #4206: stashed in initInputMessageRouter() so the scheduler's
  // clearContext callback can reset a chat's agent before a scheduled task.
  // Issue #4587 (part 2): getOrCreateChatAgent takes an optional threadRootId
  // (topic-group thread session keying).
  protected agentPool?: {
    getOrCreateChatAgent: (chatId: string, callbacks: import('./agents/types.js').ChatAgentCallbacks, threadRootId?: string) => import('./agents/chat-agent.js').ChatAgent;
    reset: (chatId: string, skipContext?: boolean) => void;
  };
  // Issue #4199: optional busy-state provider used to gate blocking scheduled
  // tasks whose target chat is mid-conversation. Set by initInputMessageRouter.
  protected schedulerChatBusyProvider?: (chatId: string) => boolean;

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
  // Channel handler registration (Issue #1042 → #4280 part 5)
  // ============================================================================

  /**
   * Register Feishu API handlers.
   *
   * This method should be called after FeishuChannel starts so the
   * REST-facing methods (sendMessage/sendCard/uploadFile/…) can reach it.
   */
  registerFeishuHandlers(handlers: FeishuApiHandlers): void {
    this.feishuHandlersContainer.handlers = handlers;
    logger.info('Feishu API handlers registered');
  }

  /**
   * Register channel API handlers.
   * Issue #3814: Generalized handler registration for multi-channel routing.
   *
   * Handlers are stored with their channel instance for chatId-based routing.
   * resolveApiHandlers resolves the correct handlers by checking which channel
   * owns a given chatId via `channel.ownsChatId(chatId)`.
   */
  registerChannelHandlers(channelType: string, handlers: ChannelApiHandlers, channel: IChannel): void {
    this.channelHandlersMap.set(channelType, { handlers, channel });
    logger.info({ channelType }, 'Channel API handlers registered');
  }

  // Issue #4280 (part 5): createCompositeHandlersContainer() is removed with
  // the IPC server — it existed to adapt the registered handlers into the
  // UnixSocketIpcServer's ChannelHandlersContainer shape. The REST-facing
  // public methods (uploadFile/sendMessage/sendCard/sendInteractive/
  // listTempChats/markChatResponded/…) call resolveApiHandlers directly.

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

    // Issue #4388: select the Agent SDK backend from config (default 'claude').
    // Must run before any ChatAgent is created (getProvider() reads the default).
    // agentBackend is orthogonal to the model-layer `provider` (LLM API).
    const agentBackend = Config.AGENT_BACKEND;
    if (agentBackend && agentBackend !== 'claude') {
      try {
        setDefaultProvider(agentBackend);
        logger.info({ agentBackend }, 'Agent SDK backend selected from config');

        // Issue #4629: probe the backend's environment NOW (e.g. codex CLI
        // missing on PATH / OAuth not completed) so misconfiguration surfaces
        // as an actionable error at startup, not at the first message. Boot
        // continues — the surrounding philosophy is degrade, don't crash.
        const backendInfo = getProvider(agentBackend).getInfo();
        if (!backendInfo.available) {
          logger.error(
            { agentBackend, unavailableReason: backendInfo.unavailableReason },
            `Agent backend "${agentBackend}" is not available — fix the issue above, ` +
              'or agent queries will fail when they arrive.',
          );
        }
      } catch (error) {
        // Don't crash boot — fall back to the default 'claude' backend.
        logger.error(
          { err: error, agentBackend },
          'Unknown agent.agentBackend in config — falling back to "claude". ' +
            'Use one of the registered backends (see the error above).',
        );
      }
    }

    // Issue #4280 (part 5): no IPC server is started anymore — PrimaryNode
    // serves REST-only via the HttpApiServer wired in cli.ts (--api-port).
    // MCP tools and push-cli connect as REST clients (see mcp-server
    // tools/ipc-utils.ts getRestIpcClient and push-cli.ts createRestClient).

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

    // Issue #4280 (part 5): no IPC server to stop — REST-only serving.

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
    const schedulerCallbacks = this.createSchedulerCallbacks();
    logger.info('Scheduler init step 3/6: ✓ Schedule callbacks created');

    // Step 4: Initialize Scheduler and schedule tasks
    logger.info('Scheduler init step 4/6: Creating Scheduler and loading tasks');
    this.scheduler = new Scheduler({
      scheduleManager: this.scheduleManager,
      cooldownManager: this.cooldownManager,
      callbacks: schedulerCallbacks,
      // Issue #3582: Route through InputMessageRouter to existing agents
      inputMessageRouter: this.inputMessageRouter,
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
   * Get the InputMessageRouter instance.
   * Issue #3582: Unified message routing (Phase 3).
   */
  getInputMessageRouter(): InputMessageRouter | undefined {
    return this.inputMessageRouter;
  }

  /**
   * Upload a local file to a chat — delegates to the channel's uploadFile
   * capability (reads the file at filePath and uploads it). REST parity with
   * the IPC uploadFile method (Issue #4279). filePath (not multipart) because
   * the REST face is localhost-bound and the caller is co-located.
   *
   * @returns upload metadata (fileKey/fileType/fileName/fileSize)
   */
  async uploadFile(
    chatId: string,
    filePath: string,
    threadId?: string,
  ): Promise<{ success: boolean; fileKey?: string; fileType?: string; fileName?: string; fileSize?: number }> {
    const h = this.resolveApiHandlers(chatId);
    if (!h) {
      throw new Error('No channel handlers available');
    }
    const result = await h.uploadFile(chatId, filePath, threadId);
    return { success: true, ...result };
  }

  /**
   * Upload a local image and return a Feishu image_key (for card embedding) —
   * delegates to the channel's uploadImage capability. Channel-agnostic (no
   * chatId). REST parity with the IPC uploadImage method (Issue #4279).
   *
   * @returns { success: boolean; imageKey?: string }
   */
  async uploadImage(filePath: string): Promise<{ success: boolean; imageKey?: string }> {
    const h = this.resolveApiHandlers();
    if (!h?.uploadImage) {
      throw new Error('uploadImage not supported by this channel');
    }
    const result = await h.uploadImage(filePath);
    return { success: true, ...result };
  }

  /**
   * Send a text message to a chat — delegates to the channel's sendMessage
   * capability. REST parity with the IPC sendMessage method (Issue #4279).
   *
   * @returns { success: boolean; messageId?: string } (mirrors IPC IpcResponsePayloads)
   */
  async sendMessage(
    chatId: string,
    text: string,
    threadId?: string,
    mentions?: Array<{ openId: string; name?: string }>,
  ): Promise<{ success: boolean; messageId?: string }> {
    const h = this.resolveApiHandlers(chatId);
    if (!h) {
      throw new Error('No channel handlers available');
    }
    // The channel handler returns Promise<void> (the IPC layer synthesizes
    // success/messageId); REST confirms acceptance with { success: true }.
    await h.sendMessage(chatId, text, threadId, mentions);
    return { success: true };
  }

  /**
   * Send a Feishu card to a chat — delegates to the channel's sendCard
   * capability. REST parity with the IPC sendCard method (Issue #4279).
   *
   * @returns { success: boolean; messageId?: string } (mirrors IPC IpcResponsePayloads)
   */
  async sendCard(
    chatId: string,
    card: FeishuCard,
    threadId?: string,
    description?: string,
  ): Promise<{ success: boolean; messageId?: string }> {
    const h = this.resolveApiHandlers(chatId);
    if (!h) {
      throw new Error('No channel handlers available');
    }
    // The channel handler returns Promise<void> (the IPC layer synthesizes
    // success/messageId); REST confirms acceptance with { success: true }.
    await h.sendCard(chatId, card, threadId, description);
    return { success: true };
  }

  /**
   * Send an interactive card (with buttons) to a chat — builds+sends the card
   * via the channel's sendInteractive capability and registers the action
   * prompts so button clicks resolve. REST parity with the IPC sendInteractive
   * method (Issue #4279); the registration mirrors the IPC handler (Issue #1572).
   *
   * @returns { success: boolean; messageId?: string }
   */
  async sendInteractive(
    chatId: string,
    params: {
      question: string;
      options: Array<{ text: string; value: string; type?: 'primary' | 'default' | 'danger' }>;
      title?: string;
      context?: string;
      threadId?: string;
      actionPrompts?: Record<string, string>;
    },
  ): Promise<{ success: boolean; messageId?: string }> {
    const h = this.resolveApiHandlers(chatId);
    if (!h?.sendInteractive) {
      throw new Error('sendInteractive not supported by this channel');
    }
    const result = await h.sendInteractive(chatId, params);
    // Mirror the IPC handler: register resolved action prompts (defaults may be
    // auto-generated by the channel handler — Issue #1572).
    const resolvedPrompts = (result as { actionPrompts?: Record<string, string> }).actionPrompts
      ?? params.actionPrompts;
    if (resolvedPrompts && result.messageId) {
      this.interactiveContextStore.register(result.messageId, chatId, resolvedPrompts);
    }
    // success mirrors the IPC handler, which returns success: true whenever the
    // channel handler resolves without throwing (unix-socket-server.ts sendInteractive).
    return { success: true, messageId: result.messageId };
  }

  /**
   * Resolve and invoke the channel's listTempChats capability (Issue #1703).
   *
   * Issue #4280 (part 5): with the IPC server gone this has a single caller —
   * the REST-facing `listTempChats()` public method below (which wraps the raw
   * chat list into `{ success, chats }`). Throws if the active channel does
   * not support temp-chat tracking. Returns the raw chat list so the caller
   * can wrap it into the REST response shape.
   */
  private async resolveChannelTempChats(): Promise<Array<{ chatId: string; createdAt: string; expiresAt: string; creatorChatId?: string; responded: boolean }>> {
    const h = this.resolveApiHandlers();
    if (!h?.listTempChats) {
      throw new Error('listTempChats not supported by this channel');
    }
    const chats = await h.listTempChats();
    return chats;
  }

  /**
   * List tracked temporary chats (Issue #1703) — delegates to the channel's
   * listTempChats capability. Channel-agnostic. REST parity with the IPC
   * listTempChats method (Issue #4279). Single-process semantics.
   *
   * @returns { success: boolean; chats: TempChat[] }
   */
  async listTempChats(): Promise<{
    success: boolean;
    chats: Array<{ chatId: string; createdAt: string; expiresAt: string; creatorChatId?: string; responded: boolean }>;
  }> {
    const chats = await this.resolveChannelTempChats();
    return { success: true, chats };
  }

  /**
   * Mark a tracked temporary chat as responded — delegates to the channel's
   * markChatResponded capability (temp-chat lifecycle, Issue #1703). REST
   * parity with the IPC markChatResponded method (Issue #4281); throws
   * "not supported by this channel" when the active channel lacks the
   * capability.
   *
   * @returns { success: boolean }
   */
  async markChatResponded(
    chatId: string,
    response: { selectedValue: string; responder: string; repliedAt: string },
  ): Promise<{ success: boolean }> {
    const h = this.resolveApiHandlers(chatId);
    if (!h?.markChatResponded) {
      throw new Error('markChatResponded not supported by this channel');
    }
    return await h.markChatResponded(chatId, response);
  }

  /**
   * Resolve the channel API handlers for a chatId.
   *
   * Shared by the REST-facing public methods (uploadFile/sendMessage/…) and
   * the scheduler push callbacks.
   * 1. Check registered channel handlers (channelHandlersMap) for chatId ownership
   * 2. Fall back to feishuHandlersContainer for backward compatibility
   */
  private resolveApiHandlers(chatId?: string): ChannelApiHandlers | undefined {
    if (chatId) {
      for (const { handlers, channel } of this.channelHandlersMap.values()) {
        if (channel.ownsChatId(chatId)) {
          return handlers;
        }
      }
    }
    return this.feishuHandlersContainer.handlers;
  }

  /**
   * Build the SchedulerCallbacks that bridge the Scheduler to PrimaryNode's
   * channel manager (sendMessage) and agent pool (resetAgent for clearContext).
   *
   * Extracted from initScheduler() for the Issue #4206 review nit so the
   * clearContext wiring is unit-testable in isolation — in particular so a test
   * can lock down that `resetAgent` calls `agentPool.reset(chatId, true)`
   * (skipContext=true). The boolean is inverted vs `ChatAgent.reset`'s
   * `keepContext`, so pinning the arg here guards against a future flip.
   *
   * Issue #4206: `skipContext` defaults to true (the clearContext intent — fresh
   * session). The scheduler passes `false` on clearContext-task failure to
   * clear a stale skip-history flag (see Scheduler.executeTask catch).
   */
  protected createSchedulerCallbacks(): SchedulerCallbacks {
    return {
      sendMessage: async (chatId: string, message: string): Promise<void> => {
        const outgoingMessage: OutgoingMessage = {
          type: 'text',
          chatId,
          text: message,
        };
        await this.channelManager.broadcast(outgoingMessage);
      },
      resetAgent: (chatId: string, skipContext: boolean = true): void => {
        this.agentPool?.reset(chatId, skipContext);
      },
      // Issue #4199: read lazily so it works regardless of init order between
      // initScheduler() and initInputMessageRouter(); undefined => no gating.
      isChatBusy: (chatId: string) => this.schedulerChatBusyProvider?.(chatId) ?? false,
    };
  }

  /**
   * Initialize the InputMessageRouter with the given agent pool and callbacks.
   * Issue #3582: Creates the unified input routing layer (Phase 3).
   *
   * Should be called after agent pool is set up but before channels are started.
   * Also stashes the agent pool reference so the scheduler's `clearContext`
   * callback (Issue #4206) can reset a chat's agent before a scheduled task.
   *
   * @param agentPool - Agent pool for creating/getting persistent agents
   * @param callbacksFactory - Factory for creating ChatAgentCallbacks per chat
   */
  initInputMessageRouter(
    agentPool: {
      /**
       * Issue #4587 (part 2): optional threadRootId (topic-group messages)
       * selects that thread's agent — per-thread session keying.
       */
      getOrCreateChatAgent: (chatId: string, callbacks: import('./agents/types.js').ChatAgentCallbacks, threadRootId?: string) => import('./agents/chat-agent.js').ChatAgent;
      reset: (chatId: string, skipContext?: boolean) => void;
      isAgentBusy?: (chatId: string) => boolean;
    },
    callbacksFactory: (chatId: string) => import('./agents/types.js').ChatAgentCallbacks,
  ): void {
    // Issue #4206: keep the pool so scheduler callbacks can reset an agent
    // (clearContext) before a scheduled task runs.
    this.agentPool = agentPool;
    // Issue #4199: capture the pool's busy-state provider so the scheduler can
    // skip blocking tasks whose target chat is currently processing a message.
    // Bind to agentPool — isAgentBusy is a prototype method that reads
    // `this.agents`, so destructuring it (`const { isAgentBusy } = pool`) and
    // invoking unbound would throw. undefined (pool has no isAgentBusy) => no gating.
    this.schedulerChatBusyProvider = agentPool.isAgentBusy?.bind(agentPool);
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
