/**
 * Claude ACP Provider 实现
 *
 * 通过 ACP (Agent Client Protocol) 协议封装 Claude Agent SDK。
 * 使用 @zed-industries/claude-agent-acp 作为 ACP Agent 实现，
 * 通过 in-process streams 进行双向通信。
 *
 * 同时实现 IAcpAgent 和 IAgentSDKProvider 接口，
 * 提供向后兼容性。
 */

import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  type Client,
  type McpServer,
} from '@agentclientprotocol/sdk';
import { ClaudeAcpAgent } from '@zed-industries/claude-agent-acp';
import type {
  AgentMessage,
  AgentQueryOptions,
  InlineToolDefinition,
  McpServerConfig,
  ProviderInfo,
  StreamQueryResult,
  UserInput,
} from '../sdk/types.js';
import type { IAgentSDKProvider } from '../sdk/interface.js';
import type {
  IAcpAgent,
  AcpInitializeResult,
  AcpNewSessionResult,
  AcpProviderConfig,
  AcpSessionListItem,
} from './interface.js';
import { adaptAcpNotification, adaptStopReason } from './message-adapter.js';
import { createStreamPair, AsyncMessageQueue } from './stream-pair.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ClaudeAcpProvider');

/** ACP Logger interface (matches @zed-industries/claude-agent-acp Logger) */
interface AcpLogger {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Claude ACP Provider
 *
 * 通过 ACP 协议封装 Claude Agent，提供标准化的会话管理
 * 和消息处理能力，同时保持与 IAgentSDKProvider 的兼容性。
 */
export class ClaudeAcpProvider implements IAcpAgent, IAgentSDKProvider {
  readonly name = 'claude-acp';
  readonly version = '1.0.0';

  private clientConnection: ClientSideConnection | null = null;
  private initialized = false;
  private disposed = false;
  private providerConfig: AcpProviderConfig = {};

  /** 活跃的消息队列（sessionId → queue） */
  private messageQueues = new Map<string, AsyncMessageQueue<AgentMessage>>();

  /** 活跃的 session 列表 */
  private sessions = new Map<string, { cwd: string; createdAt: Date }>();

  /** 活跃的 prompt AbortController（用于取消） */
  private activePrompts = new Map<string, AbortController>();

  // ==========================================================================
  // Agent 信息
  // ==========================================================================

  getInfo(): ProviderInfo {
    const available = this.validateConfig();
    return {
      name: this.name,
      version: this.version,
      available,
      unavailableReason: available ? undefined : 'ANTHROPIC_API_KEY not set',
    };
  }

  // ==========================================================================
  // ACP 连接生命周期
  // ==========================================================================

  /**
   * 初始化 ACP 连接
   *
   * 创建 in-process stream pair，建立 Agent 和 Client 之间的双向通信。
   */
  async initialize(config?: AcpProviderConfig): Promise<AcpInitializeResult> {
    if (this.initialized) {
      return this.getInitializeResult();
    }

    if (this.disposed) {
      throw new Error('Provider has been disposed');
    }

    this.providerConfig = config ?? {};

    // 创建 in-process stream pair
    const [agentStream, clientStream] = createStreamPair();

    // 创建 ACP Logger
    const acpLogger: AcpLogger = {
      log: (...args: unknown[]) => logger.debug(args),
      error: (...args: unknown[]) => logger.error(args),
    };

    // 创建 Agent 端连接
    new AgentSideConnection(
      (conn) => new ClaudeAcpAgent(conn, acpLogger),
      agentStream
    );

    // 创建 Client 端连接
    this.clientConnection = new ClientSideConnection(
      (_agent) => this.createClientHandler(),
      clientStream
    );

    // 执行 ACP 初始化握手
    const initResponse = await this.clientConnection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: {
        name: 'disclaude',
        version: this.version,
      },
    });

    this.initialized = true;
    logger.info(
      { protocolVersion: initResponse.protocolVersion },
      'ACP connection initialized'
    );

