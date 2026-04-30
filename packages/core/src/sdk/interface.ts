/**
 * Agent SDK 抽象层 - Provider 接口定义
 *
 * 定义了所有 Agent SDK Provider 必须实现的接口，
 * 使上层业务代码与具体的 SDK 实现解耦。
 */

import type {
  AgentQueryOptions,
  InlineToolDefinition,
  McpServerConfig,
  ProviderInfo,
  StreamQueryResult,
  UserInput,
} from './types.js';

/**
 * Agent SDK Provider 接口
 *
 * 所有 Agent SDK 实现（Claude、OpenAI、GLM 等）都需要实现此接口。
 */
export interface IAgentSDKProvider {
  // ==========================================================================
  // Provider 信息
  // ==========================================================================

  /** Provider 名称（如 'claude', 'openai', 'glm'） */
  readonly name: string;

  /** Provider 版本 */
  readonly version: string;

  /** 获取 Provider 信息 */
  getInfo(): ProviderInfo;

  // ==========================================================================
  // 查询方法
  // ==========================================================================

  /**
   * 流式查询（统一入口）
   *
   * 所有查询（包括一次性任务和持续对话）都通过此方法进行。
   * 静态输入可通过包装为只 yield 一次的 AsyncGenerator 实现：
   * ```typescript
   * async function* singleInput(text: string): AsyncGenerator<UserInput> {
   *   yield { role: 'user', content: text };
   * }
   * provider.queryStream(singleInput('Hello'), options);
   * ```
   *
   * Issue #3108: 移除了 queryOnce 双路径，统一为流式查询。
   *
   * @param input - 输入异步生成器
   * @param options - 查询选项
   * @returns 流式查询结果（包含句柄和迭代器）
   */
  queryStream(
    input: AsyncGenerator<UserInput>,
    options: AgentQueryOptions
  ): StreamQueryResult;

  // ==========================================================================
  // 工具和 MCP 服务器
  // ==========================================================================

  /**
   * 创建内联 MCP 工具
   *
   * 将工具定义转换为 SDK 特定的工具格式。
   *
   * @param definition - 工具定义
   * @returns SDK 特定的工具对象
   */
  createInlineTool(definition: InlineToolDefinition): unknown;

  /**
   * 创建 MCP 服务器
   *
   * 根据 MCP 服务器配置创建 SDK 特定的 MCP 服务器实例。
   *
   * @param config - MCP 服务器配置
   * @returns SDK 特定的 MCP 服务器对象
   */
  createMcpServer(config: McpServerConfig): unknown;

  // ==========================================================================
  // 生命周期
  // ==========================================================================

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
   * 释放 Provider 占用的资源。
   */
  dispose(): void;
}

/**
 * Provider 工厂函数类型
 */
export type ProviderFactory = () => IAgentSDKProvider;

/**
 * Provider 构造函数类型
 */
export type ProviderConstructor = new () => IAgentSDKProvider;
