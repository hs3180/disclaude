/**
 * ACP Agent 接口定义
 *
 * 定义了 disclaude 中 ACP Agent 必须实现的接口。
 * 此接口基于 ACP 协议规范（https://agentclientprotocol.com/），
 * 在标准 ACP Agent 接口基础上添加 disclaude 特有的生命周期管理。
 *
 * ## 与 IAgentSDKProvider 的关系
 *
 * `IAcpAgent` 是基于 ACP 协议的新一代 Agent 抽象，
 * 将逐步替代现有的 `IAgentSDKProvider`：
 *
 * - `IAgentSDKProvider`: 面向 SDK 的抽象，关注 API 调用方式
 * - `IAcpAgent`: 面向协议的抽象，关注标准化的 Agent-Client 通信
 *
 * ## 实现要求
 *
 * 所有 ACP Agent 实现必须：
 * 1. 实现标准 ACP Agent 接口的所有必需方法
 * 2. 提供 `getInfo()` 返回 Agent 信息
 * 3. 实现 `dispose()` 释放资源
 *
 * @module acp/interface
 * @see https://agentclientprotocol.com/
 */

import type {
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  ForkSessionRequest,
  ForkSessionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  CloseSessionRequest,
  CloseSessionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  AuthenticateRequest,
  AuthenticateResponse,
  PromptRequest,
  PromptResponse,
  CancelNotification,
} from '@agentclientprotocol/sdk';
import type { AcpAgentInfo } from './types.js';

/**
 * ACP Agent 接口
 *
 * 基于 ACP 协议规范的 Agent 接口定义。
 * 包含所有标准 ACP Agent 方法以及 disclaude 特有的生命周期管理。
 *
 * ## 标准方法
 *
 * 以下方法来自 ACP 协议规范：
 * - `initialize` - 协议初始化和能力协商
 * - `newSession` - 创建新会话
 * - `loadSession` - 加载历史会话
 * - `listSessions` - 列出所有会话
 * - `prompt` - 处理用户输入
 * - `cancel` - 取消正在进行的操作
 * - `authenticate` - 认证
 *
 * ## 不稳定方法
 *
 * 以下方法标记为实验性，可能在未来版本中变更：
 * - `forkSession` - 分叉会话
 * - `resumeSession` - 恢复会话
 * - `closeSession` - 关闭会话
 * - `setSessionMode` - 设置会话模式
 * - `setSessionModel` - 设置会话模型
 * - `setSessionConfigOption` - 设置会话配置选项
 *
 * ## 使用示例
 *
 * ```typescript
 * const agent: IAcpAgent = createAcpAgent('claude-acp');
 *
 * // 1. 初始化
 * const initResult = await agent.initialize({
 *   protocolVersion: '2025-04-08',
 *   clientInfo: { name: 'disclaude', version: '1.0.0' },
 * });
 *
 * // 2. 创建会话
 * const session = await agent.newSession({
 *   sessionId: crypto.randomUUID(),
 * });
 *
 * // 3. 发送提示
 * const result = await agent.prompt({
 *   sessionId: session.sessionId,
 *   messages: [{ role: 'user', content: 'Hello!' }],
 * });
 * ```
 */
export interface IAcpAgent {
  // ==========================================================================
  // Agent 信息（disclaude 扩展）
  // ==========================================================================

  /**
   * 获取 Agent 信息
   *
   * 返回 Agent 的名称、版本和可用性信息。
   * 此方法不依赖 ACP 连接，可在任何时候调用。
   *
   * @returns Agent 信息
   */
  getInfo(): AcpAgentInfo;

  // ==========================================================================
  // 协议初始化（ACP 标准方法）
  // ==========================================================================

  /**
   * 初始化 ACP 连接
   *
   * 协商协议版本、交换能力信息、确定认证方式。
   * 必须在调用其他方法之前调用。
   *
   * @param params - 初始化参数
   * @returns 初始化结果（包含 Agent 能力信息）
   *
   * @see https://agentclientprotocol.com/protocol/initialization
   */
  initialize(params: InitializeRequest): Promise<InitializeResponse>;

  // ==========================================================================
  // 认证（ACP 标准方法）
  // ==========================================================================

  /**
   * 认证客户端
   *
   * 当 Agent 要求认证时，客户端通过此方法提供认证信息。
   * 认证成功后才能创建会话。
   *
   * @param params - 认证请求参数
   * @returns 认证响应
   *
   * @see https://agentclientprotocol.com/protocol/initialization
   */
  authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse | void>;

  // ==========================================================================
  // 会话管理（ACP 标准方法）
  // ==========================================================================

  /**
   * 创建新会话
   *
   * 创建独立的对话上下文，连接 MCP 服务器，
   * 返回唯一的会话 ID。
   *
   * @param params - 新会话参数
   * @returns 新会话结果（包含会话 ID）
   *
   * @see https://agentclientprotocol.com/protocol/session-setup
   */
  newSession(params: NewSessionRequest): Promise<NewSessionResponse>;

  /**
   * 加载历史会话
   *
   * 恢复之前的对话上下文和历史记录。
   * 仅在 Agent 支持 `loadSession` 能用时可用。
   *
   * @param params - 加载会话参数
   * @returns 加载会话结果
   *
   * @see https://agentclientprotocol.com/protocol/session-setup#loading-sessions
   */
  loadSession?(params: LoadSessionRequest): Promise<LoadSessionResponse>;