    return {
      protocolVersion: initResponse.protocolVersion,
      agentInfo: initResponse.agentInfo ? {
        name: initResponse.agentInfo.name,
        version: initResponse.agentInfo.version,
      } : undefined,
      capabilities: initResponse.agentCapabilities as AcpInitializeResult['capabilities'],
    };
  }

  validateConfig(): boolean {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // 关闭所有活跃的 prompt
    for (const [, controller] of this.activePrompts) {
      controller.abort();
    }
    this.activePrompts.clear();

    // 关闭所有消息队列
    for (const queue of this.messageQueues.values()) {
      queue.close();
    }
    this.messageQueues.clear();

    // 清空连接引用
    this.clientConnection = null;
    this.sessions.clear();
    this.initialized = false;
    logger.info('ACP provider disposed');
  }

  // ==========================================================================
  // ACP Session 管理
  // ==========================================================================

  async createSession(
    cwd: string,
    options?: Pick<AgentQueryOptions, 'mcpServers' | 'env'>
  ): Promise<AcpNewSessionResult> {
    await this.ensureInitialized();

    const response = await this.clientConnection!.newSession({
      cwd,
      mcpServers: adaptMcpServers(options?.mcpServers),
    });

    this.sessions.set(response.sessionId, {
      cwd,
      createdAt: new Date(),
    });

    // 创建消息队列用于接收 session updates
    this.messageQueues.set(response.sessionId, new AsyncMessageQueue());

    logger.info({ sessionId: response.sessionId, cwd }, 'ACP session created');
    return {
      sessionId: response.sessionId,
      modes: response.modes,
      configOptions: response.configOptions as AcpNewSessionResult['configOptions'],
    };
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.ensureInitialized();

    // 关闭消息队列
    const queue = this.messageQueues.get(sessionId);
    if (queue) {
      queue.close();
      this.messageQueues.delete(sessionId);
    }

    // 取消活跃的 prompt
    const controller = this.activePrompts.get(sessionId);
    if (controller) {
      controller.abort();
      this.activePrompts.delete(sessionId);
    }

    // 关闭 ACP session
    try {
      await this.clientConnection!.unstable_closeSession({ sessionId });
    } catch (error) {
      logger.warn({ err: error, sessionId }, 'Failed to close ACP session');
    }

    this.sessions.delete(sessionId);
    logger.info({ sessionId }, 'ACP session closed');
  }

  async listSessions(cwd?: string): Promise<AcpSessionListItem[]> {
    await this.ensureInitialized();

    const response = await this.clientConnection!.listSessions({ cwd });
    return (response.sessions ?? []).map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title ?? undefined,
      lastUpdatedAt: s.updatedAt ?? undefined,
    }));
  }

  // ==========================================================================
  // ACP 消息处理
  // ==========================================================================

  async *prompt(
    sessionId: string,
    input: string | UserInput[]
  ): AsyncGenerator<AgentMessage> {
    await this.ensureInitialized();

    const queue = this.messageQueues.get(sessionId);
    if (!queue) {
      throw new Error(`No message queue for session: ${sessionId}`);
    }

    // 创建 AbortController 用于取消
    const abortController = new AbortController();
    this.activePrompts.set(sessionId, abortController);

    // 发送 prompt（异步，不等待完成）
    const promptPromise = this.sendPrompt(sessionId, input, abortController.signal);

    // 从队列中消费消息
    try {
      while (true) {
        const message = await Promise.race([
          queue.next().then((msg) => ({ type: 'message' as const, value: msg })),
          promptPromise.then((result) => ({ type: 'done' as const, value: result })),
        ]);

        if (message.type === 'done') {
          // Yield final result message
          const result = message.value;
          yield {
            type: 'result',
            content: adaptStopReason(result.stopReason),
            role: 'assistant',
            metadata: {
              sessionId,
              stopReason: result.stopReason,
              inputTokens: result.usage?.inputTokens,
              outputTokens: result.usage?.outputTokens,
            },
            raw: result,
          };
          break;
        }

        if (message.value === null) {
          // Queue closed (shouldn't happen normally)
          break;
        }

        yield message.value;
      }
    } finally {
      this.activePrompts.delete(sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    await this.ensureInitialized();

    const controller = this.activePrompts.get(sessionId);
    if (controller) {
      controller.abort();
      this.activePrompts.delete(sessionId);
    }

    await this.clientConnection!.cancel({ sessionId });
    logger.info({ sessionId }, 'ACP prompt cancelled');
  }

  // ==========================================================================
  // 工具和 MCP 服务器
  // ==========================================================================

  createInlineTool(definition: InlineToolDefinition): unknown {
    // ACP 协议下，内联工具通过 MCP 服务器在 session 创建时传递
    // 返回工具配置对象
    return {
      name: definition.name,
      description: definition.description,
      inputSchema: definition.parameters,
    };
  }

  createMcpServer(config: McpServerConfig): unknown {
    if (config.type === 'inline') {
      return {
        name: config.name,
        tools: config.tools?.map((t) => this.createInlineTool(t)),
      };
    }
    // stdio MCP servers - pass through as config
    return {
      name: config.name,
      command: config.command,
      args: config.args ?? [],
      env: config.env ?? {},
    };
  }

  // ==========================================================================
  // 向后兼容：IAgentSDKProvider 方法
  // ==========================================================================

  async *queryOnce(
    input: string | UserInput[],
    options: AgentQueryOptions
  ): AsyncGenerator<AgentMessage> {
    const cwd = options.cwd ?? process.cwd();

    // 创建临时 session
    const session = await this.createSession(cwd, {
      mcpServers: options.mcpServers,
      env: options.env ? Object.fromEntries(
        Object.entries(options.env).filter(([, v]) => v !== undefined) as [string, string][]
      ) : undefined,
    });

    try {
      // 委托给 prompt 方法
      yield* this.prompt(session.sessionId, input);
    } finally {
      // 确保关闭 session
      try {
        await this.closeSession(session.sessionId);
      } catch {
        // Ignore close errors
      }
    }
  }

  queryStream(
    input: AsyncGenerator<UserInput>,
    options: AgentQueryOptions
  ): StreamQueryResult {
    const cwd = options.cwd ?? process.cwd();
    let sessionId: string | undefined;
    let initDone = false;

    const self = this;

    async function* messageIterator(): AsyncGenerator<AgentMessage> {
      // 创建持久 session（仅第一次）
      if (!initDone) {
        initDone = true;
        const session = await self.createSession(cwd, {
          mcpServers: options.mcpServers,
          env: options.env ? Object.fromEntries(
            Object.entries(options.env).filter(([, v]) => v !== undefined) as [string, string][]
          ) : undefined,
        });
        sessionId = session.sessionId;
      }

      if (!sessionId) {
        throw new Error('Failed to create session');
      }

      // 从输入流中读取并逐个发送 prompt
      for await (const userInput of input) {
        if (self.disposed) break;
        yield* self.prompt(sessionId, [userInput]);
      }
    }

    return {
      handle: {
        close: async () => {
          if (sessionId) {
            await self.closeSession(sessionId).catch(() => {});
          }
        },
        cancel: async () => {
          if (sessionId) {
            await self.cancel(sessionId).catch(() => {});
          }
        },
        get sessionId() {
          return sessionId;
        },
      },
      iterator: messageIterator(),
    };
  }

  // ==========================================================================
  // Private 方法
  // ==========================================================================

  /**
   * 确保已初始化
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize(this.providerConfig);
    }
  }

  /**
   * 发送 prompt 到 ACP Agent
   */
  private async sendPrompt(
    sessionId: string,
    input: string | UserInput[],
    signal: AbortSignal
  ): Promise<{ stopReason: string; usage?: { inputTokens: number; outputTokens: number } }> {
    try {
      const response = await this.clientConnection!.prompt({
        sessionId,
        prompt: adaptInputToAcpContent(input),
      });
      return {
        stopReason: response.stopReason,
        usage: response.usage ? {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        } : undefined,
      };
    } catch (error) {
      if (signal.aborted) {
        return { stopReason: 'cancelled' };
      }
      throw error;
    }
  }

  /**
   * 创建 ACP Client handler
   *
   * 实现 Client 接口，处理来自 Agent 的请求和通知。
   */
  private createClientHandler(): Client {
    const self = this;

    return {
      /**
       * 处理 session update 通知
       * 将 ACP 通知转换为 AgentMessage 并推送到消息队列
       */
      async sessionUpdate(params): Promise<void> {
        const message = adaptAcpNotification(params);
        if (message) {
          const queue = self.messageQueues.get(params.sessionId);
          if (queue) {
            queue.push(message);
          }
        }
      },

      /**
       * 处理权限请求
       * 根据 autoApprovePermissions 配置决定是否自动批准
       */
      async requestPermission(_params) {
        // ACP RequestPermissionOutcome: { outcome: "cancelled" } | { outcome: "selected", selected: number }
        // Default: cancel all permission requests (bypass mode is handled at SDK level)
        return { outcome: { outcome: 'cancelled' } };
      },
    };
  }

  /**
   * 获取初始化结果
   */
  private getInitializeResult(): AcpInitializeResult {
    return {
      protocolVersion: PROTOCOL_VERSION,
    };
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 将 MCP 服务器配置适配为 ACP McpServer 格式
 */
function adaptMcpServers(
  mcpServers?: Record<string, McpServerConfig>
): McpServer[] {
  if (!mcpServers) return [];

  return Object.entries(mcpServers).map(([name, config]) => {
    if (config.type === 'stdio') {
      return {
        type: 'stdio' as const,
        name,
        command: config.command,
        args: config.args ?? [],
        env: Object.entries(config.env ?? {}).map(([key, value]) => ({
          name: key,
          value,
        })),
      };
    }
    // For non-stdio types, return a minimal stdio server
    return {
      type: 'stdio' as const,
      name,
      command: '',
      args: [],
      env: [],
    };
  });
}

/**
 * 将用户输入适配为 ACP ContentBlock 格式
 */
function adaptInputToAcpContent(
  input: string | UserInput[]
): Array<{ type: 'text'; text: string }> {
  if (typeof input === 'string') {
    return [{ type: 'text' as const, text: input }];
  }

  return input.map((msg) => {
    const text = typeof msg.content === 'string'
      ? msg.content
      : msg.content.map((block) => {
          if (block.type === 'text') return block.text;
          if (block.type === 'image') return '[image]';
          return JSON.stringify(block);
        }).join('\n');

    return { type: 'text' as const, text };
  });
}
