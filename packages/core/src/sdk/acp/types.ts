/**
 * ACP (Agent Communication Protocol) 核心类型定义
 *
 * 基于 ACP 规范定义协议数据结构，包括 Agent、Run、Message、Session 等。
 * 这些类型与传输层无关，可适配 HTTP/REST、JSON-RPC 等不同传输方式。
 *
 * @see https://github.com/i-am-bee/acp
 * @see Issue #1333 - 支持OpenAI Agent
 * @module sdk/acp/types
 */

// ============================================================================
// 消息结构
// ============================================================================

/** 消息角色 */
export type AcpMessageRole = 'user' | 'agent' | `agent/${string}`;

/** 消息内容编码 */
export type AcpContentEncoding = 'plain' | 'base64';

/** 消息元数据类型 */
export type AcpMetadataKind = 'citation' | 'trajectory';

/** 消息部分元数据 */
export interface AcpPartMetadata {
  kind?: AcpMetadataKind;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: unknown;
  [key: string]: unknown;
}

/** 消息部分（ACP 消息的基本单元） */
export interface AcpMessagePart {
  /** 可选的 artifact 名称 */
  name?: string;
  /** MIME 类型（如 text/plain, application/json, image/png） */
  content_type: string;
  /** 内联内容（与 content_url 二选一） */
  content?: string;
  /** 内容编码 */
  content_encoding?: AcpContentEncoding;
  /** 外部内容 URL（与 content 二选一） */
  content_url?: string;
  /** 部分元数据 */
  metadata?: AcpPartMetadata;
}

/** ACP 消息 */
export interface AcpMessage {
  /** 消息角色 */
  role: AcpMessageRole;
  /** 消息部分列表（有序） */
  parts: AcpMessagePart[];
  /** 创建时间（ISO 8601） */
  created_at?: string;
  /** 完成时间（ISO 8601） */
  completed_at?: string;
}

// ============================================================================
// Agent 发现和 Manifest
// ============================================================================

/** Agent 能力声明 */
export interface AcpCapability {
  name: string;
  description?: string;
}

/** Agent 元数据（扩展信息） */
export interface AcpAgentMetadata {
  annotations?: Record<string, unknown>;
  documentation?: string;
  license?: string;
  programming_language?: string;
  natural_languages?: string[];
  framework?: string;
  capabilities?: AcpCapability[];
  domains?: string[];
  tags?: string[];
  author?: {
    name?: string;
    email?: string;
  };
  links?: Array<{
    type: string;
    url: string;
  }>;
  dependencies?: Array<{
    type: string;
    name: string;
  }>;
  recommended_models?: string[];
  [key: string]: unknown;
}

/** Agent 状态统计 */
export interface AcpAgentStatus {
  avg_run_tokens?: number;
  avg_run_time_seconds?: number;
  success_rate?: number;
}

/** Agent Manifest（Agent 能力声明） */
export interface AcpAgentManifest {
  /** Agent 名称（唯一标识符） */
  name: string;
  /** Agent 描述 */
  description: string;
  /** 支持的输入内容类型（MIME，支持通配符如 star/star） */
  input_content_types: string[];
  /** 支持的输出内容类型（MIME） */
  output_content_types: string[];
  /** 扩展元数据 */
  metadata?: AcpAgentMetadata;
  /** 运行状态统计 */
  status?: AcpAgentStatus;
}

// ============================================================================
// Run（执行任务）
// ============================================================================

/** 执行模式 */
export type AcpRunMode = 'sync' | 'async' | 'stream';

/** Run 状态 */
export type AcpRunStatus =
  | 'created'
  | 'in-progress'
  | 'awaiting'
  | 'completed'
  | 'cancelled'
  | 'cancelling'
  | 'failed';

/** Await 请求（暂停等待外部输入） */
export interface AcpAwaitRequest {
  message?: AcpMessage;
  [key: string]: unknown;
}

/** Run 错误信息 */
export interface AcpRunError {
  code: 'server_error' | 'invalid_input' | 'not_found';
  message: string;
  data?: unknown;
}

