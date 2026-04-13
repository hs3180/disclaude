/**
 * ACP (Agent Client Protocol) 模块
 *
 * 提供 ACP 协议类型定义和 Transport 层实现。
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
