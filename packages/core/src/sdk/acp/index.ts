/**
 * ACP (Agent Communication Protocol) 模块
 *
 * 提供基于 JSON-RPC 2.0 的 Agent 通信协议基础设施。
 * ACP 是 OpenAI 提出的开放协议标准，通过标准化接口解耦 Agent 运行时和模型提供者。
 *
 * ## 架构
 *
 * ```
 * IAgentSDKProvider → ACPClient (PR B) → ACP Connection → Transport
 *                                                    ↕
 *                                            JSON-RPC 2.0
 *                                                    ↕
 *                                          ACP Server (Claude/OpenAI/...)
 * ```
 *
 * ## 本模块内容 (PR A: 协议基础设施)
 *
 * - `types.ts`     — 协议类型定义（JSON-RPC 2.0 + ACP 方法/通知）
 * - `json-rpc.ts`  — JSON-RPC 消息构建、解析、序列化
 * - `transport.ts` — 传输层抽象（stdio/SSE）
 * - `connection.ts` — 连接管理（生命周期、能力协商、请求/响应关联）
 *
 * @module sdk/acp
 * @see Issue #1333
 * @see https://github.com/openai/agentic-communication-protocol
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  // JSON-RPC 2.0
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcError,
  JsonRpcErrorResponse,
  JsonRpcResponse,
  JsonRpcMessage,

  // ACP 常量类型
  AcpMethod,
  AcpTaskStatus,
  AcpTransportType,

  // ACP 能力
  AcpCapabilities,
  AcpInitializeParams,
  AcpInitializeResult,

  // ACP 任务
  AcpTaskCreateParams,
  AcpTaskCreateResult,
  AcpTaskSendParams,
  AcpTaskSendResult,
  AcpTaskCancelParams,
  AcpTaskCancelResult,
  AcpTaskStatusParams,
  AcpTaskStatusResult,
  AcpContentBlock,

  // ACP 通知
  AcpTaskStatusChangedParams,
  AcpTaskMessageParams,

  // ACP 配置
  AcpStdioTransportConfig,
  AcpSseTransportConfig,
  AcpTransportConfig,
  AcpConnectionConfig,
} from './types.js';

export {
  // JSON-RPC 常量
  AcpErrorCodes,
  AcpMethods,
  AcpNotifications,

  // 类型守卫
  isJsonRpcResponse,
} from './types.js';

// ============================================================================
// JSON-RPC 消息处理导出
// ============================================================================

export {
  JsonRpcMessageParser,
  createRequest,
  createSuccessResponse,
  createErrorResponse,
  createAcpError,
  serializeMessage,
  validateJsonRpcMessage,
  isErrorResponse,
  extractError,
} from './json-rpc.js';

// ============================================================================
// 传输层导出
// ============================================================================

export type {
  TransportEventType,
  TransportEvent,
  IAcpTransport,
} from './transport.js';

export {
  StdioTransport,
  createTransport,
} from './transport.js';

// ============================================================================
// 连接管理导出
// ============================================================================

export type {
  AcpConnectionState,
} from './connection.js';

export {
  AcpConnection,
} from './connection.js';
