/**
 * ACP (Agent Communication Protocol) 模块
 *
 * 提供 ACP 协议的基础设施，包括：
 * - JSON-RPC 2.0 消息类型定义
 * - stdio 传输层（子进程通信）
 * - ACP Client（高层 API）
 *
 * 这是 Issue #1333 的 PR A：ACP 协议基础设施。
 * 后续 PR 将实现：
 * - PR B: ACP Client 适配层（实现 IAgentSDKProvider 接口）
 * - PR C: OpenAI ACP Server 集成
 * - PR D: 配置层
 *
 * @module sdk/acp
 * @see Issue #1333
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  // JSON-RPC 2.0
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  JsonRpcError,
  JsonRpcNotification,
  JsonRpcMessage,

  // ACP 能力协商
  AcpClientCapabilities,
  AcpServerCapabilities,
  AcpInitializeParams,
  AcpInitializeResult,
  AcpClientInfo,
  AcpServerInfo,

  // ACP 任务管理
  AcpTaskState,
  AcpTaskPriority,
  AcpTaskRole,
  AcpTaskContent,
  AcpTaskMessage,
  AcpTaskSendParams,
  AcpTaskMetadata,
  AcpTaskSendResult,
  AcpTaskCancelParams,
  AcpTaskCancelResult,

  // ACP 通知
  AcpTaskStatusNotification,
  AcpTaskProgressNotification,

  // ACP 配置
  AcpStdioTransportConfig,
  AcpClientConfig,

  // ACP 事件
  AcpEventType,
  AcpEvent,
  AcpTaskStatusEvent,
  AcpTaskProgressEvent,
  AcpErrorEvent,
} from './types.js';

// ============================================================================
// 传输层导出
// ============================================================================

export {
  AcpStdioTransport,
  createNotification,
} from './transport.js';

export type {
  IAcpTransport,
  TransportMessageListener,
  TransportErrorListener,
  TransportCloseListener,
} from './transport.js';

// ============================================================================
// Client 导出
// ============================================================================

export {
  AcpClient,
  AcpError,
} from './acp-client.js';

export type {
  AcpClientState,
} from './acp-client.js';
