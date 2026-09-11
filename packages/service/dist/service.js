/**
 * Application lifecycle: channels, local harness execution, interaction context
 * and scheduling. No execution-node roles or remote-node routing are exposed.
 */
import * as path from 'path';
import { EventEmitter } from 'events';
import { createLogger, 
// Issue #1377: Scheduler integration
Scheduler, ScheduleManager, ScheduleFileWatcher, CooldownManager, 
// Issue #4648 residual ⑥: restart-surviving failure streaks
TaskFailureStore, Config, 
// Issue #4388: select Agent SDK backend from config at boot.
setDefaultProvider, 
// Issue #4629: fail-fast availability probe of the selected backend.
getProvider, 
// Issue #3582: Input MessageRouter for unified routing
MessageRouter as InputMessageRouter, } from "../../core/dist/index.js";
import { getDebugGroupService } from './services/debug-group-service.js';
import { ChannelManager } from './channel-manager.js';
import { InteractiveContextStore } from './interactive-context.js';
import { AgentPoolMessageHandler } from './messaging/agent-pool-handler.js';
const logger = createLogger('DisclaudeService');
/**
 * Application lifecycle and coordination of channels, sessions and scheduling.
 *
 * Responsibilities:
 * - Lifecycle management (start/stop)
 * - Channel registration and setup
 * - Local execution initialization
 * - Coordination between services
 *
 * Delegated concerns:
 * - FeedbackRouter: Feedback routing to channels
 * - SchedulerService: Scheduler and file watcher management
 *
 * Independent deployments do not participate in a node-role hierarchy.
 */
