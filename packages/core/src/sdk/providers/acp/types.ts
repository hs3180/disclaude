/**
 * ACP (Agent Communication Protocol) 类型定义
 *
 * 基于 ACP 规范定义的协议类型，用于实现标准化的 Agent 通信。
 * ACP 使用 REST/HTTP + SSE 作为传输层。
 *
 * @see https://agentcommunicationprotocol.dev
 * @see https://github.com/i-am-bee/acp
 * @module sdk/providers/acp/types
 */

// ============================================================================
// 消息结构
// ============================================================================

/** ACP 消息角色 */
export type ACPMessageRole = 'user' | 'agent' | string;

/** ACP 消息部分内容类型 */
export type ACPContentEncoding = 'plain' | 'base64';

/** ACP 引用元数据 */
export interface ACPCitationMetadata {
  kind: 'citation';
  sources?: Array<{ url: string; title?: string }>;
}

/** ACP 轨迹元数据（工具调用追踪） */
export interface ACPTrajectoryMetadata {
  kind: 'trajectory';
  message?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: Record<string, unknown>;
}

/** ACP 消息部分元数据联合类型 */
export type ACPMessagePartMetadata = ACPCitationMetadata | ACPTrajectoryMetadata;

/** ACP 消息部分 */
export interface ACPMessagePart {
  /** 部分名称（有名称的部分称为 "Artifact"） */
  name?: string;
  /** MIME 内容类型，默认 'text/plain' */
  content_type: string;
  /** 内联内容（与 content_url 互斥） */
  content?: string;
  /** 内容编码 */
  content_encoding?: ACPContentEncoding;
  /** URL 引用（与 content 互斥） */
  content_url?: string;
  /** 元数据 */
  metadata?: ACPMessagePartMetadata;
}

/** ACP 消息 */
export interface ACPMessage {
  /** 消息角色 */
  role: ACPMessageRole;
  /** 消息部分（有序序列） */
  parts: ACPMessagePart[];
  /** 创建时间（ISO 8601） */
  created_at?: string;
  /** 完成时间（ISO 8601） */
  completed_at?: string;
}

// ============================================================================
// Agent 发现与能力声明
// ============================================================================

/** ACP Agent 能力描述 */
export interface ACPCapability {
  name: string;
  description: string;
}

/** ACP Agent 元数据 */
export interface ACPAgentMetadata {
  documentation?: string;
  license?: string;
  programming_language?: string;
  natural_languages?: string[];
  framework?: string;
  capabilities?: ACPCapability[];
  domains?: string[];
  tags?: string[];
}

/** ACP Agent 状态（运行时指标） */
export interface ACPAgentStatus {
  state?: 'idle' | 'busy' | 'offline';
  total_runs?: number;
  successful_runs?: number;
  failed_runs?: number;
  average_duration_seconds?: number;
}

/** ACP Agent 清单（能力声明） */
export interface ACPAgentManifest {
  /** Agent 名称（RFC 1123 DNS 标签格式） */
  name: string;
  /** 描述 */
  description?: string;
  /** 接受的 MIME 类型 */
  input_content_types: string[];
  /** 产生的 MIME 类型 */
  output_content_types: string[];
  /** 元数据 */
  metadata?: ACPAgentMetadata;
  /** 运行时状态 */
  status?: ACPAgentStatus;
}

// ============================================================================
// Run 生命周期
// ============================================================================

/** ACP Run 状态 */
export type ACPRunStatus =
  | 'created'
  | 'in-progress'
  | 'awaiting'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed';

/** ACP 执行模式 */
export type ACPExecutionMode = 'sync' | 'async' | 'stream';

/** ACP 等待请求（Agent 暂停执行时发出） */
export interface ACPAwaitRequest {
  type: 'message';
  message: ACPMessage;
}

/** ACP 错误模型 */
export interface ACPErrorModel {
  code: 'server_error' | 'invalid_input' | 'not_found';
  message: string;
  data?: unknown;
}

/** ACP Run 对象 */
export interface ACPRun {
  run_id: string;
  agent_name: string;
  session_id?: string;
  status: ACPRunStatus;
  await_request?: ACPAwaitRequest;
  output: ACPMessage[];
  error?: ACPErrorModel;
  created_at: string;
  finished_at?: string;
}

/** ACP Run 创建请求 */
export interface ACPRunCreateRequest {
  agent_name: string;
  input: ACPMessage[];
  session_id?: string;
  mode: ACPExecutionMode;
}

// ============================================================================
// SSE 事件类型
// ============================================================================

/** ACP SSE 事件联合类型 */
export type ACPEvent =
  | { type: 'run.created'; run: ACPRun }
  | { type: 'run.in-progress'; run: ACPRun }
  | { type: 'run.awaiting'; run: ACPRun }
  | { type: 'run.completed'; run: ACPRun }
  | { type: 'run.cancelled'; run: ACPRun }
  | { type: 'run.failed'; run: ACPRun }
  | { type: 'message.created'; message: ACPMessage }
  | { type: 'message.part'; part: ACPMessagePart }
  | { type: 'message.completed'; message: ACPMessage }
  | { type: 'error'; error: ACPErrorModel };

// ============================================================================
// Session
// ============================================================================

/** ACP Session */
export interface ACPSession {
  id: string;
  history: string[];
  state?: string;
}

// ============================================================================
// 连接配置
// ============================================================================

/** ACP 客户端连接配置 */
export interface ACPClientConfig {
  /** ACP Server 基础 URL */
  baseUrl: string;
  /** 请求超时（毫秒），默认 30000 */
  timeout?: number;
  /** 自定义 fetch 实现（用于测试） */
  fetch?: typeof globalThis.fetch;
  /** 自定义 headers */
  headers?: Record<string, string>;
}

/** ACP 连接状态 */
export type ACPConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/** ACP 连接信息 */
export interface ACPConnectionInfo {
  state: ACPConnectionState;
  baseUrl: string;
  connectedAt?: Date;
  lastError?: string;
  agents?: ACPAgentManifest[];
}
