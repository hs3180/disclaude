/**
 * ACP (Agent Communication Protocol) Provider 模块导出
 *
 * PR A: ACP 协议基础设施
 * - types.ts: ACP 协议类型定义
 * - client.ts: ACP HTTP 客户端
 * - message-adapter.ts: ACP ↔ AgentMessage 消息适配器
 *
 * @module sdk/providers/acp
 */

export type {
  // 消息结构
  ACPMessage,
  ACPMessageRole,
  ACPMessagePart,
  ACPMessagePartMetadata,
  ACPContentEncoding,
  ACPCitationMetadata,
  ACPTrajectoryMetadata,

  // Agent 发现
  ACPCapability,
  ACPAgentMetadata,
  ACPAgentStatus,
  ACPAgentManifest,

  // Run 生命周期
  ACPRun,
  ACPRunStatus,
  ACPRunCreateRequest,
  ACPExecutionMode,
  ACPAwaitRequest,
  ACPErrorModel,

  // SSE 事件
  ACPEvent,

  // Session
  ACPSession,

  // 连接
  ACPClientConfig,
  ACPConnectionState,
  ACPConnectionInfo,
} from './types.js';

export { ACPClient, ACPProtocolError } from './client.js';
export { adaptACPEvent, toACPMessages } from './message-adapter.js';
