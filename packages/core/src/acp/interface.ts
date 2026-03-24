/**
 * ACP Agent 接口定义
 *
 * 基于 ACP (Agent Client Protocol) 规范定义统一的 Agent 接口。
 * 所有 ACP Agent 实现（Claude、OpenAI 等）都需要实现此接口。
 *
 * 参考: https://agentclientprotocol.com/protocol/overview
 */

import type {
  AgentMessage,
  AgentQueryOptions,
  InlineToolDefinition,
  McpServerConfig,
  ProviderInfo,
  StreamQueryResult,
  UserInput,
} from '../sdk/types.js';

import type {
  AcpInitializeResult,
  AcpNewSessionResult,
  AcpProviderConfig,
  AcpSessionListItem,
} from './types.js';

export type {
  AcpInitializeResult,
  AcpNewSessionResult,
  AcpProviderConfig,
  AcpSessionListItem,
} from './types.js';

// ============================================================================
// IAcpAgent - ACP Agent 核心接口
// ============================================================================

/**
 * ACP Agent 接口
 *
 * 基于 ACP 协议规范定义的统一 Agent 接口，
 * 提供标准化的会话生命周期管理和消息处理能力。
 */
export interface IAcpAgent {
  // ==========================================================================
  // Agent 信息
  // ==========================================================================

  /** Agent 名称（如 'claude-acp', 'openai-acp'） */
  readonly name: string;

  /** Agent 版本 */
  readonly version: string;

  /** 获取 Agent 信息 */
  getInfo(): ProviderInfo;

  // ==========================================================================
  // ACP 连接生命周期
  // ==========================================================================

  /**
   * 初始化 ACP 连接
   *
   * 建立 ACP 连接并协商协议版本和能力。
   * 必须在创建 session 之前调用。
   */
  initialize(config?: AcpProviderConfig): Promise<AcpInitializeResult>;

  /**
   * 验证配置
   *
   * 检查 Agent 是否正确配置并可用。
   */
  validateConfig(): boolean;

  /**
   * 清理资源
   *
   * 关闭 ACP 连接，释放所有资源。
   */
  dispose(): void;

  // ==========================================================================
  // ACP Session 管理
  // ==========================================================================

  /**
   * 创建新的 ACP 会话
   *
   * @param cwd - 工作目录（绝对路径）
   * @param options - 查询选项（包含 MCP 服务器配置等）
   * @returns 会话信息（包含 sessionId）
   */
  createSession(
    cwd: string,
    options?: Pick<AgentQueryOptions, 'mcpServers' | 'env'>
  ): Promise<AcpNewSessionResult>;

  /**
   * 关闭 ACP 会话
   *
   * @param sessionId - 会话 ID
   */
  closeSession(sessionId: string): Promise<void>;

  /**
   * 列出所有 ACP 会话
   */
  listSessions(cwd?: string): Promise<AcpSessionListItem[]>;

  // ==========================================================================
  // ACP 消息处理
  // ==========================================================================

  /**
   * 发送 prompt 并获取消息流
   *
   * 等价于 ACP 协议的 `session/prompt`。
   * Agent 在处理过程中会通过 session/update 通知发送实时更新。
   *
   * @param sessionId - 会话 ID
   * @param input - 用户输入
   * @returns 消息异步迭代器
   */
  prompt(
    sessionId: string,
    input: string | UserInput[]
  ): AsyncGenerator<AgentMessage>;

  /**
   * 取消当前 prompt 处理
   *
   * @param sessionId - 会话 ID
   */
  cancel(sessionId: string): Promise<void>;

  // ==========================================================================
  // 工具和 MCP 服务器
  // ==========================================================================

  /**
   * 创建内联 MCP 工具
   *
   * @param definition - 工具定义
   * @returns 工具配置对象（用于 MCP 服务器）
   */
  createInlineTool(definition: InlineToolDefinition): unknown;

  /**
   * 创建 MCP 服务器
   *
   * @param config - MCP 服务器配置
   * @returns MCP 服务器对象
   */
  createMcpServer(config: McpServerConfig): unknown;

  // ==========================================================================
  // 向后兼容：IAgentSDKProvider 方法
  // ==========================================================================

  /**
   * 一次性查询（静态输入）
   *
   * 向后兼容方法：创建临时会话 → 发送 prompt → 关闭会话。
   * 用于任务型 Agent（Evaluator、Executor 等）。
   */
  queryOnce(
    input: string | UserInput[],
    options: AgentQueryOptions
  ): AsyncGenerator<AgentMessage>;

  /**
   * 流式查询（动态输入）
   *
   * 向后兼容方法：创建持久会话 → 多次 prompt。
   * 用于对话型 Agent（Pilot）。
   */
  queryStream(
    input: AsyncGenerator<UserInput>,
    options: AgentQueryOptions
  ): StreamQueryResult;
}
