/**
 * Claude ACP Provider 实现
 *
 * 实现 IAcpProvider 接口，包装 ClaudeSDKProvider 并增加 ACP 协议级别的
 * 会话管理功能。保持与现有 IAgentSDKProvider 的兼容性。
 *
 * ## 架构
 *
 * ```
 * IAcpProvider (ACP 协议接口)
 *     │
 *     └── ClaudeAcpProvider
 *             │
 *             ├── AcpSessionStore (会话存储)
 *             ├── ClaudeSDKProvider (底层 SDK 调用)
 *             └── message-adapter (消息转换)
 * ```
 *
 * @module acp/providers/claude/acp-provider
 */

import type { IAcpProvider } from '../../interface.js';
import type {
  AcpProviderInfo,
  AcpSessionOptions,
  AcpSessionInfo,
  AcpListSessionsOptions,
  AcpListSessionsResult,
  AcpPromptOptions,
  AcpPromptResult,
  AcpStopReason,
  AcpUsageStats,
} from '../../types.js';
import type {
  AgentMessage,
  AgentQueryOptions,
  InlineToolDefinition,
  McpServerConfig,
  StreamQueryResult,
  UserInput,
} from '../../../sdk/types.js';
import { ClaudeSDKProvider } from '../../../sdk/providers/index.js';
import { AcpSessionStore } from '../../session-store.js';
import { agentMessageToAcpUpdate } from '../../message-adapter.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('ClaudeAcpProvider');

/** ACP 协议版本 */
const ACP_PROTOCOL_VERSION = '2025-04-01';

/**
 * Claude ACP Provider
 *
 * 将 ClaudeSDKProvider 包装为 ACP 协议接口，增加会话管理功能。
 */
export class ClaudeAcpProvider implements IAcpProvider {
  readonly name = 'claude-acp';
  readonly version = '0.1.0';
  readonly acpVersion = ACP_PROTOCOL_VERSION;

  /** 底层 SDK Provider */
  private readonly sdkProvider: ClaudeSDKProvider;

  /** 会话存储 */
  private readonly sessionStore: AcpSessionStore;

  /** 活跃的 prompt 取消控制器 */
  private readonly abortControllers = new Map<string, AbortController>();

  /** 是否已销毁 */
  private disposed = false;

  constructor() {
    this.sdkProvider = new ClaudeSDKProvider();
    this.sessionStore = new AcpSessionStore();
  }

  // ==========================================================================
  // Provider 信息
  // ==========================================================================

  getAcpInfo(): AcpProviderInfo {
    return this.buildProviderInfo();
  }

  // ==========================================================================
  // 初始化
  // ==========================================================================

  async initialize(): Promise<AcpProviderInfo> {
    if (this.disposed) {
      throw new Error('Provider has been disposed');
    }

    const info = this.buildProviderInfo();

    logger.info(
      { name: info.name, version: info.version, acpVersion: info.acpVersion },
      'ACP Provider initialized'
    );

    return info;
  }

  validateConfig(): boolean {
    return this.sdkProvider.validateConfig();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    // 取消所有活跃 prompt
    for (const [sessionId, controller] of this.abortControllers) {
      controller.abort();
      logger.debug({ sessionId }, 'Cancelled active prompt during dispose');
    }
    this.abortControllers.clear();

    // 销毁会话存储
    this.sessionStore.clear();

    // 销毁底层 SDK Provider
    this.sdkProvider.dispose();

    this.disposed = true;
  }

  // ==========================================================================
  // 会话管理
  // ==========================================================================

  async createSession(options?: AcpSessionOptions): Promise<AcpSessionInfo> {
    this.ensureReady();

    const session = this.sessionStore.create(options);
    logger.info({ sessionId: session.sessionId, cwd: options?.cwd }, 'Session created');
    return session;
  }

  async closeSession(sessionId: string): Promise<void> {
    this.ensureReady();

    // 取消活跃 prompt
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }

