/**
 * ACP (Agent Communication Protocol) - Provider 接口定义
 *
 * 基于 ACP 协议规范的 Provider 接口，提供标准化的 Agent 通信能力。
 * 相比 IAgentSDKProvider，增加了会话生命周期管理、模式切换等高级功能。
 *
 * @module acp/interface
 */

import type {
  AcpProviderInfo,
  AcpSessionOptions,
  AcpSessionInfo,
  AcpListSessionsOptions,
  AcpListSessionsResult,
  AcpPromptOptions,
  AcpPromptResult,
} from './types.js';
import type {
  AgentMessage,
  AgentQueryOptions,
  InlineToolDefinition,
  McpServerConfig,
  UserInput,
} from '../sdk/types.js';
import type { StreamQueryResult } from '../sdk/types.js';

/**
 * ACP Provider 接口
 *
 * 扩展了基础 Provider 能力，增加 ACP 协议级别的会话管理和通信功能。
 * 所有方法都基于会话 (session) 概念，支持完整生命周期管理。
 *
 * ## 与 IAgentSDKProvider 的关系
 *
 * AcpProvider 在内部可以包装一个 IAgentSDKProvider 实例，
 * 在其基础上增加会话管理和 ACP 协议功能。
 *
 * ## 使用示例
 *
 * ```typescript
 * const provider = getAcpProvider();
 * const info = await provider.initialize();
 *
 * // 创建会话
 * const session = await provider.createSession({ cwd: '/workspace' });
 *
 * // 发送 prompt
 * const result = await provider.prompt(session.sessionId, {
 *   content: 'Hello, world!',
 *   onSessionUpdate: (update) => console.log(update),
 * });
 *
 * // 关闭会话
 * await provider.closeSession(session.sessionId);
 * ```
 */
export interface IAcpProvider {
  // ==========================================================================
  // Provider 信息和能力
  // ==========================================================================

  /** Provider 名称 */
  readonly name: string;

  /** Provider 版本 */
  readonly version: string;

  /** ACP 协议版本 */
  readonly acpVersion: string;

  /** 获取 Provider 信息（含能力声明） */
  getAcpInfo(): AcpProviderInfo;

  // ==========================================================================
  // 初始化和生命周期
  // ==========================================================================

  /**
   * 初始化 Provider
   *
   * 验证配置、检查可用性，返回 Provider 信息和能力声明。
   * 应在使用其他方法之前调用。
   *
   * @returns Provider 信息和能力
   */
  initialize(): Promise<AcpProviderInfo>;

  /**
   * 验证配置
   *
   * 检查 Provider 是否正确配置并可用。
   *
   * @returns 配置是否有效
   */
  validateConfig(): boolean;

  /**
   * 清理资源
   *
   * 释放 Provider 占用的所有资源，包括所有活跃会话。
   */
  dispose(): void;

  // ==========================================================================
  // 会话管理
  // ==========================================================================

  /**
   * 创建新会话
   *
   * 创建独立的会话上下文，每个会话有自己的历史记录和状态。
   *
   * @param options - 会话创建选项
   * @returns 会话信息
   */
  createSession(options?: AcpSessionOptions): Promise<AcpSessionInfo>;

  /**
   * 关闭会话
   *
   * 取消会话中的所有进行中工作，释放关联资源。
   *
   * @param sessionId - 要关闭的会话 ID
   */
  closeSession(sessionId: string): Promise<void>;

  /**
   * 列出所有会话
   *
   * 返回会话列表，支持按工作目录过滤和分页。
   * 需要 `listSessions` 能力。
   *
   * @param options - 列表查询选项
   * @returns 会话列表结果
   */
  listSessions(options?: AcpListSessionsOptions): Promise<AcpListSessionsResult>;

  /**
   * 获取会话信息
   *
   * 获取指定会话的详细信息。
   *
   * @param sessionId - 会话 ID
   * @returns 会话信息
   */
  getSessionInfo(sessionId: string): Promise<AcpSessionInfo>;

  // ==========================================================================
  // Prompt 处理
  // ==========================================================================

  /**
   * 发送 Prompt
   *
   * 在指定会话中处理用户输入。支持通过 onSessionUpdate 回调
   * 接收实时的会话更新通知（内容块、工具调用等）。
   *
   * @param sessionId - 目标会话 ID
   * @param options - Prompt 选项
   * @returns Prompt 结果（包含停止原因和使用统计）
   */
  prompt(sessionId: string, options: AcpPromptOptions): Promise<AcpPromptResult>;

  /**
   * 取消正在进行的 Prompt
   *
   * 取消指定会话中的当前 prompt turn。
   *
   * @param sessionId - 会话 ID
   */
  cancelPrompt(sessionId: string): void;

  // ==========================================================================
  // 兼容 IAgentSDKProvider (用于渐进式迁移)
  // ==========================================================================

  /**
   * 一次性查询（兼容 IAgentSDKProvider）
   *
   * 内部创建临时会话，执行查询后自动关闭。
   * 适用于不需要会话持久化的场景。
   *
   * @param input - 输入内容
   * @param options - 查询选项
   * @returns 消息异步迭代器
   */
  queryOnce(
    input: string | UserInput[],
    options: AgentQueryOptions
  ): AsyncGenerator<AgentMessage>;

  /**
   * 流式查询（兼容 IAgentSDKProvider）
   *
   * 内部创建持久会话，支持多轮对话。
   *
   * @param input - 输入异步生成器
   * @param options - 查询选项
   * @returns 流式查询结果
   */
  queryStream(
    input: AsyncGenerator<UserInput>,
    options: AgentQueryOptions
  ): StreamQueryResult;

  // ==========================================================================
  // 工具和 MCP
  // ==========================================================================

  /**
   * 创建内联工具（兼容 IAgentSDKProvider）
   */
  createInlineTool(definition: InlineToolDefinition): unknown;

  /**
   * 创建 MCP 服务器（兼容 IAgentSDKProvider）
   */
  createMcpServer(config: McpServerConfig): unknown;

  // ==========================================================================
  // 会话级配置
  // ==========================================================================

  /**
   * 设置会话模式
   *
   * 切换会话的操作模式（如 'code', 'ask', 'architect'）。
   * 模式影响系统提示、工具可用性和权限行为。
   *
   * @param sessionId - 会话 ID
   * @param mode - 目标模式
   */
  setSessionMode(sessionId: string, mode: string): Promise<void>;

  /**
   * 设置会话模型
   *
   * 动态切换会话使用的语言模型。
   *
   * @param sessionId - 会话 ID
   * @param model - 模型标识符
   */
  setSessionModel(sessionId: string, model: string): Promise<void>;
}

/**
 * ACP Provider 工厂函数类型
 */
export type AcpProviderFactory = () => IAcpProvider;
