/**
 * ACP SDK Provider
 *
 * Implements IAgentSDKProvider using the Agent Client Protocol (ACP).
 * Connects to ACP-compatible agent subprocesses via JSON-RPC 2.0 over stdio.
 *
 * Architecture:
 * ```
 * IAgentSDKProvider
 * ├── ClaudeSDKProvider  (existing, wraps @anthropic-ai/claude-agent-sdk)
 * └── ACPProvider         (this, wraps @agentclientprotocol/sdk)
 *         │
 *         └── ACPConnection → spawn(agent) → ClientSideConnection
 *                                       ↕ NDJSON over stdio
 *                              ACP-compatible agent (Claude Code, Codex, etc.)
 * ```
 *
 * @module sdk/providers/acp/provider
 */

import type { IAgentSDKProvider } from '../../interface.js';
import type {
  AgentMessage,
  AgentQueryOptions,
  InlineToolDefinition,
  McpServerConfig,
  ProviderInfo,
  StreamQueryResult,
  UserInput,
} from '../../types.js';
import type { ACPProviderConfig } from './types.js';
import { ACPConnection } from './connection.js';
import { userInputToACPPrompt, formatStopReason } from './message-adapter.js';
import { type ACPSessionParams, adaptOptionsToSession, parseACPConfigFromEnv } from './options-adapter.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('ACPProvider');

/** Default ACP agent command */
const DEFAULT_AGENT_COMMAND = 'claude';

/** Default ACP agent arguments */
const DEFAULT_AGENT_ARGS = ['--dangerously-skip-permissions'];

/**
 * ACP SDK Provider
 *
 * Provides agent functionality through the Agent Client Protocol (ACP).
 * Spawns an ACP-compatible agent subprocess and communicates via
 * JSON-RPC 2.0 over stdio (NDJSON transport).
 */
export class ACPProvider implements IAgentSDKProvider {
  readonly name = 'acp';
  readonly version = '0.1.0';

  private connection: ACPConnection | null = null;
  private config: ACPProviderConfig;
  private disposed = false;

  /**
   * Create a new ACP provider.
   *
   * @param config - ACP provider configuration. If not provided,
   *   reads from ACP_PROVIDER_CONFIG environment variable,
   *   or falls back to default (claude --dangerously-skip-permissions).
   */
  constructor(config?: ACPProviderConfig) {
    this.config = config ?? parseACPConfigFromEnv() ?? {
      agent: {
        command: DEFAULT_AGENT_COMMAND,
        args: DEFAULT_AGENT_ARGS,
      },
    };
  }

  getInfo(): ProviderInfo {
    const available = this.validateConfig();
    return {
      name: this.name,
      version: this.version,
      available,
      unavailableReason: available
        ? undefined
        : 'ACP agent command not found or ACP_PROVIDER_CONFIG not set',
    };
  }

  async *queryOnce(
    input: string | UserInput[],
    options: AgentQueryOptions
  ): AsyncGenerator<AgentMessage> {
    if (this.disposed) {
      throw new Error('Provider has been disposed');
    }

    const connection = await this.ensureConnection();
    const sessionParams = adaptOptionsToSession(options);
    const promptContent = userInputToACPPrompt(input);

    logger.info({ sessionParams }, 'Creating ACP session for queryOnce');

    // Create a new session
    const session = await connection.createSession(sessionParams);

    try {
      // Send the prompt and collect streaming updates
      const stopReason = await connection.prompt(
        session.sessionId,
        promptContent,
        session.bridge
      );

      // Yield all buffered messages from the bridge
      let message = await session.bridge.next();
      while (message) {
        yield message;
        message = await session.bridge.next();
      }

      // Yield the final result
      yield {
        type: 'result',
        content: formatStopReason(stopReason),
        role: 'assistant',
        metadata: {
          stopReason,
          sessionId: session.sessionId,
        },
      };
    } finally {
      // Clean up the session
      session.bridge.finish();
      await connection.closeSession(session.sessionId);
    }
  }

