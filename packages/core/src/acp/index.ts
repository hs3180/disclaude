/**
 * ACP (Agent Client Protocol) Module
 *
 * 提供 ACP 协议支持，用于标准化 Agent 通信接口。
 * Issue #1435: 用 ACP 协议替代现有 SDK Provider 抽象
 */

// ACP Provider implementation
export { ClaudeAcpProvider } from './claude-provider.js';

// ACP interfaces
export type { IAcpAgent } from './interface.js';

// ACP types
export type {
  AcpSessionInfo,
  AcpProviderConfig,
  AcpInitializeResult,
  AcpNewSessionResult,
  AcpSessionListItem,
  AcpUsageStats,
  AcpSessionNotification,
  AcpSessionUpdate,
  AcpPromptResponse,
  AcpStopReason,
  AcpToolCall,
  AcpToolCallUpdate,
  AcpContentBlock,
} from './types.js';

// ACP utilities
export { adaptAcpNotification, adaptStopReason } from './message-adapter.js';
export { createStreamPair, AsyncMessageQueue } from './stream-pair.js';
