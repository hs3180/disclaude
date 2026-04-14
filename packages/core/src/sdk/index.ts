/**
 * Agent SDK - ACP (Agent Client Protocol) 模块
 *
 * Issue #2312: 移除了旧的 SDK Provider 抽象层（interface.ts, factory.ts, providers/）。
 * 现在仅保留 ACP Client 和核心类型定义。
 *
 * ## 目录结构
 *
 * ```
 * packages/core/src/sdk/
 * ├── index.ts                 # 本文件 - 公开导出
 * ├── types.ts                 # 核心类型定义（AgentMessage, QueryHandle 等）
 * └── acp/                     # ACP Client 实现
 *     ├── index.ts
 *     ├── types.ts             # ACP 协议类型
 *     ├── transport.ts         # stdio Transport
 *     ├── acp-client.ts        # ACP Client 实现
 *     └── message-adapter.ts   # ACP → AgentMessage 消息映射
 * ```
 *
 * @module sdk
 */

// ============================================================================
// 核心类型导出
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

  // MCP 配置
  McpServerConfig,
  McpServerConfig as SdkMcpServerConfig,
  StdioMcpServerConfig,

  // 查询选项
  AgentQueryOptions,
  PermissionMode,

  // 查询结果
  QueryHandle,

  // 统计
  QueryUsageStats,
} from './types.js';

// ============================================================================
// ACP (Agent Client Protocol) 导出
// ============================================================================

export {
  AcpError,
  createRequest,
  createNotification,
  isResponse,
  isNotification,
  parseNdjsonBuffer,
  AcpStdioTransport,
  AcpClient,
} from './acp/index.js';

export type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcErrorDetail,
  JsonRpcErrorResponse,
  JsonRpcNotification,
  JsonRpcMessage,
  AcpTextBlock,
  AcpImageBlock,
  AcpContentBlock,
  AcpAuthCapabilities,
  AcpFsCapabilities,
  AcpClientCapabilities,
  AcpModelDescriptor,
  AcpModelsInfo,
  AcpInitializeParams,
  AcpSessionNewParams,
  AcpSessionNewResult,
  AcpSessionPromptParams,
  AcpPromptResult,
  AcpPermissionRequestParams,
  AcpPermissionOutcome,
  AcpPermissionResult,
  AcpSessionCancelParams,
  AcpAgentMessageChunkUpdate,
  AcpToolCallUpdate,
  AcpPlanUpdate,
  AcpSessionUpdate,
  AcpSessionUpdateParams,
  AcpMethod,
  IAcpTransport,
  AcpStdioTransportConfig,
  AcpMessageHandler,
  AcpErrorHandler,
  AcpCloseHandler,
  AcpClientState,
  AcpClientConfig,
  AcpServerCapabilities,
  PermissionRequestCallback,
} from './acp/index.js';
