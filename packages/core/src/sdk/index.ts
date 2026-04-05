/**
 * Agent SDK 抽象层
 *
 * 提供与具体 Agent SDK（Claude、OpenAI、GLM 等）无关的统一接口。
 * 上层业务代码通过此模块访问 Agent SDK 功能，
 * 无需关心底层使用的是哪个 SDK。
 *
 * ## 目录结构
 *
 * ```
 * packages/core/src/sdk/
 * ├── index.ts                 # 本文件 - 公开导出
 * ├── types.ts                 # 统一类型定义
 * ├── interface.ts             # IAgentSDKProvider 接口
 * ├── factory.ts               # Provider 工厂
 * ├── acp/                    # ACP 协议基础设施
 * │   ├── index.ts
 * │   ├── json-rpc.ts         # JSON-RPC 2.0 类型与工具函数
 * │   ├── types.ts            # ACP 协议类型定义
 * │   ├── transport.ts        # 传输层（Stdio）
 * │   └── acp-client.ts       # ACP 客户端连接管理
 * └── providers/
 *     ├── index.ts
 *     └── claude/              # Claude SDK 实现
 *         ├── index.ts
 *         ├── provider.ts
 *         ├── message-adapter.ts
 *         └── options-adapter.ts
 * ```
 *
 * ## 使用示例
 *
 * ```typescript
 * import { getProvider } from '@disclaude/core';
 *
 * // 获取默认 Provider
 * const provider = getProvider();
 *
 * // 一次性查询
 * for await (const message of provider.queryOnce('Hello', options)) {
 *   console.log(message.content);
 * }
 *
 * // 流式查询
 * const result = provider.queryStream(inputGenerator, options);
 * for await (const message of result.iterator) {
 *   console.log(message.content);
 * }
 * ```
 *
 * ## 扩展新 Provider
 *
 * ```typescript
 * import { registerProvider, type IAgentSDKProvider } from '@disclaude/core';
 *
 * class OpenAIProvider implements IAgentSDKProvider {
 *   // 实现接口方法...
 * }
 *
 * registerProvider('openai', () => new OpenAIProvider());
 * ```
 *
 * @module sdk
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  // 内容类型
  ContentBlock,
  TextContentBlock,
  ImageContentBlock,

  // 消息类型
  UserInput,
  StreamingUserMessage,
  StreamingMessageContent,
  AgentMessage,
  AgentMessageType,
  MessageRole,
  AgentMessageMetadata,

  // 工具类型
  ToolUseBlock,
  ToolResultBlock,
  InlineToolDefinition,

  // MCP 配置
  McpServerConfig,
  McpServerConfig as SdkMcpServerConfig,
  StdioMcpServerConfig,
  InlineMcpServerConfig,

  // 查询选项
  AgentQueryOptions,
  PermissionMode,

  // 查询结果
  QueryHandle,
  StreamQueryResult,

  // 统计
  QueryUsageStats,
  ProviderInfo,
} from './types.js';

// ============================================================================
// 接口导出
// ============================================================================

export type {
  IAgentSDKProvider,
  ProviderFactory,
  ProviderConstructor,
} from './interface.js';

// ============================================================================
// Provider 导出
// ============================================================================

export { ClaudeSDKProvider } from './providers/index.js';

// ============================================================================
// 工厂函数导出
// ============================================================================

export {
  getProvider,
  registerProvider,
  registerProviderClass,
  setDefaultProvider,
  getDefaultProviderType,
  getAvailableProviders,
  clearProviderCache,
  isProviderAvailable,
  type ProviderType,
} from './factory.js';

// ============================================================================
// ACP 协议导出
// ============================================================================

export {
  AcpClient,
  StdioTransport,
  AcpMethod,
  JsonRpcErrorCode,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
  isJsonRpcErrorResponse,
  isAcpInitializeRequest,
  isAcpSessionUpdateNotification,
  generateId,
  resetIdCounter,
  createRequest,
  createNotification,
  createSuccessResponse,
  createErrorResponse,
  parseMessage,
  serializeMessage,
} from './acp/index.js';

export type {
  JsonRpcId,
  JsonRpcError,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  JsonRpcResponse,
  JsonRpcMessage,
  AcpClientCapabilities,
  AcpServerCapabilities,
  AcpInitializeParams,
  AcpInitializeResult,
  AcpNewSessionParams,
  AcpNewSessionResult,
  AcpListSessionsParams,
  AcpListSessionsResult,
  AcpLoadSessionParams,
  AcpLoadSessionResult,
  AcpCloseSessionParams,
  AcpCloseSessionResult,
  AcpContentBlockType,
  AcpTextContent,
  AcpToolUseContent,
  AcpToolResultContent,
  AcpContentBlock,
  AcpUserMessage,
  AcpAssistantMessage,
  AcpPromptParams,
  AcpStopReason,
  AcpUsage,
  AcpPromptResult,
  AcpSessionUpdateParams,
  AcpMethodName,
  TransportEvents,
  IAcpTransport,
  StdioTransportConfig,
  AcpClientConfig,
} from './acp/index.js';
