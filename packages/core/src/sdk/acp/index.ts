/**
 * ACP (Agent Communication Protocol) 协议基础设施
 *
 * 提供 ACP 协议的核心类型定义、JSON-RPC 2.0 消息层、
 * HTTP/SSE 传输层和连接管理器。
 *
 * ## 目录结构
 *
 * ```
 * packages/core/src/sdk/acp/
 * ├── index.ts          # 本文件 - 公开导出
 * ├── types.ts          # ACP 协议核心类型
 * ├── jsonrpc.ts        # JSON-RPC 2.0 消息层
 * ├── transport.ts      # HTTP/SSE 传输层
 * └── connection.ts     # 连接管理器
 * ```
 *
 * ## 使用示例
 *
 * ```typescript
 * import { AcpConnectionManager } from '@disclaude/core';
 *
 * const conn = new AcpConnectionManager({
 *   baseUrl: 'http://localhost:8000',
 * });
 *
 * await conn.connect();
 * const agents = await conn.listAgents();
 * const transport = conn.getTransport();
 * ```
 *
 * @see Issue #1333 - 支持OpenAI Agent
 * @module sdk/acp
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  // 消息
  AcpMessageRole,
  AcpContentEncoding,
  AcpMetadataKind,
  AcpPartMetadata,
  AcpMessagePart,
  AcpMessage,

  // Agent
  AcpCapability,
  AcpAgentMetadata,
  AcpAgentStatus,
  AcpAgentManifest,

  // Run
  AcpRunMode,
  AcpRunStatus,
  AcpAwaitRequest,
  AcpRunError,
  AcpRun,
  AcpCreateRunRequest,
  AcpResumeRunRequest,

  // SSE
  AcpRunEventType,
  AcpSseEvent,
  AcpRunEventData,
  AcpMessageEventData,
  AcpMessagePartEventData,
  AcpErrorEventData,

  // Session
  AcpSession,

  // 配置
  AcpClientConfig,
} from './types.js';

// ============================================================================
// 工具函数导出
// ============================================================================

export {
  createTextPart,
  createJsonPart,
  createUserMessage,
  extractTextContent,
} from './types.js';

// ============================================================================
// JSON-RPC 导出
// ============================================================================

export type {
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  JsonRpcError,
  JsonRpcResponse,
  JsonRpcMessage,
} from './jsonrpc.js';

export {
  JsonRpcErrorCode,
  AcpJsonRpcMethod,
  createRequest,
  createNotification,
  createSuccessResponse,
  createErrorResponse,
  isRequest,
  isNotification,
  isSuccessResponse,
  isErrorResponse,
  validateMessage,
} from './jsonrpc.js';

// ============================================================================
// 传输层导出
// ============================================================================

export type {
  IAcpTransport,
  AcpHttpTransportOptions,
} from './transport.js';

export {
  AcpHttpTransport,
  AcpTransportError,
  createTransport,
} from './transport.js';

// ============================================================================
// 连接管理器导出
// ============================================================================

export type {
  AcpConnectionState,
  ConnectionStateCallback,
  AcpConnectionManagerOptions,
} from './connection.js';

export { AcpConnectionManager } from './connection.js';
