/**
 * ACP (Agentic Communication Protocol) 模块
 *
 * 提供 ACP 协议基础设施，包括：
 * - 协议类型定义
 * - JSON-RPC 2.0 消息格式
 * - 传输层（stdio/SSE）
 *
 * ## 目录结构
 *
 * ```
 * packages/core/src/acp/
 * ├── index.ts          # 本文件 - 公开导出
 * ├── types.ts          # ACP 协议类型定义
 * ├── json-rpc.ts       # JSON-RPC 2.0 消息格式
 * └── transport.ts      # 传输层（stdio/SSE）
 * ```
 *
 * ## 使用示例
 *
 * ```typescript
 * import { createRequest, createTransport } from '@disclaude/core/acp';
 *
 * // 创建 stdio 传输
 * const transport = createTransport({
 *   type: 'stdio',
 *   command: 'openai-acp-server',
 * });
 *
 * await transport.connect();
 * transport.onMessage((msg) => console.log(msg));
 *
 * // 发送任务
 * transport.send(createRequest('acp.task/send', { message: { role: 'user', content: 'Hello' } }));
 * ```
 *
 * @module acp
 * Related: Issue #1333
 */

// 协议类型
export type {
  // 能力
  ServerCapabilities,
  ClientCapabilities,
  // 会话
  SessionStatus,
  SessionInfo,
  // 内容块
  AcpTextContent,
  AcpToolUseContent,
  AcpToolResultContent,
  AcpContentBlock,
  // 任务
  TaskSendParams,
  AcpTaskMessage,
  TaskCancelParams,
  TaskStatus,
  TaskResult,
  AcpUsage,
  // 通知
  MessageNotificationParams,
  ProgressNotificationParams,
  StatusNotificationParams,
  // 连接配置
  AcpTransportType,
  AcpStdioConfig,
  AcpSseConfig,
  AcpConnectionConfig,
  // 初始化
  InitializeParams,
  InitializeResult,
} from './types.js';

export {
  AcpErrorCode,
  ACP_VERSION,
  AcpMethod,
} from './types.js';

// JSON-RPC
export type {
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcSuccessResponse,
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcMessage,
  JsonRpcBatch,
  ValidationResult,
  ParseResult,
} from './json-rpc.js';

export {
  createRequest,
  createNotification,
  createSuccessResponse,
  createErrorResponse,
  createStandardError,
  validateMessage,
  isNotification,
  isRequest,
  isResponse,
  isErrorResponse,
  isSuccessResponse,
  parseMessage,
  serializeMessage,
} from './json-rpc.js';

// 传输层
export type {
  MessageHandler,
  ErrorHandler,
  TransportState,
  AcpTransport,
} from './transport.js';

export {
  StdioTransport,
  SseTransport,
  createTransport,
} from './transport.js';
