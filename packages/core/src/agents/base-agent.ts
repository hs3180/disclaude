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

import {
  getProvider,
  type IAgentSDKProvider,
  type AgentQueryOptions,
  type UserInput,
  type StreamingUserMessage,
  type QueryHandle,
  type AgentMessage as SdkAgentMessage,
} from '../sdk/index.js';
import { buildSdkEnv } from '../utils/sdk.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { AppError, ErrorCategory, formatError } from '../utils/error-handler.js';
import type { AgentMessage } from '../types/index.js';
import { getRuntimeContext, hasRuntimeContext, type Disposable, type BaseAgentConfig, type AgentProvider } from './types.js';
import { Config } from '../config/index.js';
import { loadRuntimeEnv } from '../config/runtime-env.js';

// Re-export BaseAgentConfig for backward compatibility
export type { BaseAgentConfig } from './types.js';

/**
 * Extra SDK options configuration.
 */
export interface SdkOptionsExtra {
  /** Allowed tools list */
  allowedTools?: string[];
  /** Disallowed tools list */
  disallowedTools?: string[];
  /** MCP servers configuration */
  mcpServers?: Record<string, unknown>;
  /** Custom working directory */
  cwd?: string;
}

/**
 * Result from iterator yield.
 */
export interface IteratorYieldResult {
  /** Parsed message (legacy format for compatibility) */
  parsed: {
    type: string;
    content: string;
    metadata?: Record<string, unknown>;
    sessionId?: string;
  };
  /** SDK Agent message */
  raw: SdkAgentMessage;
}

/**
 * Result from queryStream with streaming input.
 * Includes QueryHandle for lifecycle control (close/cancel).
 */
export interface QueryStreamResult {
  /** The QueryHandle for lifecycle control */
  handle: QueryHandle;
  /** AsyncGenerator yielding parsed messages */
  iterator: AsyncGenerator<IteratorYieldResult>;
}

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
export abstract class BaseAgent implements Disposable {
  // Common properties
  readonly apiKey: string;
  readonly model: string;
  readonly apiBaseUrl?: string;
  readonly permissionMode: 'default' | 'bypassPermissions';
  readonly provider: AgentProvider;

  protected readonly logger: Logger;
  protected initialized = false;
  protected sdkProvider: IAgentSDKProvider;

  constructor(config: BaseAgentConfig) {
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
    this.sdkProvider = getProvider();
  }

  /**
   * Get default provider from runtime context.
   */
  private getDefaultProvider(): AgentProvider {
    if (hasRuntimeContext()) {
      return getRuntimeContext().getAgentConfig().provider;
    }
    // Default to anthropic if no runtime context
    return 'anthropic';
  }

  /**
   * Get the agent name for logging.
   * Must be implemented by subclasses.
   */
  protected abstract getAgentName(): string;

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
  protected createSdkOptions(extra: SdkOptionsExtra = {}): AgentQueryOptions {
    const options: AgentQueryOptions = {
      cwd: extra.cwd ?? this.getWorkspaceDir(),
      permissionMode: this.permissionMode,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      settingSources: ['project'],
    };

    // Add allowed/disallowed tools
    if (extra.allowedTools) {
      options.allowedTools = extra.allowedTools;
    }
    if (extra.disallowedTools) {
      options.disallowedTools = extra.disallowedTools;
    }

    // Add MCP servers (convert to SDK format)
    if (extra.mcpServers) {
      options.mcpServers = extra.mcpServers as Record<string, import('../sdk/index.js').SdkMcpServerConfig>;
    }

    // Set environment: config env + runtime env file (Issue #1361)
    const loggingConfig = this.getLoggingConfig();
    const globalEnv = {
      ...this.getGlobalEnv(),
      ...loadRuntimeEnv(this.getWorkspaceDir()),
    };
    if (this.isAgentTeamsEnabled()) {
      globalEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    }
    options.env = buildSdkEnv(
      this.apiKey,
      this.apiBaseUrl,
      globalEnv,
      loggingConfig.sdkDebug,
      this.getSdkTimeoutMs(),
    );

    // Set model
    if (this.model) {
      options.model = this.model;
    }

    return options;
  }

  /**
   * Get workspace directory from runtime context.
   */
  protected getWorkspaceDir(): string {
    if (hasRuntimeContext()) {
      return getRuntimeContext().getWorkspaceDir();
    }
    return Config.getWorkspaceDir();
  }

  /**
   * Get logging config from runtime context.
   */
  protected getLoggingConfig(): { sdkDebug: boolean } {
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
  protected getGlobalEnv(): Record<string, string> {
    if (hasRuntimeContext()) {
      return getRuntimeContext().getGlobalEnv();
    }
    // Fallback: read directly from config when runtime context is not set
    return Config.getGlobalEnv();
  }

  /**
   * Check if Agent Teams is enabled from runtime context.
   */
  protected isAgentTeamsEnabled(): boolean {
    if (hasRuntimeContext()) {
      return getRuntimeContext().isAgentTeamsEnabled();
    }
    return false;
  }

  /**
   * Get SDK HTTP request timeout from config.
   * @see Issue #2992
   */
  protected getSdkTimeoutMs(): number {
    return Config.getSdkTimeoutMs();
  }

  /**
   * Convert SDK AgentMessage to legacy parsed format for compatibility.
   */
  private convertToLegacyFormat(message: SdkAgentMessage): IteratorYieldResult['parsed'] {
    return {
      type: message.type,
      content: message.content,
      metadata: message.metadata ? {
        toolName: message.metadata.toolName,
        toolInput: message.metadata.toolInput,
        toolInputRaw: message.metadata.toolInput,
        toolOutput: message.metadata.toolOutput,
        elapsed: message.metadata.elapsedMs,
        cost: message.metadata.costUsd,
        tokens: (message.metadata.inputTokens ?? 0) + (message.metadata.outputTokens ?? 0),
      } : undefined,
      sessionId: message.metadata?.sessionId,
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
  protected createQueryStream(
    input: AsyncGenerator<StreamingUserMessage>,
    options: AgentQueryOptions
  ): QueryStreamResult {
    // Convert SDK UserMessage to SDK UserInput
    async function* convertInput(): AsyncGenerator<UserInput> {
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
    async function* wrappedIterator(): AsyncGenerator<IteratorYieldResult> {
      let firstYieldMs: number | undefined;
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
  protected handleIteratorError(error: unknown, operation: string): AgentMessage {
    const agentError = new AppError(
      `${this.getAgentName()} ${operation} failed`,
      ErrorCategory.SDK,
      undefined,
      {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { agent: this.getAgentName() },
        retryable: true,
      }
    );
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
  protected formatMessage(parsed: IteratorYieldResult['parsed']): AgentMessage {
    return {
      content: parsed.content,
      role: 'assistant',
      messageType: parsed.type as AgentMessage['messageType'],
      metadata: parsed.metadata as AgentMessage['metadata'],
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
  dispose(): void {
    if (!this.initialized) {
      return; // Already disposed, idempotent
    }
    this.logger.debug(`${this.getAgentName()} disposed`);
    this.initialized = false;
  }
}
