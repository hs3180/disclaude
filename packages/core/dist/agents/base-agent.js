/**
 * BaseAgent - Abstract base class for all Agent types.
 *
 * Provides common functionality:
 * - SDK configuration building via abstraction layer
 * - GLM logging
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
 *     const options = this.createSdkOptions({ allowedTools: ['Read', 'Write'] });
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
    provider;
    agentBackend;
    logger;
    initialized = false;
    sdkProvider;
    constructor(config) {
        this.apiKey = config.apiKey;
        this.model = config.model;
        this.apiBaseUrl = config.apiBaseUrl;
        this.permissionMode = config.permissionMode ?? 'bypassPermissions';
        // Get provider from config, fallback to runtime context
        // This allows agents to be created with explicit provider setting
        // while maintaining backward compatibility
        this.provider = config.provider ?? this.getDefaultProvider();
        // Create logger with agent name
        this.logger = createLogger(this.getAgentName());
        // Get SDK provider instance
        this.sdkProvider = getProvider(config.agentBackend);
        // disclaude service may select DeepSeek as the global default without passing
        // an explicit per-agent override. Build options for the resolved backend.
        this.agentBackend =
            config.agentBackend ??
                (['claude', 'codex', 'pi', 'deepseek'].includes(this.sdkProvider.name)
                    ? this.sdkProvider.name
                    : undefined);
    }
    /**
     * Get default provider from runtime context.
     */
    getDefaultProvider() {
        if (hasRuntimeContext()) {
            return getRuntimeContext().getAgentConfig().provider;
        }
        // Default to anthropic if no runtime context
        return 'anthropic';
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
        const workspaceDir = this.getWorkspaceDir();
        const effectiveCwd = extra.cwd ?? workspaceDir;
        // Issue #3532: When cwd differs from workspace (project binding via /project use),
        // set CLAUDE_CONFIG_DIR so workspace skills remain accessible after project switch.
        const isProjectBound = extra.cwd !== undefined && extra.cwd !== workspaceDir;
        const options = {
            cwd: effectiveCwd,
            permissionMode: this.permissionMode,
            ...(extra.sessionKey !== undefined ? { sessionKey: extra.sessionKey } : {}),
            settingSources: ['user', 'project', 'local'],
            ...((this.agentBackend ?? 'claude') !== 'claude'
                ? {}
                : {
                    systemPrompt: { type: 'preset', preset: 'claude_code' },
                    tools: { type: 'preset', preset: 'claude_code' },
                }),
        };
        // Add allowed/disallowed tools
        if (extra.allowedTools) {
            options.allowedTools = extra.allowedTools;
        }
        if (extra.disallowedTools) {
            const nonApplicableDeepSeekDefaults = new Set([
                'EnterPlanMode',
                'AskUserQuestion',
                'CronCreate',
                'CronList',
                'CronDelete',
                'ScheduleWakeup',
            ]);
            const disallowedTools = this.agentBackend === 'deepseek'
                ? extra.disallowedTools.filter((tool) => !nonApplicableDeepSeekDefaults.has(tool))
                : extra.disallowedTools;
            if (disallowedTools.length > 0) {
                options.disallowedTools = disallowedTools;
            }
        }
        // Add MCP servers (convert to SDK format)
        if (extra.mcpServers) {
            options.mcpServers = extra.mcpServers;
        }
        // Set environment: config env + runtime env file (Issue #1361)
        const loggingConfig = this.getLoggingConfig();
        const globalEnv = {
            ...this.getGlobalEnv(),
            ...loadRuntimeEnv(workspaceDir),
        };
        // Issue #3770: Inject model tier env vars so SDK sub-agents (Task tool,
        // Team workers) resolve opus/sonnet/haiku aliases to the correct model
        // names for the active provider. Without this, the SDK resolves "haiku"
        // to a Claude default (e.g., "claude-haiku-4-5-20251001") that
        // non-Anthropic endpoints don't recognize, causing sub-agents to fail
        // with 400 Invalid model name errors.
        if ((this.agentBackend ?? 'claude') === 'claude') {
            const opusModel = Config.getModelForTier('high');
            const haikuModel = Config.getModelForTier('low');
            const sonnetModel = Config.getModelForTier('multimodal');
            if (opusModel && !globalEnv.ANTHROPIC_DEFAULT_OPUS_MODEL) {
                globalEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = opusModel;
            }
            if (sonnetModel && !globalEnv.ANTHROPIC_DEFAULT_SONNET_MODEL) {
                globalEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetModel;
            }
            if (haikuModel && !globalEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
                globalEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = haikuModel;
            }
            // Issue #3532: Set CLAUDE_CONFIG_DIR to workspace .claude dir when project-bound.
            // This redirects SDK's user scope to workspace, making workspace skills always available.
            if (isProjectBound) {
                globalEnv.CLAUDE_CONFIG_DIR = path.join(workspaceDir, '.claude');
            }
        }
        // Issue #3803: Expose workspace directory to agent so skills (e.g., schedule)
        // can resolve workspace paths correctly regardless of the agent's cwd.
        globalEnv.DISCLAUDE_WORKSPACE_DIR = workspaceDir;
        options.env = buildSdkEnv(this.apiKey, this.apiBaseUrl, globalEnv, loggingConfig.sdkDebug, this.getSdkTimeoutMs());
        // Set model
        if (this.model) {
            options.model = this.model;
        }
        // SDK 0.3.177+: Agent Teams is enabled via teammateMode Settings field,
        // replacing the deprecated CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS env var.
        if ((this.agentBackend ?? 'claude') === 'claude' && this.isAgentTeamsEnabled()) {
            options.teammateMode = 'in-process';
        }
        // Explicit configuration wins for every Claude-backend model. Discovery is
        // asynchronous and runs in the provider before starting the SDK subprocess.
        if ((this.agentBackend ?? 'claude') === 'claude') {
            options.autoCompactWindow = Config.getAutoCompactWindow() ?? 'auto';
        }
        // Issue #3706 (GLM stall): enable partial (stream_event) messages so the provider
        // can observe content_block_delta / message_start / message_stop and run a
        // no-content-progress watchdog. stream_events are filtered in adaptIterator
        // (not yielded to ChatAgent), so this only adds watchdog visibility, not downstream volume.
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
                    cost: message.metadata.costUsd,
                    tokens: (message.metadata.inputTokens ?? 0) + (message.metadata.outputTokens ?? 0),
                    stopReason: message.metadata.stopReason,
                    numTurns: message.metadata.numTurns,
                    durationMs: message.metadata.durationMs,
                    durationApiMs: message.metadata.durationApiMs,
                }
                : undefined,
            sessionId: message.metadata?.sessionId,
            terminatedReason: message.metadata?.terminatedReason,
            upstreamApiError: message.metadata?.upstreamApiError,
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
                    content: typeof msg.message?.content === 'string'
                        ? msg.message.content
                        : JSON.stringify(msg.message?.content ?? ''),
                };
            }
        }
        const result = this.sdkProvider.queryStream(convertInput(), options);
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
                        provider: self.provider,
                        ttftMs: firstYieldMs - streamStartMs,
                        messageType: parsed.type,
                    }, 'First message yielded from SDK stream (TTFT)');
                }
                // Log SDK message with full details for debugging
                self.logger.debug({
                    provider: self.provider,
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
                provider: self.provider,
                totalMs,
                yieldCount,
                ttftMs: firstYieldMs ? firstYieldMs - streamStartMs : undefined,
            }, 'SDK stream completed');
        }
        return {
            handle: result.handle,
            iterator: wrappedIterator(),
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
