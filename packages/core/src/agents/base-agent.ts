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
 * Issue #2345 Phase 2: Extracted query logic to base-agent-query.ts,
 * ACP utilities to base-agent-acp.ts.
 *
 * @module agents/base-agent
 */

import {
  type StreamingUserMessage,
  type AgentQueryOptions,
} from '../sdk/index.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { getRuntimeContext, hasRuntimeContext, type Disposable, type BaseAgentConfig, type AgentProvider } from './types.js';
import { Config } from '../config/index.js';

// Extracted modules (Issue #2345 Phase 2)
import {
  type SdkOptionsExtra,
  type SdkBuildContext,
  buildSdkOptions,
} from './base-agent-acp.js';
import {
  type IteratorYieldResult,
  type QueryStreamResult,
  type QueryContext,
  executeQueryOnce,
  createStreamQuery,
  formatMessage as formatMessageUtil,
  handleIteratorError as handleIteratorErrorUtil,
} from './base-agent-query.js';

// Re-export types for backward compatibility
export type { BaseAgentConfig } from './types.js';
export type { SdkOptionsExtra } from './base-agent-acp.js';
export type { IteratorYieldResult, QueryStreamResult } from './base-agent-query.js';

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
  protected acpClient: import('../sdk/acp/acp-client.js').AcpClient;

  /** Cached connection promise to prevent concurrent connect() calls */
  private connectionPromise: Promise<void> | null = null;

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
   * Falls back to Config.getGlobalEnv() when runtime context is not set.
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
   * Connects lazily on first use with concurrency protection.
   */
  private async ensureClientConnected(): Promise<void> {
    if (this.acpClient.state === 'connected') {
      return;
    }
    if (!this.connectionPromise) {
      this.connectionPromise = this.acpClient.connect()
        .then(() => { this.connectionPromise = null; })
        .catch((err) => { this.connectionPromise = null; throw err; });
    }
    await this.connectionPromise;
  }

  /**
   * Build query context for passing agent dependencies to extracted functions.
   */
  private getQueryContext(): QueryContext {
    return {
      acpClient: this.acpClient,
      logger: this.logger,
      provider: this.provider,
      ensureClientConnected: () => this.ensureClientConnected(),
      getWorkspaceDir: () => this.getWorkspaceDir(),
    };
  }

  /**
   * Create SDK options for agent execution.
   *
   * Delegates to buildSdkOptions() from base-agent-acp.ts.
   *
   * @param extra - Extra configuration to merge
   * @returns AgentQueryOptions object
   */
  protected createSdkOptions(extra: SdkOptionsExtra = {}): AgentQueryOptions {
    const ctx: SdkBuildContext = {
      workspaceDir: this.getWorkspaceDir(),
      permissionMode: this.permissionMode,
      loggingConfig: this.getLoggingConfig(),
      globalEnv: this.getGlobalEnv(),
      agentTeamsEnabled: this.isAgentTeamsEnabled(),
      apiKey: this.apiKey,
      apiBaseUrl: this.apiBaseUrl,
      model: this.model,
    };
    return buildSdkOptions(ctx, extra);
  }

  /**
   * Execute a one-shot query using ACP Client.
   * Delegates to executeQueryOnce() from base-agent-query.ts.
   */
  protected async *queryOnce(
    input: string | unknown[],
    options: AgentQueryOptions,
  ): AsyncGenerator<IteratorYieldResult> {
    yield* executeQueryOnce(this.getQueryContext(), input, options);
  }

  /**
   * Execute a streaming query using ACP Client.
   * Delegates to createStreamQuery() from base-agent-query.ts.
   */
  protected createQueryStream(
    input: AsyncGenerator<StreamingUserMessage>,
    options: AgentQueryOptions,
  ): QueryStreamResult {
    return createStreamQuery(this.getQueryContext(), input, options);
  }

  /**
   * Format parsed message as AgentMessage.
   * Delegates to formatMessage() from base-agent-query.ts.
   */
  protected formatMessage(parsed: IteratorYieldResult['parsed']): import('../types/index.js').AgentMessage {
    return formatMessageUtil(parsed);
  }

  /**
   * Handle iterator error with proper logging and error wrapping.
   * Delegates to handleIteratorError() from base-agent-query.ts.
   */
  protected handleIteratorError(error: unknown, operation: string): import('../types/index.js').AgentMessage {
    return handleIteratorErrorUtil(this.getAgentName(), this.logger, error, operation);
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
