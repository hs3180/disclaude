/**
 * ACP (Agent Communication Protocol) 模块
 *
 * 提供 ACP 协议的基础设施，包括：
 * - JSON-RPC 2.0 消息类型与工具函数
 * - ACP 协议类型定义（方法、参数、返回值）
 * - 传输层抽象与 Stdio 实现
 * - ACP 客户端连接管理
 *
 * ## 目录结构
 *
 * ```
 * packages/core/src/sdk/acp/
 * ├── index.ts           # 本文件 - 公开导出
 * ├── json-rpc.ts        # JSON-RPC 2.0 类型与工具函数
 * ├── types.ts           # ACP 协议类型定义
 * ├── transport.ts       # 传输层抽象与 Stdio 实现
 * └── acp-client.ts      # ACP 客户端连接管理
 * ```
 *
 * ## 使用示例
 *
 * ```typescript
 * import { StdioTransport, AcpClient } from '@disclaude/core';
 *
 * const transport = new StdioTransport();
 * transport.start();
 *
 * const client = new AcpClient({ transport });
 * const { serverInfo } = await client.initialize({
 *   clientInfo: { name: 'disclaude', version: '1.0.0' },
 *   capabilities: { streaming: true },
 * });
 * ```
 *
 * @module acp
 */

// JSON-RPC 2.0
export {
  JsonRpcErrorCode,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
  isJsonRpcErrorResponse,
  generateId,
  resetIdCounter,
  createRequest,
  createNotification,
  createSuccessResponse,
  createErrorResponse,
  parseMessage,
  serializeMessage,
} from './json-rpc.js';

export type {
  JsonRpcId,
  JsonRpcError,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  JsonRpcResponse,
  JsonRpcMessage,
} from './json-rpc.js';

// ACP 类型
export {
  AcpMethod,
  isAcpInitializeRequest,
  isAcpSessionUpdateNotification,
} from './types.js';

export type {
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
} from './types.js';

// 传输层
export {
  StdioTransport,
} from './transport.js';

export type {
  TransportEvents,
  IAcpTransport,
  StdioTransportConfig,
} from './transport.js';

// ACP 客户端
export { AcpClient } from './acp-client.js';

export type {
  AcpClientConfig,
} from './acp-client.js';
