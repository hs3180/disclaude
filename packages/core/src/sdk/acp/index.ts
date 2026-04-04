/**
 * ACP (Agent Communication Protocol) 模块
 *
 * 提供 ACP 协议的基础设施，包括：
 * - JSON-RPC 2.0 类型定义和消息工具函数
 * - 传输层抽象（stdio/SSE）
 * - 连接管理器（初始化握手、消息路由）
 * - ACP ↔ AgentMessage 消息适配器
 *
 * Issue #1333: 支持OpenAI Agent - PR A (ACP 协议基础设施)
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  // JSON-RPC 2.0 基础类型
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcError,
  JsonRpcErrorResponse,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcMessage,

  // ACP 方法
  AcpMethodName,

  // ACP 能力
  AcpClientCapabilities,
  AcpServerCapabilities,

  // ACP 初始化
  AcpInitializeParams,
  AcpInitializeResult,

  // ACP 任务
  AcpTaskId,
  AcpTaskState,
  AcpTextContent,
  AcpToolUseContent,
  AcpToolResultContent,
  AcpImageContent,
  AcpContentBlock,
  AcpMessageRole,
  AcpTaskMessage,
  AcpTaskSendParams,
  AcpTaskSendResult,
  AcpTaskCancelParams,
  AcpTaskCancelResult,
  AcpTaskNotificationParams,

  // ACP 传输配置
  AcpStdioTransportConfig,
  AcpSseTransportConfig,
  AcpTransportConfig,
} from './types.js';

// ============================================================================
// 常量导出
// ============================================================================

export {
  AcpMethod,
  JsonRpcErrorCode,
} from './types.js';

// ============================================================================
// 工具函数导出
// ============================================================================

export {
  createJsonRpcRequest,
  createJsonRpcNotification,
  createJsonRpcSuccessResponse,
  createJsonRpcErrorResponse,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
  parseJsonRpcMessage,
  serializeJsonRpcMessage,
} from './types.js';

// ============================================================================
// 传输层导出
// ============================================================================

export type { IAcpTransport } from './transport.js';

export { StdioTransport } from './transport.js';

// ============================================================================
// 连接管理器导出
// ============================================================================

export type {
  AcpConnectionState,
  AcpConnectionEvents,
} from './connection.js';

export { AcpConnection } from './connection.js';

// ============================================================================
// 消息适配器导出
// ============================================================================

export {
  userInputToAcpMessage,
  acpMessageToAgentMessages,
} from './message-adapter.js';
