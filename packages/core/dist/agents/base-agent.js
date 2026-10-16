/**
 * BaseAgent - Abstract base class for all Agent types.
 *
 * Provides common functionality:
 * - SDK configuration building via abstraction layer
 * - API logging
 * - Error handling
 *
 * Uses Template Method pattern - subclasses implement specific logic.
 *
 * @module agents/base-agent
 */
import { getProvider, } from '../sdk/index.js';
import { buildSdkEnv } from '../utils/sdk.js';
import { createLogger } from '../utils/logger.js';
import { AppError, ErrorCategory, formatError } from '../utils/error-handler.js';
import { getRuntimeContext, hasRuntimeContext, } from './types.js';
import { Config } from '../config/index.js';
import { loadRuntimeEnv } from '../config/runtime-env.js';
import path from 'node:path';
import { assertToolOptions } from '../sdk/tools.js';
import { withLlmSessionLimit } from '../sdk/llm-session-limit.js';
/**
 * Abstract base class for all Agent types.
 *
 * Implements Template Method pattern:
 * - Common logic in base class
 * - Specific logic in subclasses via abstract/protected methods
 *
 * Implements Disposable interface for resource cleanup (Issue #328).
 *
 * @example
 * ```typescript
 * class MyAgent extends BaseAgent {
 *   protected getAgentName() { return 'MyAgent'; }
 *
 *   async *query(input: string): AsyncIterable<AgentMessage> {
 *     const options = this.createSdkOptions();
 *     async function* singleInput(): AsyncGenerator<UserInput> {
 *       yield { role: 'user', content: input };
 *     }
 *     const { iterator } = this.createQueryStream(singleInput(), options);
 *     for await (const { parsed } of iterator) {
 *       yield this.formatMessage(parsed);
 *     }
 *   }
 * }
 * ```
 */
