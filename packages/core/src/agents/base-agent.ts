/**
 * BaseAgent - Abstract base class for all Agent types.
 *
 * Provides common functionality:
 * - ACP Client configuration via dependency injection
 * - SDK options building for backward compatibility
 * - GLM logging
 * - Error handling
 *
 * Uses Template Method pattern - subclasses implement specific logic.
 *
 * Issue #2311: Rewritten to use ACP Client instead of SDK Provider.
 * The ACP Client communicates via JSON-RPC 2.0 over stdio transport,
 * managing sessions and prompts through the Agent Client Protocol.
 *
 * @module agents/base-agent
 */

import {
  AcpClient,
  type AgentMessage as SdkAgentMessage,
  type StreamingUserMessage,
  type AgentQueryOptions,
  type QueryHandle,
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
 *
 * Kept for backward compatibility with subclasses (Pilot, etc.).
 * Internally translated to ACP session parameters.
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
 * Uses ACP Client for query execution (Issue #2311):
 * - queryOnce: Creates ACP session, sends prompt, yields messages, cleans up
 * - createQueryStream: Creates ACP session for conversation, sends prompts per message
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
 *   async *query(input: AgentInput): AsyncIterable<AgentMessage> {
 *     const options = this.createSdkOptions({ allowedTools: ['Read', 'Write'] });
 *     for await (const { parsed } of this.queryOnce(input, options)) {
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
  protected acpClient: AcpClient;

  constructor(config: BaseAgentConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.apiBaseUrl = config.apiBaseUrl;
    this.permissionMode = config.permissionMode ?? 'bypassPermissions';

    // Get provider from config, fallback to runtime context
    this.provider = config.provider ?? this.getDefaultProvider();

    // Create logger with agent name
    this.logger = createLogger(this.getAgentName());

    // Get ACP client: config → runtime context → throw
    if (config.acpClient) {
      this.acpClient = config.acpClient;
    } else if (hasRuntimeContext()) {
      const runtimeClient = getRuntimeContext().getAcpClient?.();
      if (runtimeClient) {
        this.acpClient = runtimeClient;
      } else {
        throw new Error(
          'ACP Client not available. Provide acpClient in config or set getAcpClient() in runtime context.'
        );
      }
    } else {
      throw new Error(
        'ACP Client not available. Provide acpClient in config or set runtime context with getAcpClient().'
      );
    }
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
   * The returned options are internally translated to ACP session
   * parameters in queryOnce() and createQueryStream().
   *
   * @param extra - Extra configuration to merge
   * @returns AgentQueryOptions object
   */
  protected createSdkOptions(extra: SdkOptionsExtra = {}): AgentQueryOptions {
    const options: AgentQueryOptions = {
      cwd: extra.cwd ?? this.getWorkspaceDir(),
      permissionMode: this.permissionMode,
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
      loggingConfig.sdkDebug
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
   * Ensure the ACP client is connected.
   * Connects lazily on first use.
   */
  private async ensureClientConnected(): Promise<void> {
    if (this.acpClient.state === 'connected') {
      return;
    }
    await this.acpClient.connect();
  }

  /**
   * Convert AgentQueryOptions to ACP session creation parameters.
   */
  private toAcpSessionOptions(
    options: AgentQueryOptions,
  ): { mcpServers?: unknown[]; permissionMode?: string } {
    const result: { mcpServers?: unknown[]; permissionMode?: string } = {};

    // Pass MCP servers as array of configs
    if (options.mcpServers) {
      result.mcpServers = Object.values(options.mcpServers);
    }

    // Pass permission mode
    if (options.permissionMode) {
      result.permissionMode = options.permissionMode;
    }

    return result;
  }

  /**
   * Convert ACP AgentMessage to legacy parsed format for compatibility.
   *
   * ACP messages (from message-adapter.ts) are already AgentMessage format,
   * but we convert to the legacy parsed structure for backward compatibility
   * with subclasses.
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
   * Execute a one-shot query using ACP Client.
   *
   * Creates a new ACP session, sends a single prompt, yields messages,
   * and cleans up the session.
   *
   * For task-based agents (Evaluator, Executor) that use
   * static prompts. Input is a string or message array.
   *
   * @param input - Static prompt string or message array
   * @param options - AgentQueryOptions
   * @yields IteratorYieldResult with parsed and raw message
   */
  protected async *queryOnce(
    input: string | unknown[],
    options: AgentQueryOptions
  ): AsyncGenerator<IteratorYieldResult> {
    // Ensure client is connected
    await this.ensureClientConnected();

    // Create ACP session
    const session = await this.acpClient.createSession(
      options.cwd ?? this.getWorkspaceDir(),
      this.toAcpSessionOptions(options),
    );

    // Convert input to ACP prompt format
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    const prompt = [{ type: 'text' as const, text }];

    // Send prompt and yield messages
    for await (const message of this.acpClient.sendPrompt(session.sessionId, prompt)) {
      const parsed = this.convertToLegacyFormat(message);

      // Log message with full details for debugging
      this.logger.debug({
        provider: this.provider,
        messageType: parsed.type,
        contentLength: parsed.content?.length || 0,
        toolName: parsed.metadata?.toolName,
        rawMessage: message,
      }, 'ACP message received');

      yield { parsed, raw: message };
    }
  }

  /**
   * Execute a streaming query using ACP Client.
   *
   * Creates a single ACP session for the conversation lifetime.
   * Each message from the input generator is sent as a separate prompt
   * on the same session, preserving conversation context.
   *
   * For conversational agents (Pilot) that use dynamic input generators.
   *
   * @param input - AsyncGenerator yielding user messages
   * @param options - AgentQueryOptions
   * @returns QueryStreamResult with handle and iterator
   */
  protected createQueryStream(
    input: AsyncGenerator<StreamingUserMessage>,
    options: AgentQueryOptions
  ): QueryStreamResult {
    // Session created lazily when iterator is consumed
    let sessionPromise: Promise<string> | null = null;
    let sessionId: string | undefined;
    let cancelled = false;
    let closed = false;

    const self = this;

    function ensureSession(): Promise<string> {
      if (sessionId) {
        return Promise.resolve(sessionId);
      }

      if (!sessionPromise) {
        sessionPromise = self.ensureClientConnected()
          .then(() => self.acpClient.createSession(
            options.cwd ?? self.getWorkspaceDir(),
            self.toAcpSessionOptions(options),
          ))
          .then((session) => {
            const { sessionId: sid } = session;
            sessionId = sid;
            return sid;
          });
      }

      return sessionPromise;
    }

    async function* wrappedIterator(): AsyncGenerator<IteratorYieldResult> {
      const sid = await ensureSession();

      try {
        for await (const msg of input) {
          if (cancelled || closed) {
            break;
          }

          // Convert StreamingUserMessage to ACP prompt format
          const text = typeof msg.message?.content === 'string'
            ? msg.message.content
            : JSON.stringify(msg.message?.content ?? '');

          const prompt = [{ type: 'text' as const, text }];

          // Send each message as a prompt on the same session
          for await (const acpMessage of self.acpClient.sendPrompt(sid, prompt)) {
            if (cancelled) {
              break;
            }

            const parsed = self.convertToLegacyFormat(acpMessage);

            // Log message with full details for debugging
            self.logger.debug({
              provider: self.provider,
              messageType: parsed.type,
              contentLength: parsed.content?.length || 0,
              toolName: parsed.metadata?.toolName,
              rawMessage: acpMessage,
            }, 'ACP message received');

            yield { parsed, raw: acpMessage };
          }
        }
      } catch (err) {
        // Re-throw to let caller handle
        throw err;
      }
    }

    return {
      handle: {
        close: () => {
          closed = true;
        },
        cancel: () => {
          cancelled = true;
          if (sessionId) {
            self.acpClient.cancelPrompt(sessionId).catch(() => {});
          }
        },
        sessionId,
      },
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
      content: `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
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
