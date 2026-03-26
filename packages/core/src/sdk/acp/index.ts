/**
 * ACP (Agent Communication Protocol) 模块
 *
 * 提供 ACP 协议的基础设施，包括：
 * - JSON-RPC 2.0 消息类型和工具函数
 * - ACP 协议类型定义
 * - 连接管理器（stdio 传输）
 * - 协议客户端（初始化、任务管理）
 *
 * @module acp
 */

// JSON-RPC 2.0
export {
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
  isSuccessResponse,
  isErrorResponse,
  createRequest,
  createNotification,
  createSuccessResponse,
  createErrorResponse,
  createError,
  parseJsonRpcMessage,
  serializeJsonRpcMessage,
  isValidJsonRpcMessage,
  JsonRpcParseError,
  JsonRpcProtocolError,
  JsonRpcErrorCode,
  type JsonRpcId,
  type JsonRpcParams,
  type JsonRpcRequest,
  type JsonRpcSuccessResponse,
  type JsonRpcError,
  type JsonRpcErrorResponse,
  type JsonRpcResponse,
  type JsonRpcNotification,
  type JsonRpcMessage,
} from './json-rpc.js';

// ACP 类型
export type {
  AcpTransportType,
  AcpStdioConfig,
  AcpSseConfig,
  AcpTransportConfig,
  AcpClientCapabilities,
  AcpServerCapabilities,
  AcpTaskCapabilities,
  AcpInitializeParams,
  AcpInitializeResult,
  AcpTaskId,
  AcpTaskStatus,
  AcpTaskPriority,
  AcpTaskMessageRole,
  AcpContentBlock,
  AcpTaskMessage,
  AcpTaskSendParams,
  AcpTaskOptions,
  AcpTaskSendResult,
  AcpTaskCancelParams,
  AcpTaskCancelResult,
  AcpTaskStatusParams,
  AcpTaskStatusResult,
  AcpTaskUsage,
  AcpTaskMessageNotification,
  AcpTaskStatusNotification,
  AcpConnectionState,
  AcpConnectionEvent,
  AcpConnectionListener,
} from './types.js';

// 连接管理器
export { AcpConnection } from './connection.js';

// 协议客户端
export { AcpClient, ACP_PROTOCOL_VERSION, AcpMethod, AcpNotification } from './protocol.js';