  /**
   * 列出所有会话
   *
   * 返回会话列表，包含元数据（会话 ID、工作目录、标题等）。
   * 支持按工作目录过滤和游标分页。
   *
   * @param params - 列出会话参数
   * @returns 会话列表
   */
  listSessions?(params: ListSessionsRequest): Promise<ListSessionsResponse>;

  // ==========================================================================
  // Prompt 处理（ACP 标准方法）
  // ==========================================================================

  /**
   * 处理用户提示
   *
   * 处理完整的 Prompt 生命周期：
   * - 接收用户消息（文本、图片等）
   * - 通过语言模型处理
   * - 通过 session/update 通知报告进度
   * - 请求工具执行权限
   * - 执行工具调用
   * - 返回停止原因和使用统计
   *
   * @param params - Prompt 请求参数
   * @returns Prompt 响应（包含停止原因和使用统计）
   *
   * @see https://agentclientprotocol.com/protocol/prompt-turn
   */
  prompt(params: PromptRequest): Promise<PromptResponse>;

  /**
   * 取消正在进行的操作
   *
   * 客户端通过此通知取消当前 Prompt 轮次。
   * Agent 应停止语言模型请求、中止工具调用，
   * 并返回 `StopReason::Cancelled`。
   *
   * @param params - 取消通知参数
   *
   * @see https://agentclientprotocol.com/protocol/prompt-turn#cancellation
   */
  cancel(params: CancelNotification): Promise<void>;

  // ==========================================================================
  // 会话操作（ACP 不稳定方法）
  // ==========================================================================

  /**
   * 分叉会话（不稳定）
   *
   * 基于现有会话创建新的独立会话，
   * 可用于生成摘要等不影响原会话的操作。
   *
   * @experimental 此方法可能在未来版本中变更
   * @param params - 分叉会话参数
   * @returns 分叉会话结果
   */
  unstable_forkSession?(params: ForkSessionRequest): Promise<ForkSessionResponse>;

  /**
   * 恢复会话（不稳定）
   *
   * 恢复现有会话但不返回历史消息，
   * 允许对话继续进行。
   *
   * @experimental 此方法可能在未来版本中变更
   * @param params - 恢复会话参数
   * @returns 恢复会话结果
   */
  unstable_resumeSession?(params: ResumeSessionRequest): Promise<ResumeSessionResponse>;

  /**
   * 关闭会话（不稳定）
   *
   * 关闭活动会话并释放关联资源。
   * 必须取消所有正在进行的操作。
   *
   * @experimental 此方法可能在未来版本中变更
   * @param params - 关闭会话参数
   * @returns 关闭会话结果
   */
  unstable_closeSession?(params: CloseSessionRequest): Promise<CloseSessionResponse>;

  /**
   * 设置会话模式
   *
   * 切换会话的操作模式（如 "ask"、"architect"、"code"），
   * 影响系统提示词、工具可用性和权限行为。
   *
   * @param params - 设置模式参数
   * @returns 设置模式结果
   *
   * @see https://agentclientprotocol.com/protocol/session-modes
   */
  setSessionMode?(params: SetSessionModeRequest): Promise<SetSessionModeResponse | void>;

  /**
   * 设置会话模型（不稳定）
   *
   * 为指定会话选择模型。
   *
   * @experimental 此方法可能在未来版本中变更
   * @param params - 设置模型参数
   * @returns 设置模型结果
   */
  unstable_setSessionModel?(params: SetSessionModelRequest): Promise<SetSessionModelResponse | void>;

  /**
   * 设置会话配置选项
   *
   * 设置指定会话的配置选项。
   * 响应包含所有配置选项及其当前值，
   * 因为更改一个选项可能影响其他选项的可用值。
   *
   * @param params - 设置配置选项参数
   * @returns 配置选项响应
   */
  setSessionConfigOption?(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse>;

  // ==========================================================================
  // 扩展方法（ACP 标准方法）
  // ==========================================================================

  /**
   * 扩展方法
   *
   * 允许客户端发送不属于 ACP 规范的任意请求。
   * 建议使用域名前缀以避免冲突。
   *
   * @param method - 扩展方法名
   * @param params - 扩展方法参数
   * @returns 扩展方法响应
   */
  extMethod?(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;

  /**
   * 扩展通知
   *
   * 允许客户端发送不属于 ACP 规范的任意通知。
   *
   * @param method - 扩展通知方法名
   * @param params - 扩展通知参数
   */
  extNotification?(method: string, params: Record<string, unknown>): Promise<void>;

  // ==========================================================================
  // 生命周期管理（disclaude 扩展）
  // ==========================================================================

  /**
   * 验证配置
   *
   * 检查 Agent 是否正确配置并可用。
   * 不需要 ACP 连接即可调用。
   *
   * @returns 配置是否有效
   */
  validateConfig?(): boolean;

  /**
   * 清理资源
   *
   * 释放 Agent 占用的资源，关闭所有连接和会话。
   * 调用后不应再使用此 Agent 实例。
   */
  dispose(): void;
}

/**
 * ACP Agent 工厂函数类型
 */
export type AcpAgentFactory = () => IAcpAgent;

/**
 * ACP Agent 构造函数类型
 */
export type AcpAgentConstructor = new () => IAcpAgent;