export class BaseAgent {
    // Common properties
    apiKey;
    model;
    apiBaseUrl;
    permissionMode;
    apiProtocol;
    selectedConfig;
    agentBackend;
    logger;
    initialized = false;
    sdkProvider;
    constructor(config) {
        this.apiKey = config.apiKey;
        this.model = config.model;
        this.apiBaseUrl = config.apiBaseUrl;
        this.permissionMode = config.permissionMode ?? 'bypassPermissions';
        this.apiProtocol = config.apiProtocol ?? (['codex', 'dsh'].includes(config.agentBackend ?? '')
            ? undefined : hasRuntimeContext() ? getRuntimeContext().getAgentConfig().apiProtocol ?? 'anthropic' : 'anthropic');
        this.selectedConfig = config;
        // Create logger with agent name
        this.logger = createLogger(this.getAgentName());
        // Get SDK provider instance
        this.sdkProvider = config.settings
            ? getProvider(config.agentBackend, config.settings)
            : getProvider(config.agentBackend);
        // disclaude service may select DSH as the global default without passing
        // an explicit per-agent override. Build options for the resolved backend.
        this.agentBackend =
            config.agentBackend ??
                (['claude', 'codex', 'pi', 'dsh'].includes(this.sdkProvider.name)
                    ? this.sdkProvider.name
                    : undefined);
    }
    /**
     * Create SDK options for agent execution.
     *
     * This method provides a unified way to build SDK options
     * with common configuration (cwd, permissionMode, env, model)
     * while allowing subclasses to add specific options.
     *
     * @param extra - Extra configuration to merge
     * @returns AgentQueryOptions object
     */
    createSdkOptions(extra = {}) {
        assertToolOptions(extra);
        const workspaceDir = this.getWorkspaceDir();
        const effectiveCwd = extra.cwd ?? workspaceDir;
        // Issue #3532: When cwd differs from workspace (project binding via /project use),
        // set CLAUDE_CONFIG_DIR so workspace skills remain accessible after project switch.
        const isProjectBound = extra.cwd !== undefined && extra.cwd !== workspaceDir;
        const options = {
            cwd: effectiveCwd,
            ...(extra.projectRoot ? { projectRoot: extra.projectRoot } : {}),
            permissionMode: this.permissionMode,
            ...(extra.sessionKey !== undefined ? { sessionKey: extra.sessionKey } : {}),
            ...(extra.tools !== undefined ? { tools: extra.tools } : {}),
            settingSources: ['user', 'project', 'local'],
            ...((this.agentBackend ?? 'claude') !== 'claude'
                ? {}
                : {
                    systemPrompt: { type: 'preset', preset: 'claude_code' },
                }),
        };
        // Set environment: config env + runtime env file (Issue #1361)
        const loggingConfig = this.getLoggingConfig();
        const globalEnv = {
            ...this.getGlobalEnv(),
            ...loadRuntimeEnv(workspaceDir),
        };
        // Claude owns native aliases; pass configured ANTHROPIC_DEFAULT_*_MODEL
        // through unchanged instead of inventing disclaude capability tiers.
        if ((this.agentBackend ?? 'claude') === 'claude') {
            // Issue #3532: Set CLAUDE_CONFIG_DIR to workspace .claude dir when project-bound.
            // This redirects SDK's user scope to workspace, making workspace skills always available.
            if (isProjectBound) {
                globalEnv.CLAUDE_CONFIG_DIR = path.join(workspaceDir, '.claude');
            }
        }
        // Issue #3803: Expose workspace directory to agent so skills (e.g., schedule)
        // can resolve workspace paths correctly regardless of the agent's cwd.
        globalEnv.DISCLAUDE_WORKSPACE_DIR = workspaceDir;
        options.env = buildSdkEnv(this.apiKey, this.apiBaseUrl, globalEnv, loggingConfig.sdkDebug, this.selectedConfig.settings ? this.selectedConfig.settings.sdkTimeoutMs ?? 300_000 : this.getSdkTimeoutMs(), { protocol: this.apiProtocol, selectedEnv: this.selectedConfig.env,
            credentialEnvKeys: this.selectedConfig.credentialEnvKeys });
        if (this.agentBackend === 'codex' && this.selectedConfig.settings) {
            const { settings } = this.selectedConfig;
            options.codexRuntime = {
                sandbox: settings.codexSandbox, fullAccess: settings.fullAccess,
                networkAccess: settings.codexNetworkAccess, transport: settings.codex?.transport,
            };
        }
        options.apiProtocol = this.apiProtocol;
        options.reasoningEffort = this.selectedConfig.reasoningEffort;
        if (this.selectedConfig.llm && this.selectedConfig.maxConcurrentSessions !== undefined) {
            options.llmSessionLimit = {
                name: this.selectedConfig.llm, maxConcurrentSessions: this.selectedConfig.maxConcurrentSessions,
            };
        }
        // Set model
        if (this.model) {
            options.model = this.model;
        }
        // SDK 0.3.177+: Agent Teams is enabled via teammateMode Settings field,
        // replacing the deprecated CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS env var.
        if ((this.agentBackend ?? 'claude') === 'claude' && (this.selectedConfig.settings ? this.selectedConfig.settings.enableAgentTeams ?? false : this.isAgentTeamsEnabled())) {
            options.teammateMode = 'in-process';
        }
        // Claude leaves an absent policy to the SDK. DSH retains its own default.
        const backend = this.agentBackend ?? 'claude';
        if (backend === 'claude' || backend === 'dsh') {
            const window = this.selectedConfig.settings ? this.selectedConfig.settings.autoCompactWindow : Config.getAutoCompactWindow();
            if (window !== undefined || backend === 'dsh') {
                options.autoCompactWindow = window ?? 'auto';
            }
        }
        // Partial events expose thinking/token activity to the host activity clock.
        // The provider filters them from user output; SDK/CLI still owns retries.
        if ((this.agentBackend ?? 'claude') === 'claude') {
            options.includePartialMessages = true;
        }
        return options;
    }
    /**
     * Get workspace directory from runtime context.
     */
    getWorkspaceDir() {
        if (hasRuntimeContext()) {
            return getRuntimeContext().getWorkspaceDir();
        }
        return Config.getWorkspaceDir();
    }
    /**
     * Get logging config from runtime context.
     */
    getLoggingConfig() {
        if (hasRuntimeContext()) {
            return getRuntimeContext().getLoggingConfig();
        }
        // Fallback to environment variable
        return { sdkDebug: process.env.SDK_DEBUG === 'true' };
    }
    /**
     * Get global env from runtime context.
     * Falls back to Config.getGlobalEnv() when runtime context is not set,
     * providing defense in depth against missing setRuntimeContext() calls.
     *
     * @see Issue #1839
     */
    getGlobalEnv() {
        if (hasRuntimeContext()) {
            return getRuntimeContext().getGlobalEnv();
        }
        // Fallback: read directly from config when runtime context is not set
        return Config.getGlobalEnv();
    }
    /**
     * Check if Agent Teams is enabled from runtime context.
     */
    isAgentTeamsEnabled() {
        if (hasRuntimeContext()) {
            return getRuntimeContext().isAgentTeamsEnabled();
        }
        return false;
    }
    /**
     * Get SDK HTTP request timeout from config.
     * @see Issue #2992
     */
    getSdkTimeoutMs() {
        return Config.getSdkTimeoutMs();
    }
    /**
     * Convert SDK AgentMessage to legacy parsed format for compatibility.
     */
    convertToLegacyFormat(message) {
        return {
            type: message.type,
            content: message.content,
            metadata: message.metadata
                ? {
                    toolName: message.metadata.toolName,
                    toolInput: message.metadata.toolInput,
                    toolInputRaw: message.metadata.toolInput,
                    toolOutput: message.metadata.toolOutput,
                    elapsed: message.metadata.elapsedMs,
                    stopReason: message.metadata.stopReason,
                    numTurns: message.metadata.numTurns,
                    durationMs: message.metadata.durationMs,
                    durationApiMs: message.metadata.durationApiMs,
                    consumedInputIds: message.metadata.consumedInputIds,
                    transientStatus: message.metadata.transientStatus,
                    phase: message.metadata.phase,
                    systemSubtype: message.metadata.systemSubtype,
                    backgroundTaskIds: message.metadata.backgroundTaskIds,
                    backgroundTask: message.metadata.backgroundTask,
                }
                : undefined,
            sessionId: message.metadata?.sessionId,
            terminatedReason: message.metadata?.terminatedReason,
            terminationDetail: message.metadata?.terminationDetail,
            upstreamApiError: message.metadata?.upstreamApiError,
            automaticReplayBlocked: message.metadata?.automaticReplayBlocked,
            upstreamApiErrorStderr: message.metadata?.upstreamApiErrorStderr,
        };
    }
    /**
     * Execute a streaming query.
     *
     * For conversational agents (ChatAgent) that use dynamic input generators.
     * Input is an AsyncGenerator that yields user messages on demand.
     *
     * This method creates a query and returns both the QueryHandle
     * (for lifecycle control) and an AsyncGenerator for iterating messages.
     *
     * Features:
     * - Automatic debug logging
     * - Parsed message output
     * - QueryHandle for close/cancel operations
     *
     * @param input - AsyncGenerator yielding user messages
     * @param options - AgentQueryOptions
     * @returns QueryStreamResult with handle and iterator
     */
    createQueryStream(input, options) {
        // Convert SDK UserMessage to SDK UserInput
        async function* convertInput() {
            for await (const msg of input) {
                yield {
                    role: 'user',
                    ...(msg.correlation ? { correlation: { ...msg.correlation } } : {}),
                    ...(msg.inputContext ? { inputContext: { ...msg.inputContext } } : {}),
                    ...(msg.continuationContext ? { continuationContext: msg.continuationContext } : {}),
                    content: typeof msg.message?.content === 'string'
                        ? msg.message.content
                        : JSON.stringify(msg.message?.content ?? ''),
                };
            }
        }
        const result = withLlmSessionLimit(() => this.sdkProvider.queryStream(convertInput(), options), this.sdkProvider.managesLlmSessionLimit?.(options) ? undefined : options.llmSessionLimit, () => {
            const info = this.sdkProvider.getInfo(this.selectedConfig);
            if (!info.available) {
                throw new Error(info.unavailableReason ?? 'Selected agent backend is unavailable');
            }
        });
        const self = this;
        const streamStartMs = Date.now(); // Issue #3003: track stream timing
        async function* wrappedIterator() {
            let firstYieldMs;
            let yieldCount = 0;
            for await (const message of result.iterator) {
                const parsed = self.convertToLegacyFormat(message);
                yieldCount++;
                // Issue #3003: Track TTFT at baseAgent level
                if (!firstYieldMs) {
                    firstYieldMs = Date.now();
                    self.logger.info({
                        provider: self.apiProtocol,
                        ttftMs: firstYieldMs - streamStartMs,
                        messageType: parsed.type,
                    }, 'First message yielded from SDK stream (TTFT)');
                }
                // Log SDK message with full details for debugging
                self.logger.debug({
                    provider: self.apiProtocol,
                    messageType: parsed.type,
                    contentLength: parsed.content?.length || 0,
                    toolName: parsed.metadata?.toolName,
                    elapsedMs: Date.now() - streamStartMs,
                    yieldCount,
                }, 'SDK message received');
                yield { parsed, raw: message };
            }
            // Issue #3003: Log stream completion timing
            const totalMs = Date.now() - streamStartMs;
            self.logger.info({
                provider: self.apiProtocol,
                totalMs,
                yieldCount,
                ttftMs: firstYieldMs ? firstYieldMs - streamStartMs : undefined,
            }, 'SDK stream completed');
        }
        const iterator = wrappedIterator();
        const returnIterator = iterator.return.bind(iterator);
        iterator.return = (value) => {
            result.handle.close();
            return returnIterator(value);
        };
        return {
            handle: result.handle,
            iterator,
        };
    }
    /**
     * Handle iterator error with proper logging and error wrapping.
     *
     * Creates AppError and returns an AgentMessage for yielding to caller.
     *
     * @param error - The caught error
     * @param operation - Operation name for error message
     * @returns AgentMessage for yielding to caller
     */
    handleIteratorError(error, operation) {
        const agentError = new AppError(`${this.getAgentName()} ${operation} failed`, ErrorCategory.SDK, undefined, {
            cause: error instanceof Error ? error : new Error(String(error)),
            context: { agent: this.getAgentName() },
            retryable: true,
        });
        this.logger.error({ err: formatError(agentError) }, `${operation} failed`);
        return {
            content: `Error: ${error instanceof Error ? error.message : String(error)}`,
            role: 'assistant',
            messageType: 'error',
        };
    }
    /**
     * Format parsed message as AgentMessage.
     *
     * Convenience method for subclasses.
     *
     * @param parsed - Parsed SDK message
     * @returns AgentMessage
     */
    formatMessage(parsed) {
        return {
            content: parsed.content,
            role: 'assistant',
            messageType: parsed.type,
            metadata: parsed.metadata,
        };
    }
    /**
     * Dispose of resources held by this agent.
     *
     * This method is idempotent - safe to call multiple times.
     * Subclasses should call super.dispose() if overriding.
     *
     * Implements Disposable interface (Issue #328).
     */
    dispose() {
        if (!this.initialized) {
            return; // Already disposed, idempotent
        }
        this.logger.debug(`${this.getAgentName()} disposed`);
        this.initialized = false;
    }
}
