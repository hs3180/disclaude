/**
 * ACP (Agent Client Protocol) 模块导出
 *
 * ACP 协议基础设施，为多模型支持提供标准化通信层。
 *
 * @see https://github.com/agentclientprotocol/agent-client-protocol
 * @see Issue #1333 - 支持OpenAI Agent
 */

// 类型导出
export type {
  // JSON-RPC 2.0 基础类型
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  JsonRpcMessage,

  // 能力协商
  ClientCapabilities,
  ClientFsCapabilities,
  ClientInfo,
  AgentCapabilities,
  AgentInfo,
  PromptCapabilities,
  McpCapabilities,
  SessionCapabilities,
  AuthMethod,

  // 初始化
  InitializeParams,
  InitializeResult,
  AuthenticateParams,
  AuthenticateResult,

  // 会话
  StopReason,
  AcpMcpServerConfig,
  SessionNewParams,
  SessionNewResult,
  SessionLoadParams,
  SessionLoadResult,
  SessionPromptParams,
  SessionPromptResult,

  // 内容块
  AcpTextBlock,
  AcpImageBlock,
  AcpResourceLinkBlock,
  AcpResourceBlock,
  AcpAudioBlock,
  AcpContentBlock,

  // 会话更新
  ToolCallStatus,
  ToolCallKind,
  ToolCallLocation,
  ToolCallContentItem,
  ToolCallUpdate,
  SessionUpdate,
  AcpUsageStats,
  SessionUpdateNotification,
  SessionCancelNotification,

  // 权限
  PermissionOptionKind,
  PermissionOption,
  PermissionToolCall,
  RequestPermissionParams,
  PermissionOutcome,
  RequestPermissionResult,

  // 连接
  AcpConnectionState,
  AcpConnectionConfig,
} from './types.js';

// 常量导出
export {
  JsonRpcErrorCode,
  AcpErrorCode,
} from './types.js';

// JSON-RPC 工具函数导出
export {
  isRequest,
  isNotification,
  isSuccessResponse,
  isErrorResponse,
  isResponse,
  createRequest,
  createNotification,
  createSuccessResponse,
  createErrorResponse,
  createError,
  serializeMessage,
  parseMessages,
  isValidJsonRpcMessage,
  JsonRpcError,
  resetIdCounter,
} from './json-rpc.js';

// 连接管理器导出
export { AcpConnection } from './connection.js';
