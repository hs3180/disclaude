/**
 * ACP (Agent Communication Protocol) - 类型定义
 *
 * 基于 ACP 协议规范定义核心数据类型。
 * ACP 是一个开放协议，用于 AI Agent 之间的标准化通信。
 *
 * @see https://agentcommunicationprotocol.dev
 * @see Issue #1333 - 支持OpenAI Agent
 */

// ============================================================================
// 基础类型
// ============================================================================

/** ACP 错误码 */
export type ACPErrorCode = 'server_error' | 'invalid_input' | 'not_found';

/** ACP 运行状态 */
export type ACPRunStatus =
  | 'created'
  | 'in-progress'
  | 'awaiting'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed';

/** ACP 运行模式 */
export type ACPRunMode = 'sync' | 'async' | 'stream';

/** ACP 内容编码 */
export type ACPContentEncoding = 'plain' | 'base64';

// ============================================================================
// 错误类型
// ============================================================================

/** ACP 协议错误 */
export interface ACPError {
  code: ACPErrorCode;
  message: string;
  data?: Record<string, unknown>;
}

// ============================================================================
// 消息相关类型
// ============================================================================

/** 引用元数据 */
export interface ACPCitationMetadata {
  kind: 'citation';
  start_index?: number | null;
  end_index?: number | null;
  url?: string | null;
  title?: string | null;
  description?: string | null;
}

/** 轨迹元数据（用于跟踪推理和工具调用步骤） */
export interface ACPTrajectoryMetadata {
  kind: 'trajectory';
  message?: string | null;
  tool_name?: string | null;
  tool_input?: unknown;
  tool_output?: unknown;
}

/** 消息部分元数据联合类型 */
export type ACPMessagePartMetadata = ACPCitationMetadata | ACPTrajectoryMetadata;

/** ACP 消息部分 */
export interface ACPMessagePart {
  /** 部分名称（可选） */
  name?: string;
  /** 内容类型（MIME type） */
  content_type: string;
  /** 内联内容 */
  content?: string;
  /** 内容编码 */
  content_encoding?: ACPContentEncoding;
  /** 内容 URL（与 content 互斥） */
  content_url?: string;
  /** 元数据 */
  metadata?: ACPMessagePartMetadata;
}

/** ACP 消息 */
export interface ACPMessage {
  /** 发送者角色 */
  role: string;
  /** 消息部分序列 */
  parts: ACPMessagePart[];
  /** 创建时间 */
  created_at?: string;
  /** 完成时间 */
  completed_at?: string;
}

// ============================================================================
// Agent 相关类型
// ============================================================================

/** Agent 名称（RFC 1123 DNS label） */
export type ACPAgentName = string;

/** Agent 能力描述 */
export interface ACPCapability {
  name: string;
  description: string;
}

/** Agent 状态指标 */
export interface ACPStatus {
  avg_run_tokens?: number;
  avg_run_time_seconds?: number;
  success_rate?: number;
}

/** Agent 元数据 */
export interface ACPMetadata {
  annotations?: Record<string, unknown>;
  documentation?: string;
  license?: string;
  programming_language?: string;
  natural_languages?: string[];
  framework?: string;
  capabilities?: ACPCapability[];
  domains?: string[];
  tags?: string[];
  created_at?: string;
  updated_at?: string;
  author?: { name: string; email?: string; url?: string };
  contributors?: Array<{ name: string; email?: string; url?: string }>;
  links?: Array<{ type: string; url: string }>;
  dependencies?: Array<{ type: string; name: string }>;
  recommended_models?: string[];
}

/** Agent 清单（用于 Agent 发现） */
export interface ACPAgentManifest {
  name: ACPAgentName;
  description: string;
  input_content_types: string[];
  output_content_types: string[];
  metadata?: ACPMetadata;
  status?: ACPStatus;
}

// ============================================================================
// Session 类型
// ============================================================================

/** ACP Session */
export interface ACPSession {
  id: string;
  history: string[];
  state?: string;
}

// ============================================================================
// Run 相关类型
// ============================================================================

/** ACP Run（单次 Agent 执行） */
export interface ACPRun {
  agent_name: ACPAgentName;
  session_id?: string;
  run_id: string;
  status: ACPRunStatus;
  await_request?: unknown;
  output: ACPMessage[];
  error?: ACPError;
  created_at: string;
  finished_at?: string;
}

/** 创建 Run 请求 */
export interface ACPRunCreateRequest {
  agent_name: ACPAgentName;
  session_id?: string;
  session?: ACPSession;
  input: ACPMessage[];
  mode?: ACPRunMode;
}

/** 恢复 Run 请求 */
export interface ACPRunResumeRequest {
  run_id: string;
  await_resume: unknown;
  mode?: ACPRunMode;
}

// ============================================================================
// SSE 事件类型
// ============================================================================

/** 事件类型映射 */
export type ACPEventType =
  | 'message.created'
  | 'message.part'
  | 'message.completed'
  | 'generic'
  | 'run.created'
  | 'run.in-progress'
  | 'run.awaiting'
  | 'run.completed'
  | 'run.cancelled'
  | 'run.failed'
  | 'error';

/** 消息创建事件 */
export interface ACPMessageCreatedEvent {
  type: 'message.created';
  message: ACPMessage;
}

/** 消息部分事件 */
export interface ACPMessagePartEvent {
  type: 'message.part';
  part: ACPMessagePart;
}

/** 消息完成事件 */
export interface ACPMessageCompletedEvent {
  type: 'message.completed';
  message: ACPMessage;
}

/** 通用事件 */
export interface ACPGenericEvent {
  type: 'generic';
  generic: Record<string, unknown>;
}

/** Run 创建事件 */
export interface ACPRunCreatedEvent {
  type: 'run.created';
  run: ACPRun;
}

/** Run 进行中事件 */
export interface ACPRunInProgressEvent {
  type: 'run.in-progress';
  run: ACPRun;
}

/** Run 等待事件 */
export interface ACPRunAwaitingEvent {
  type: 'run.awaiting';
  run: ACPRun;
}

/** Run 完成事件 */
export interface ACPRunCompletedEvent {
  type: 'run.completed';
  run: ACPRun;
}

/** Run 取消事件 */
export interface ACPRunCancelledEvent {
  type: 'run.cancelled';
  run: ACPRun;
}

/** Run 失败事件 */
export interface ACPRunFailedEvent {
  type: 'run.failed';
  run: ACPRun;
}

/** 错误事件 */
export interface ACPErrorEvent {
  type: 'error';
  error: ACPError;
}

/** ACP SSE 事件联合类型 */
export type ACPEvent =
  | ACPMessageCreatedEvent
  | ACPMessagePartEvent
  | ACPMessageCompletedEvent
  | ACPGenericEvent
  | ACPRunCreatedEvent
  | ACPRunInProgressEvent
  | ACPRunAwaitingEvent
  | ACPRunCompletedEvent
  | ACPRunCancelledEvent
  | ACPRunFailedEvent
  | ACPErrorEvent;

// ============================================================================
// API 响应类型
// ============================================================================

/** Agent 列表响应 */
export interface ACPAgentsListResponse {
  agents: ACPAgentManifest[];
}

/** Run 事件列表响应 */
export interface ACPRunEventsListResponse {
  events: ACPEvent[];
}

// ============================================================================
// 连接配置
// ============================================================================

/** ACP 客户端配置 */
export interface ACPClientConfig {
  /** ACP 服务器基础 URL */
  baseUrl: string;
  /** 请求超时（毫秒） */
  timeout?: number;
  /** 自定义请求头 */
  headers?: Record<string, string>;
}
