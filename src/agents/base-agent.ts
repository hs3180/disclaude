/**
 * BaseAgent - Abstract base class for all Agent types.
 *
 * Provides common functionality:
 * - SDK configuration building
 * - GLM logging
 * - Error handling
 *
 * Uses Template Method pattern - subclasses implement specific logic.
 *
 * @module agents/base-agent
 */

import { query, type SDKMessage, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { parseSDKMessage, buildSdkEnv } from '../utils/sdk.js';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { AgentExecutionError, formatError } from '../utils/errors.js';
import type { AgentMessage, AgentInput } from '../types/agent.js';

/**
 * Base configuration for all agents.
 */
export interface BaseAgentConfig {
  /** API key for authentication */
  apiKey: string;
  /** Model identifier */
  model: string;
  /** Optional API base URL (e.g., for GLM) */
  apiBaseUrl?: string;
  /** Permission mode for tool execution */
  permissionMode?: 'default' | 'bypassPermissions';
}

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
  /** Parsed SDK message */
  parsed: ReturnType<typeof parseSDKMessage>;
  /** Raw SDK message */
  raw: SDKMessage;
}

/**
 * Result from queryStream with streaming input.
 * Includes Query instance for lifecycle control (close/cancel).
 */
export interface QueryStreamResult {
  /** The Query instance for lifecycle control */
  query: Query;
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
export abstract class BaseAgent {
  // Common properties
  readonly apiKey: string;
  readonly model: string;
  readonly apiBaseUrl?: string;
  readonly permissionMode: 'default' | 'bypassPermissions';
  readonly provider: 'anthropic' | 'glm';

  protected readonly logger: ReturnType<typeof createLogger>;
  protected initialized = false;

  constructor(config: BaseAgentConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.apiBaseUrl = config.apiBaseUrl;
    this.permissionMode = config.permissionMode ?? 'bypassPermissions';

    // Detect provider from Config
    const agentConfig = Config.getAgentConfig();
    this.provider = agentConfig.provider;

    // Create logger with agent name
    this.logger = createLogger(this.getAgentName());
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
   * @returns SDK options object
   */
  protected createSdkOptions(extra: SdkOptionsExtra = {}): Record<string, unknown> {
    const sdkOptions: Record<string, unknown> = {
      cwd: extra.cwd ?? Config.getWorkspaceDir(),
      permissionMode: this.permissionMode,
      settingSources: ['project'],
    };

    // Add allowed/disallowed tools
    if (extra.allowedTools) {
      sdkOptions.allowedTools = extra.allowedTools;
    }
    if (extra.disallowedTools) {
      sdkOptions.disallowedTools = extra.disallowedTools;
    }

    // Add MCP servers
    if (extra.mcpServers) {
      sdkOptions.mcpServers = extra.mcpServers;
    }

    // Set environment
    sdkOptions.env = buildSdkEnv(this.apiKey, this.apiBaseUrl, Config.getGlobalEnv());

    // Set model
    if (this.model) {
      sdkOptions.model = this.model;
    }

    return sdkOptions;
  }

  /**
   * Execute a one-shot query.
   *
   * For task-based agents (Evaluator, Executor, Reporter) that use
   * static prompts. Input is a string or message array.
   *
   * This method wraps the SDK query iterator with:
   * - Automatic debug logging
   * - Parsed message output
   *
   * @param input - Static prompt string or message array
   * @param sdkOptions - SDK options
   * @yields IteratorYieldResult with parsed and raw message
   */
  protected async *queryOnce(
    input: AgentInput,
    sdkOptions: Record<string, unknown>
  ): AsyncGenerator<IteratorYieldResult> {
    const queryResult = query({
      prompt: input,
      options: sdkOptions as Parameters<typeof query>[0]['options'],
    });
    const iterator = queryResult[Symbol.asyncIterator]();

    while (true) {
      const result = await iterator.next();

      if (result.done) {
        break;
      }

      const message = result.value;
      const parsed = parseSDKMessage(message);

      // Log SDK message with full details for debugging
      this.logger.debug({
        provider: this.provider,
        messageType: parsed.type,
        contentLength: parsed.content?.length || 0,
        toolName: parsed.metadata?.toolName,
        rawMessage: message,
      }, 'SDK message received');

      yield { parsed, raw: message };
    }
  }

  /**
   * Execute a streaming query.
   *
   * For conversational agents (Pilot) that use dynamic input generators.
   * Input is an AsyncGenerator that yields user messages on demand.
   *
   * This method creates a query and returns both the Query instance
   * (for lifecycle control) and an AsyncGenerator for iterating messages.
   *
   * Features:
   * - Automatic debug logging
   * - Parsed message output
   * - Query instance for close/cancel operations
   *
   * @param input - AsyncGenerator yielding user messages
   * @param sdkOptions - SDK options
   * @returns QueryStreamResult with query instance and iterator
   */
  protected createQueryStream(
    input: AsyncGenerator<SDKUserMessage>,
    sdkOptions: Record<string, unknown>
  ): QueryStreamResult {
    const queryResult = query({
      prompt: input,
      options: sdkOptions as Parameters<typeof query>[0]['options'],
    });

    const self = this;
    const iterator = queryResult[Symbol.asyncIterator]();

    async function* wrappedIterator(): AsyncGenerator<IteratorYieldResult> {
      while (true) {
        const result = await iterator.next();

        if (result.done) {
          break;
        }

        const message = result.value;
        const parsed = parseSDKMessage(message);

        // Log SDK message with full details for debugging
        self.logger.debug({
          provider: self.provider,
          messageType: parsed.type,
          contentLength: parsed.content?.length || 0,
          toolName: parsed.metadata?.toolName,
          rawMessage: message,
        }, 'SDK message received');

        yield { parsed, raw: message };
      }
    }

    return {
      query: queryResult,
      iterator: wrappedIterator(),
    };
  }

  /**
   * Handle iterator error with proper logging and error wrapping.
   *
   * Creates AgentExecutionError and returns an AgentMessage for yielding to caller.
   *
   * @param error - The caught error
   * @param operation - Operation name for error message
   * @returns AgentMessage for yielding to caller
   */
  protected handleIteratorError(error: unknown, operation: string): AgentMessage {
    const agentError = new AgentExecutionError(`${this.getAgentName()} ${operation} failed`, {
      cause: error instanceof Error ? error : new Error(String(error)),
      agent: this.getAgentName(),
      recoverable: true,
    });
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
  protected formatMessage(parsed: ReturnType<typeof parseSDKMessage>): AgentMessage {
    return {
      content: parsed.content,
      role: 'assistant',
      messageType: parsed.type,
      metadata: parsed.metadata,
    };
  }

  /**
   * Cleanup resources.
   *
   * Subclasses should call super.cleanup() if overriding.
   */
  cleanup(): void {
    this.logger.debug(`${this.getAgentName()} cleaned up`);
    this.initialized = false;
  }
}
