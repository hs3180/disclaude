/**
 * ACP (Agent Communication Protocol) 模块导出
 *
 * 提供 ACP 协议基础设施：
 * - 类型定义（JSON-RPC 2.0 消息、ACP 方法、能力声明等）
 * - 传输层（stdio 子进程通信）
 * - 连接管理器（能力协商、请求/响应匹配、通知分发）
 *
 * 这是 PR A（ACP 协议基础设施），后续 PR 将在此基础上实现：
 * - PR B: AcpClientProvider（实现 IAgentSDKProvider 接口）
 * - PR C: OpenAI ACP Server 集成
 * - PR D: 配置层（Provider 选择、ACP 连接配置）
 *
 * @module sdk/providers/acp
 * @see Issue #1333 - 支持OpenAI Agent
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  // JSON-RPC 2.0 基础类型
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  JsonRpcError,
  JsonRpcNotification,

  // ACP 能力声明
  AcpClientCapabilities,
  AcpServerCapabilities,
  AcpModelInfo,

  // ACP 任务类型
  AcpTaskState,
  AcpTaskSendParams,
  AcpTaskOptions,
  AcpContentBlock,
  AcpMessage,
  AcpNotificationMessageParams,
  AcpNotificationProgressParams,
  AcpNotificationCompleteParams,
  AcpUsageStats,

  // ACP 初始化
  AcpInitializeParams,
  AcpInitializeResult,

  // ACP 传输配置
  AcpTransportType,
  AcpStdioTransportConfig,
  AcpSseTransportConfig,
  AcpTransportConfig,
  AcpMethodName,
} from './types.js';

// ============================================================================
// 常量导出
// ============================================================================

export { AcpMethod, JsonRpcErrorCode } from './types.js';

// ============================================================================
// 传输层导出
// ============================================================================

export { StdioTransport, createTransport } from './transport.js';
export type { IAcpTransport, TransportMessageHandler, TransportErrorHandler, TransportCloseHandler } from './transport.js';

// ============================================================================
// 连接管理器导出
// ============================================================================

export { AcpConnection } from './connection.js';
export type { AcpConnectionState, AcpConnectionConfig } from './connection.js';