  queryStream(
    input: AsyncGenerator<UserInput>,
    options: AgentQueryOptions
  ): StreamQueryResult {
    if (this.disposed) {
      throw new Error('Provider has been disposed');
    }

    const connectionPromise = this.ensureConnection();
    const sessionParams = adaptOptionsToSession(options);

    let cancelled = false;

    // Create the message iterator
    async function* createIterator(
      conn: ACPConnection,
      params: ACPSessionParams
    ): AsyncGenerator<AgentMessage> {
      const session = await conn.createSession(params);

      try {
        const iterator = input[Symbol.asyncIterator]();

        // Process each input message
        while (!cancelled) {
          const { value, done } = await iterator.next();
          if (done) {
            break;
          }

          const promptContent = userInputToACPPrompt([value]);
          logger.info({ sessionId: session.sessionId }, 'Sending prompt via ACP');

          // Start the prompt (non-blocking)
          const promptPromise = conn.prompt(
            session.sessionId,
            promptContent,
            session.bridge
          );

          // Yield streaming updates as they arrive
          while (true) {
            const message = await Promise.race([
              session.bridge.next(),
              // Don't wait forever — the prompt will resolve when done
              promptPromise.then(() => null as AgentMessage | null),
            ]);
            if (message === null) {
              break;
            }
            yield message;
          }

          // Wait for prompt to complete
          const stopReason = await promptPromise;

          // Drain any remaining messages from the bridge
          let remaining = await session.bridge.next();
          while (remaining) {
            yield remaining;
            remaining = await session.bridge.next();
          }

          // Yield result for this turn
          yield {
            type: 'result',
            content: formatStopReason(stopReason),
            role: 'assistant',
            metadata: {
              stopReason,
              sessionId: session.sessionId,
            },
          };

          // Reset bridge for next turn
          session.bridge.reset();
        }
      } finally {
        session.bridge.finish();
        await conn.closeSession(session.sessionId);
      }
    }

    async function* adaptIterator(): AsyncGenerator<AgentMessage> {
      const conn = await connectionPromise;
      yield* createIterator(conn, sessionParams);
    }

    return {
      handle: {
        close: async () => {
          cancelled = true;
          const conn = await connectionPromise.catch(() => null);
          if (conn) {
            conn.dispose();
          }
        },
        cancel: () => {
          cancelled = true;
        },
        sessionId: undefined,
      },
      iterator: adaptIterator(),
    };
  }

  /**
   * Create an inline tool.
   *
   * ACP does not support inline tools — tools are defined by the agent subprocess.
   * Use stdio MCP servers for custom tool integration.
   *
   * @throws Error — inline tools are not supported in ACP mode
   */
  createInlineTool(_definition: InlineToolDefinition): unknown {
    throw new Error(
      'Inline tools are not supported by ACP provider. ' +
      'Use stdio MCP servers for custom tool integration.'
    );
  }

  /**
   * Create an MCP server.
   *
   * For stdio MCP servers, returns the config for ACP session creation.
   * Inline MCP servers are not supported.
   *
   * @param config - MCP server configuration
   * @returns ACP-compatible MCP server config
   * @throws Error for inline MCP servers
   */
  createMcpServer(config: McpServerConfig): unknown {
    if (config.type === 'inline') {
      throw new Error(
        'Inline MCP servers are not supported by ACP provider. ' +
        'Use stdio MCP servers instead.'
      );
    }

    // Return stdio config for ACP session
    return {
      type: 'stdio',
      name: config.name,
      command: config.command,
      args: config.args,
      env: config.env,
    };
  }

  /**
   * Validate that the ACP provider is properly configured.
   *
   * Checks that the agent command is available.
   */
  validateConfig(): boolean {
    // If ACP_PROVIDER_CONFIG is set or config was provided, consider it valid
    if (process.env.ACP_PROVIDER_CONFIG) {
      return true;
    }
    if (this.config.agent.command !== DEFAULT_AGENT_COMMAND) {
      return true;
    }
    // Default: consider valid if we have a command (actual availability
    // checked at connect time)
    return !!this.config.agent.command;
  }

  /**
   * Dispose of the provider and clean up resources.
   *
   * Kills the ACP agent subprocess if active.
   */
  dispose(): void {
    this.disposed = true;
    if (this.connection) {
      this.connection.dispose();
      this.connection = null;
    }
  }

  /**
   * Ensure the ACP connection is established.
   *
   * Lazily connects on first use. The connection is reused
   * across multiple queries for efficiency.
   */
  private async ensureConnection(): Promise<ACPConnection> {
    if (this.connection?.isConnected) {
      return this.connection;
    }

    // Create a new connection
    this.connection = new ACPConnection(this.config);
    await this.connection.connect();

    return this.connection;
  }
}