export class DisclaudeService extends EventEmitter {
    running = false;
    // Diagnostic process identity
    instanceId;
    // Services
    debugGroupService;
    // Channel management (Issue #1594: unified channel lifecycle)
    channelManager;
    feishuHandlersContainer = { handlers: undefined };
    // Issue #3814: Multi-channel handler routing (chatId ownership)
    channelHandlersMap = new Map();
    // Scheduler (Issue #1377)
    scheduler;
    scheduleManager;
    scheduleFileWatcher;
    cooldownManager;
    /** Issue #4648 residual ⑥: file-backed failure streaks (survive restarts) */
    taskFailureStore;
    // Input MessageRouter for unified routing (Issue #3582 Phase 3)
    inputMessageRouter;
    // Issue #4206: stashed in initInputMessageRouter() so the scheduler's
    // clearContext callback can reset a chat's agent before a scheduled task.
    // Issue #4587 (part 2): getOrCreateChatAgent takes an optional threadRootId
    // (topic-group thread session keying).
    agentPool;
    // Issue #4199: optional busy-state provider used to gate blocking scheduled
    // tasks whose target chat is mid-conversation. Set by initInputMessageRouter.
    schedulerChatBusyProvider;
    // Interactive context store (Issue #1572: Phase 3 of #1568)
    interactiveContextStore;
    constructor(config = {}) {
        super();
        for (const key of Object.keys(config)) {
            if (key !== 'instanceId') {
                throw new Error(`Unsupported service option: ${key}. Configure channels and HTTP through the unified CLI/configuration file.`);
            }
        }
        this.instanceId = config.instanceId || `service-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // Initialize DebugGroupService
        this.debugGroupService = getDebugGroupService();
        // Initialize ChannelManager (Issue #1594: unified channel lifecycle)
        this.channelManager = new ChannelManager();
        // Initialize InteractiveContextStore (Issue #1572)
        this.interactiveContextStore = new InteractiveContextStore();
        logger.info({
            instanceId: this.instanceId,
        }, 'DisclaudeService created');
    }
    /**
     * Get this process's diagnostic identity.
     */
    getInstanceId() {
        return this.instanceId;
    }
    /**
     * Check if the node is running.
     */
    isRunning() {
        return this.running;
    }
    /**
     * Get the DebugGroupService.
     */
    getDebugGroupService() {
        return this.debugGroupService;
    }
    /**
     * Get the InteractiveContextStore.
     * Issue #1572: Phase 3 of REST API layer responsibility refactoring.
     */
    getInteractiveContextStore() {
        return this.interactiveContextStore;
    }
    /**
     * Register a communication channel.
     * Delegates to ChannelManager (Issue #1594: unified channel lifecycle).
     */
    registerChannel(channel) {
        this.channelManager.register(channel);
    }
    /**
     * Unregister a communication channel.
     */
    unregisterChannel(channelId) {
        return this.channelManager.unregister(channelId);
    }
    /**
     * Get the ChannelManager for advanced channel operations.
     * Issue #1594: unified channel lifecycle.
     */
    getChannelManager() {
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
    registerFeishuHandlers(handlers) {
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
    registerChannelHandlers(channelType, handlers, channel) {
        this.channelHandlersMap.set(channelType, { handlers, channel });
        logger.info({ channelType }, 'Channel API handlers registered');
    }
    /**
     * Get all registered channels.
     */
    getChannels() {
        return this.channelManager.getAll();
    }
    /**
     * Get a channel by ID.
     */
    getChannel(channelId) {
        return this.channelManager.get(channelId);
    }
    /**
     * Start the disclaude service.
     *
     * Issue #3361: Scheduler initialization is now non-fatal.
     * If scheduler fails, DisclaudeService still starts (Feishu, REST channels work).
     * Scheduler status is logged and queryable via getSchedulerStatus().
     */
    schedulerDeferred = false;
    async start(options = {}) {
        if (this.running) {
            logger.warn('DisclaudeService already running');
            return;
        }
        logger.info({ instanceId: this.instanceId }, 'Starting DisclaudeService');
        // Issue #4388: select the Agent SDK backend from config.
        // Must run before any ChatAgent is created (getProvider() reads the default).
        // agentBackend is orthogonal to the model-layer `provider` (LLM API).
        const agentBackend = Config.AGENT_BACKEND;
        if (!agentBackend) {
            throw new Error('No agent backend configured. Set agent.agentBackend (claude, pi, codex, or deepseek) ' +
                'or declare an agents preset.');
        }
        try {
            setDefaultProvider(agentBackend);
            const backendInfo = getProvider(agentBackend).getInfo();
            if (!backendInfo.available) {
                throw new Error(`Agent backend "${agentBackend}" is unavailable: ` +
                    `${backendInfo.unavailableReason ?? 'environment check failed'}`);
            }
            logger.info({ agentBackend }, 'Agent SDK backend selected from config');
        }
        catch (error) {
            logger.error({ err: error, agentBackend }, 'Configured agent backend failed startup; refusing to switch backends');
            throw error;
        }
        // Issue #4280 (part 5): no REST API server is started anymore — DisclaudeService
        // serves REST-only via the HttpApiServer wired in cli.ts (--api-port).
        // Channel CLI tools and push-cli connect as REST clients.
        this.schedulerDeferred = options.deferScheduler === true;
        if (!this.schedulerDeferred) {
            await this.startSchedulerSafely();
        }
        this.running = true;
        this.emit('started');
        logger.info({ instanceId: this.instanceId }, 'DisclaudeService started');
    }
    /** Called by CLI only after the actual REST address has been published. */
    async startDeferredScheduler() {
        if (!this.running || !this.schedulerDeferred) {
            return;
        }
        this.schedulerDeferred = false;
        await this.startSchedulerSafely();
    }
    async startSchedulerSafely() {
        // Initialize Scheduler (Issue #1377)
        // Issue #3361: Wrap in try-catch to prevent scheduler failure from
        // blocking the entire DisclaudeService startup. Main channels (Feishu, REST)
        // should still work even if the scheduler is down.
        try {
            await this.initScheduler();
        }
        catch (error) {
            logger.error({ err: error, instanceId: this.instanceId }, '⚠️ Scheduler initialization failed — scheduled tasks will not run. ' +
                'DisclaudeService continues without scheduler. Check logs above for details.');
        }
    }
    /**
     * Stop the disclaude service.
     */
    async stop() {
        if (!this.running) {
            logger.warn('DisclaudeService not running');
            return;
        }
        logger.info({ instanceId: this.instanceId }, 'Stopping DisclaudeService');
        this.schedulerDeferred = false;
        // Stop Scheduler (Issue #1377)
        await this.stopScheduler();
        // Issue #4280 (part 5): no REST API server to stop — REST-only serving.
        this.running = false;
        this.emit('stopped');
        logger.info({ instanceId: this.instanceId }, 'DisclaudeService stopped');
    }
    // ============================================================================
    // Scheduler (Issue #1377)
    // ============================================================================
    /**
     * Initialize the scheduler for scheduled task execution.
     *
     * Issue #1377: Scheduler integration for disclaude service
     * Issue #3582: Route tasks through InputMessageRouter to existing agents
     * Issue #3361: Added step-by-step logging for diagnostics.
     *   Each initialization phase logs success/failure explicitly so that
     *   operators can pinpoint which step failed when scheduler appears silent.
     */
    async initScheduler() {
        const workspaceDir = Config.getWorkspaceDir();
        const schedulesDir = path.join(workspaceDir, 'schedules');
        const cooldownDir = path.join(schedulesDir, '.cooldown');
        logger.info({ schedulesDir }, 'Initializing scheduler...');
        // Step 1: Initialize CooldownManager
        logger.info('Scheduler init step 1/6: Initializing CooldownManager');
        this.cooldownManager = new CooldownManager({ cooldownDir });
        logger.info({ cooldownDir }, 'Scheduler init step 1/6: ✓ CooldownManager ready');
        // Issue #4648 residual ⑥: failure streaks persist beside cooldown state,
        // so the consecutive-failure alert can fire across restarts (crash loops).
        const failureDir = path.join(schedulesDir, '.failures');
        this.taskFailureStore = new TaskFailureStore({ dir: failureDir });
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
            // Issue #4648 residual ⑥: persist failure streaks across restarts
            failureStore: this.taskFailureStore,
            callbacks: schedulerCallbacks,
            // Issue #3582: Route through InputMessageRouter to existing agents
            inputMessageRouter: this.inputMessageRouter,
        });
        // Issue #3860 P1: Start file watcher BEFORE scheduler.start() to close the
        // race window between initial load and watcher startup. File events that
        // arrive during scheduler.start() will now be captured by the watcher.
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
            onFileRemoved: (taskId, _filePath) => {
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
        const taskMtimes = new Map();
        for (const job of activeJobs) {
            // Use current time as baseline mtime since we don't have file stats at this point
            taskMtimes.set(job.taskId, new Date());
        }
        this.scheduleFileWatcher.setKnownTaskIds(new Set(activeJobs.map(j => j.taskId)), taskMtimes);
        logger.info({ activeJobCount }, 'Scheduler init step 6/6: ✓ Scheduler started');
        logger.info({ schedulesDir, activeJobCount }, 'Scheduler fully initialized');
    }
    /**
     * Stop the scheduler.
     * Issue #3415: Made async to allow graceful shutdown of running tasks.
     */
    async stopScheduler() {
        this.scheduleFileWatcher?.stop();
        await this.scheduler?.stop();
        logger.info('Scheduler stopped');
    }
    /**
     * Get the Scheduler instance.
     */
    getScheduler() {
        return this.scheduler;
    }
    /**
     * Get the InputMessageRouter instance.
     * Issue #3582: Unified message routing (Phase 3).
     */
    getInputMessageRouter() {
        return this.inputMessageRouter;
    }
    /**
     * Upload a local file to a chat — delegates to the channel's uploadFile
     * capability (reads the file at filePath and uploads it). REST parity with
     * the REST API uploadFile method (Issue #4279). filePath (not multipart) because
     * the REST face is localhost-bound and the caller is co-located.
     *
     * @returns upload metadata (fileKey/fileType/fileName/fileSize)
     */
    async uploadFile(chatId, filePath, threadId) {
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
     * chatId). REST parity with the REST API uploadImage method (Issue #4279).
     *
     * @returns { success: boolean; imageKey?: string }
     */
    async uploadImage(filePath) {
        const h = this.resolveApiHandlers();
        if (!h?.uploadImage) {
            throw new Error('uploadImage not supported by this channel');
        }
        const result = await h.uploadImage(filePath);
        return { success: true, ...result };
    }
    /**
     * Send a text message to a chat — delegates to the channel's sendMessage
     * capability. REST parity with the REST API sendMessage method (Issue #4279).
     *
     * @returns { success: boolean; messageId?: string } (mirrors REST API ChannelApiResponsePayloads)
     */
    async sendMessage(chatId, text, threadId, mentions) {
        const h = this.resolveApiHandlers(chatId);
        if (!h) {
            throw new Error('No channel handlers available');
        }
        // The channel handler returns Promise<void> (the REST API layer synthesizes
        // success/messageId); REST confirms acceptance with { success: true }.
        await h.sendMessage(chatId, text, threadId, mentions);
        return { success: true };
    }
    /**
     * Send a Feishu card to a chat — delegates to the channel's sendCard
     * capability. REST parity with the REST API sendCard method (Issue #4279).
     *
     * @returns { success: boolean; messageId?: string } (mirrors REST API ChannelApiResponsePayloads)
     */
    async sendCard(chatId, card, threadId, description) {
        const h = this.resolveApiHandlers(chatId);
        if (!h) {
            throw new Error('No channel handlers available');
        }
        // The channel handler returns Promise<void> (the REST API layer synthesizes
        // success/messageId); REST confirms acceptance with { success: true }.
        await h.sendCard(chatId, card, threadId, description);
        return { success: true };
    }
    /**
     * Send an interactive card (with buttons) to a chat — builds+sends the card
     * via the channel's sendInteractive capability and registers the action
     * prompts so button clicks resolve. REST parity with the REST API sendInteractive
     * method (Issue #4279); the registration mirrors the REST API handler (Issue #1572).
     *
     * @returns { success: boolean; messageId?: string }
     */
    async sendInteractive(chatId, params) {
        const h = this.resolveApiHandlers(chatId);
        if (!h?.sendInteractive) {
            throw new Error('sendInteractive not supported by this channel');
        }
        const result = await h.sendInteractive(chatId, params);
        // Mirror the REST API handler: register resolved action prompts (defaults may be
        // auto-generated by the channel handler — Issue #1572).
        const resolvedPrompts = result.actionPrompts
            ?? params.actionPrompts;
        if (resolvedPrompts && result.messageId) {
            this.interactiveContextStore.register(result.messageId, chatId, resolvedPrompts);
        }
        // success mirrors the REST API handler, which returns success: true whenever the
        // channel handler resolves without throwing.
        return { success: true, messageId: result.messageId };
    }
    /**
     * Resolve and invoke the channel's listTempChats capability (Issue #1703).
     *
     * Issue #4280 (part 5): with the REST API server gone this has a single caller —
     * the REST-facing `listTempChats()` public method below (which wraps the raw
     * chat list into `{ success, chats }`). Throws if the active channel does
     * not support temp-chat tracking. Returns the raw chat list so the caller
     * can wrap it into the REST response shape.
     */
    async resolveChannelTempChats() {
        const h = this.resolveApiHandlers();
        if (!h?.listTempChats) {
            throw new Error('listTempChats not supported by this channel');
        }
        const chats = await h.listTempChats();
        return chats;
    }
    /**
     * List tracked temporary chats (Issue #1703) — delegates to the channel's
     * listTempChats capability. Channel-agnostic. REST parity with the REST API
     * listTempChats method (Issue #4279). Single-process semantics.
     *
     * @returns { success: boolean; chats: TempChat[] }
     */
    async listTempChats() {
        const chats = await this.resolveChannelTempChats();
        return { success: true, chats };
    }
    /**
     * Mark a tracked temporary chat as responded — delegates to the channel's
     * markChatResponded capability (temp-chat lifecycle, Issue #1703). REST
     * parity with the REST API markChatResponded method (Issue #4281); throws
     * "not supported by this channel" when the active channel lacks the
     * capability.
     *
     * @returns { success: boolean }
     */
    async markChatResponded(chatId, response) {
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
    resolveApiHandlers(chatId) {
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
     * Build the SchedulerCallbacks that bridge the Scheduler to DisclaudeService's
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
    createSchedulerCallbacks() {
        return {
            sendMessage: async (chatId, message) => {
                const outgoingMessage = {
                    type: 'text',
                    chatId,
                    text: message,
                };
                await this.channelManager.broadcast(outgoingMessage);
            },
            resetAgent: (chatId, skipContext = true) => {
                this.agentPool?.reset(chatId, skipContext);
            },
            // Issue #4199: read lazily so it works regardless of init order between
            // initScheduler() and initInputMessageRouter(); undefined => no gating.
            isChatBusy: (chatId) => this.schedulerChatBusyProvider?.(chatId) ?? false,
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
    initInputMessageRouter(agentPool, callbacksFactory) {
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
    getScheduleManager() {
        return this.scheduleManager;
    }
    /**
     * Get scheduler status for health monitoring.
     * Issue #3361: Exposes scheduler health so operators can detect
     * silent failures without digging through log files.
     *
     * @returns Structured scheduler status object
     */
    getSchedulerStatus() {
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