/** ACP Run（一次 Agent 执行） */
export interface AcpRun {
  /** Run 唯一标识符 */
  run_id: string;
  /** Agent 名称 */
  agent_name: string;
  /** 会话 ID */
  session_id?: string;
  /** 当前状态 */
  status: AcpRunStatus;
  /** 执行模式 */
  mode: AcpRunMode;
  /** Await 请求（暂停时） */
  await_request?: AcpAwaitRequest | null;
  /** 输出消息列表 */
  output?: AcpMessage[];
  /** 错误信息 */
  error?: AcpRunError | null;
  /** 创建时间 */
  created_at: string;
  /** 完成时间 */
  finished_at?: string;
}

/** 创建 Run 的请求 */
export interface AcpCreateRunRequest {
  /** 目标 Agent 名称 */
  agent_name: string;
  /** 会话 ID（可选，用于多轮对话） */
  session_id?: string;
  /** 输入消息 */
  input: AcpMessage[];
  /** 执行模式 */
  mode?: AcpRunMode;
}

/** 恢复 Run 的请求 */
export interface AcpResumeRunRequest {
  /** Run ID */
  run_id: string;
  /** 恢复数据（用于响应 Await） */
  await_resume?: unknown;
  /** 执行模式 */
  mode?: AcpRunMode;
}

// ============================================================================
// SSE 流事件
// ============================================================================

/** Run 生命周期事件 */
export type AcpRunEventType =
  | 'run.created'
  | 'run.in-progress'
  | 'run.awaiting'
  | 'run.completed'
  | 'run.cancelled'
  | 'run.failed'
  | 'message.created'
  | 'message.part'
  | 'message.completed'
  | 'error';

/** SSE 事件基础结构 */
export interface AcpSseEvent<T = unknown> {
  /** 事件类型 */
  type: AcpRunEventType;
  /** 事件数据 */
  data: T;
  /** 事件时间戳 */
  timestamp?: string;
}

/** Run 事件数据 */
export interface AcpRunEventData {
  run: AcpRun;
}

/** Message 事件数据 */
export interface AcpMessageEventData {
  message: AcpMessage;
}

/** Message Part 事件数据 */
export interface AcpMessagePartEventData {
  part: AcpMessagePart;
  message_index?: number;
}

/** Error 事件数据 */
export interface AcpErrorEventData {
  error: AcpRunError;
}

// ============================================================================
// Session（会话）
// ============================================================================

/** 会话信息 */
export interface AcpSession {
  /** 会话 ID */
  id: string;
  /** 关联的 Agent 名称 */
  agent_name?: string;
  /** 消息历史 URL 引用（分布式会话） */
  history?: string[];
  /** 会话状态 URL 引用 */
  state?: string;
}

// ============================================================================
// 连接配置
// ============================================================================

/** ACP 客户端配置 */
export interface AcpClientConfig {
  /** ACP Server 基础 URL（如 http://localhost:8000） */
  baseUrl: string;
  /** 默认执行模式 */
  defaultMode?: AcpRunMode;
  /** 请求超时（毫秒） */
  timeout?: number;
  /** 自定义请求头 */
  headers?: Record<string, string>;
  /** 重试次数 */
  retries?: number;
  /** 重试间隔（毫秒） */
  retryDelay?: number;
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 创建文本消息部分
 */
export function createTextPart(text: string): AcpMessagePart {
  return {
    content_type: 'text/plain',
    content: text,
  };
}

/**
 * 创建 JSON 消息部分
 */
export function createJsonPart<T = unknown>(data: T): AcpMessagePart {
  return {
    content_type: 'application/json',
    content: JSON.stringify(data),
  };
}

/**
 * 创建用户消息
 */
export function createUserMessage(text: string): AcpMessage {
  return {
    role: 'user',
    parts: [createTextPart(text)],
  };
}

/**
 * 从 AcpMessage 提取纯文本内容
 */
export function extractTextContent(message: AcpMessage): string {
  return message.parts
    .filter((part) => part.content_type === 'text/plain' && part.content)
    .map((part) => part.content as string)
    .join('\n');
}
