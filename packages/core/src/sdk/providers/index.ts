/**
 * SDK Providers 模块导出
 */

export { ClaudeSDKProvider } from './claude/index.js';

// ACP (Agent Communication Protocol) 基础设施
// PR A of Issue #1333: 支持OpenAI Agent
export {
  AcpConnection,
  StdioTransport,
  createTransport,
  AcpMethod,
  JsonRpcErrorCode,
} from './acp/index.js';

export type {
  // ACP types
  AcpConnectionState,
  AcpConnectionConfig,
  AcpTransportType,
  AcpTransportConfig,
  AcpStdioTransportConfig,
  AcpSseTransportConfig,
  AcpClientCapabilities,
  AcpServerCapabilities,
  AcpModelInfo,
  AcpTaskState,
  AcpTaskSendParams,
  AcpTaskOptions,
  AcpContentBlock,
  AcpMessage,
  AcpNotificationMessageParams,
  AcpNotificationProgressParams,
  AcpNotificationCompleteParams,
  AcpUsageStats,
  AcpInitializeParams,
  AcpInitializeResult,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  JsonRpcError,
  JsonRpcNotification,
  AcpMethodName,
  // Transport types
  IAcpTransport,
  TransportMessageHandler,
  TransportErrorHandler,
  TransportCloseHandler,
} from './acp/index.js';