    this.sessionStore.delete(sessionId);
    logger.info({ sessionId }, 'Session closed');
  }

  async listSessions(options?: AcpListSessionsOptions): Promise<AcpListSessionsResult> {
    this.ensureReady();
    return this.sessionStore.list(options);
  }

  async getSessionInfo(sessionId: string): Promise<AcpSessionInfo> {
    this.ensureReady();
    return this.sessionStore.get(sessionId);
  }

  // ==========================================================================
  // Prompt 处理
  // ==========================================================================

  async prompt(sessionId: string, options: AcpPromptOptions): Promise<AcpPromptResult> {
    this.ensureReady();

    if (!this.sessionStore.has(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // 创建取消控制器
    const abortController = new AbortController();
    this.abortControllers.set(sessionId, abortController);

    // 更新会话状态
    this.sessionStore.updateState(sessionId, 'running');

    try {
      // 将 AcpPromptOptions 转换为 AgentQueryOptions
      const queryOptions = this.toQueryOptions(sessionId);

      // 执行查询
      let stopReason: AcpStopReason = 'end_turn';
      let usage: AcpUsageStats | undefined;
      let hasError = false;

      const iterator = this.sdkProvider.queryOnce(options.content, queryOptions);

      for await (const message of iterator) {
        // 检查是否被取消
        if (abortController.signal.aborted) {
          stopReason = 'cancelled';
          break;
        }

        // 将 AgentMessage 转换为 ACP update 并通过回调发送
        const update = agentMessageToAcpUpdate(message, sessionId);
        if (update && options.onSessionUpdate) {
          options.onSessionUpdate(update);
        }

        // 提取结果信息
        if (message.type === 'result') {
          usage = this.extractUsage(message);
          if (message.content.includes('❌')) {
            hasError = true;
            stopReason = 'error';
          }
        } else if (message.type === 'error') {
          hasError = true;
          stopReason = 'error';
        }
      }

      if (abortController.signal.aborted) {
        stopReason = 'cancelled';
      }

      // 更新会话状态
      this.sessionStore.updateState(
        sessionId,
        stopReason === 'cancelled' ? 'cancelled' : 'completed'
      );

      return {
        stopReason,
        sessionId,
        usage,
        error: hasError ? 'Prompt execution failed' : undefined,
      };
    } catch (error) {
      // 更新会话状态
      this.sessionStore.updateState(sessionId, 'error');

      if (abortController.signal.aborted) {
        return {
          stopReason: 'cancelled',
          sessionId,
        };
      }

      throw error;
    } finally {
      this.abortControllers.delete(sessionId);
    }
  }

  cancelPrompt(sessionId: string): void {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      logger.info({ sessionId }, 'Prompt cancelled');
    }
  }

  // ==========================================================================
  // 兼容 IAgentSDKProvider
  // ==========================================================================

  async *queryOnce(
    input: string | UserInput[],
    options: AgentQueryOptions
  ): AsyncGenerator<AgentMessage> {
    this.ensureReady();

    // 直接委托给底层 SDK Provider
    yield* this.sdkProvider.queryOnce(input, options);
  }

  queryStream(
    input: AsyncGenerator<UserInput>,
    options: AgentQueryOptions
  ): StreamQueryResult {
    this.ensureReady();

    // 直接委托给底层 SDK Provider
    return this.sdkProvider.queryStream(input, options);
  }

  createInlineTool(definition: InlineToolDefinition): unknown {
    return this.sdkProvider.createInlineTool(definition);
  }

  createMcpServer(config: McpServerConfig): unknown {
    return this.sdkProvider.createMcpServer(config);
  }

  // ==========================================================================
  // 会话级配置
  // ==========================================================================

  async setSessionMode(sessionId: string, mode: string): Promise<void> {
    this.ensureReady();
    this.sessionStore.updateMode(sessionId, mode);
    logger.info({ sessionId, mode }, 'Session mode updated');
  }

  async setSessionModel(sessionId: string, model: string): Promise<void> {
    this.ensureReady();
    // 确保会话存在
    this.sessionStore.get(sessionId);
    // Note: The model will be applied during prompt execution via toQueryOptions
    logger.info({ sessionId, model }, 'Session model updated');
  }

  // ==========================================================================
  // 私有方法
  // ==========================================================================

  /**
   * 确保 Provider 已就绪
   */
  private ensureReady(): void {
    if (this.disposed) {
      throw new Error('Provider has been disposed');
    }
  }

  /**
   * 构建 Provider 信息
   */
  private buildProviderInfo(): AcpProviderInfo {
    const available = this.sdkProvider.validateConfig();

    return {
      name: this.name,
      version: this.version,
      acpVersion: this.acpVersion,
      available,
      unavailableReason: available ? undefined : 'ANTHROPIC_API_KEY not set',
      capabilities: {
        listSessions: true,
        closeSession: true,
        availableModes: ['code', 'ask'],
      },
    };
  }

  /**
   * 将会话选项转换为 AgentQueryOptions
   */
  private toQueryOptions(sessionId: string): AgentQueryOptions {
    const sessionOptions = this.sessionStore.has(sessionId)
      ? this.sessionStore.getOptions(sessionId)
      : {};

    const options: AgentQueryOptions = {
      cwd: sessionOptions.cwd,
      model: sessionOptions.model,
      permissionMode: sessionOptions.permissionMode,
      settingSources: sessionOptions.settingSources ?? ['project'],
      env: sessionOptions.env,
    };

    if (sessionOptions.mcpServers) {
      options.mcpServers = sessionOptions.mcpServers as Record<string, McpServerConfig>;
    }

    return options;
  }

  /**
   * 从 AgentMessage 中提取使用统计
   */
  private extractUsage(message: AgentMessage): AcpUsageStats | undefined {
    const meta = message.metadata;
    if (!meta) return undefined;

    return {
      inputTokens: meta.inputTokens ?? 0,
      outputTokens: meta.outputTokens ?? 0,
      totalTokens: (meta.inputTokens ?? 0) + (meta.outputTokens ?? 0),
      costUsd: meta.costUsd ?? 0,
    };
  }
}
