/**
 * ACP (Agent Client Protocol) 模块
 *
 * 提供 ACP 协议类型定义、Transport 层实现、消息适配器和 Client。
 */

// 类型导出
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
} from './types.js';

// Transport 导出
export {
  AcpError,
  createRequest,
  createNotification,
  isResponse,
  isNotification,
  parseNdjsonBuffer,
  AcpStdioTransport,
} from './transport.js';

export type {
  IAcpTransport,
  AcpStdioTransportConfig,
  AcpMessageHandler,
  AcpErrorHandler,
  AcpCloseHandler,
} from './transport.js';

// Message Adapter 导出
export { adaptSessionUpdate, adaptPromptResult } from './message-adapter.js';

// Client 导出
export { AcpClient } from './acp-client.js';
export type {
  AcpClientState,
  AcpClientConfig,
  AcpServerCapabilities,
  PermissionRequestCallback,
} from './acp-client.js';

// Chunk Aggregator 导出
export { TextChunkAggregator } from './chunk-aggregator.js';
export type { TextChunkAggregatorOptions } from './chunk-aggregator.js';
