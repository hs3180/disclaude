/**
 * ACP (Agent Communication Protocol) 类型定义
 *
 * 基于 JSON-RPC 2.0 规范，定义 ACP 协议的消息格式和方法。
 * 参考: https://github.com/openai/agentic-communication-protocol
 *
 * Issue #1333: 支持OpenAI Agent - PR A (ACP 协议基础设施)
 */

// ============================================================================
// JSON-RPC 2.0 基础类型
// ============================================================================

/** JSON-RPC 2.0 请求 ID 类型 */
export type JsonRpcId = string | number | null;

/** JSON-RPC 2.0 请求 */
export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: TParams;
  id?: JsonRpcId;
}

/** JSON-RPC 2.0 成功响应 */
export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: '2.0';
  result: TResult;
  id: JsonRpcId;
}

/** JSON-RPC 2.0 错误对象 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** JSON-RPC 2.0 错误响应 */
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  error: JsonRpcError;
  id: JsonRpcId;
}

/** JSON-RPC 2.0 响应联合类型 */
export type JsonRpcResponse<TResult = unknown> =
  | JsonRpcSuccessResponse<TResult>
  | JsonRpcErrorResponse;

/** JSON-RPC 2.0 通知（无 id 字段的请求） */
export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: TParams;
}

/** JSON-RPC 2.0 消息联合类型 */
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponse
  | JsonRpcNotification;

// ============================================================================
// ACP 方法名称
// ============================================================================

/** ACP 标准方法名称 */
export const AcpMethod = {
  /** 初始化握手 */
  INITIALIZE: 'initialize',
  /** 初始化完成通知 */
  INITIALIZED: 'notifications/initialized',
  /** 发送任务 */
  TASK_SEND: 'tasks/send',
  /** 取消任务 */
  TASK_CANCEL: 'tasks/cancel',
  /** 任务状态通知 */
  TASK_NOTIFICATION: 'notifications/task',
  /** 消息通知 */
  MESSAGE_NOTIFICATION: 'notifications/message',
} as const;

/** ACP 方法名称类型 */
export type AcpMethodName = (typeof AcpMethod)[keyof typeof AcpMethod];

// ============================================================================
// ACP 能力声明
// ============================================================================

/** 客户端能力 */
export interface AcpClientCapabilities {
  /** 支持的传输方式 */
  transports?: ('stdio' | 'sse')[];
  /** 是否支持流式输出 */
  streaming?: boolean;
  /** 支持的内容类型 */
  contentTypes?: string[];
}

/** 服务端能力 */
export interface AcpServerCapabilities {
  /** 支持的传输方式 */
  transports?: ('stdio' | 'sse')[];
  /** 是否支持流式输出 */
  streaming?: boolean;
  /** 支持的工具名称列表 */
  tools?: string[];
  /** Agent 名称 */
  agentName?: string;
  /** Agent 版本 */
  agentVersion?: string;
}

// ============================================================================
// ACP 初始化
// ============================================================================

/** 初始化请求参数 */
export interface AcpInitializeParams {
  /** 客户端信息 */
  clientInfo: {
    name: string;
    version: string;
  };
  /** 客户端能力 */
  capabilities: AcpClientCapabilities;
  /** 传输方式 */
  transport: 'stdio' | 'sse';
}

/** 初始化响应结果 */
export interface AcpInitializeResult {
  /** 服务端能力 */
  capabilities: AcpServerCapabilities;
  /** 服务端信息 */
  serverInfo: {
    name: string;
    version: string;
  };
  /** 协议版本 */
  protocolVersion: string;
}

// ============================================================================
// ACP 任务 (Task) 类型
// ============================================================================

/** 任务 ID */
export type AcpTaskId = string;

/** 任务状态 */
export type AcpTaskState = 'pending' | 'working' | 'completed' | 'canceled' | 'failed';

/** 任务内容块 - 文本 */
export interface AcpTextContent {
  type: 'text';
  text: string;
}

/** 任务内容块 - 工具使用 */
export interface AcpToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

/** 任务内容块 - 工具结果 */
export interface AcpToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/** 任务内容块 - 图片 */
export interface AcpImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

/** 任务内容联合类型 */
export type AcpContentBlock =
  | AcpTextContent
  | AcpToolUseContent
  | AcpToolResultContent
  | AcpImageContent;

/** 任务消息角色 */
export type AcpMessageRole = 'user' | 'assistant' | 'system';

/** 任务消息 */
export interface AcpTaskMessage {
  role: AcpMessageRole;
  content: AcpContentBlock | AcpContentBlock[];
}

/** 任务发送请求参数 */
export interface AcpTaskSendParams {
  /** 任务 ID */
  id: AcpTaskId;
  /** 消息 */
  message: AcpTaskMessage;
  /** 是否接受流式输出 */
  streaming?: boolean;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/** 任务发送结果 */
export interface AcpTaskSendResult {
  /** 任务 ID */
  id: AcpTaskId;
  /** 状态 */
  status: AcpTaskState;
  /** 结果消息（任务完成时） */
  result?: AcpTaskMessage;
}

/** 任务取消请求参数 */
export interface AcpTaskCancelParams {
  /** 任务 ID */
  id: AcpTaskId;
}

/** 任务取消结果 */
export interface AcpTaskCancelResult {
  /** 任务 ID */
  id: AcpTaskId;
  /** 状态 */
  status: AcpTaskState;
}

/** 任务状态通知参数 */
export interface AcpTaskNotificationParams {
  /** 任务 ID */
  id: AcpTaskId;
  /** 状态 */
  status: AcpTaskState;
  /** 进度消息 */
  message?: AcpTaskMessage;
  /** 错误信息（失败时） */
  error?: string;
}

// ============================================================================
// ACP 传输配置
// ============================================================================

/** stdio 传输配置 */
export interface AcpStdioTransportConfig {
  type: 'stdio';
  /** 命令 */
  command: string;
  /** 参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
}

/** SSE 传输配置 */
export interface AcpSseTransportConfig {
  type: 'sse';
  /** URL */
  url: string;
  /** 请求头 */
  headers?: Record<string, string>;
}

/** 传输配置联合类型 */
export type AcpTransportConfig = AcpStdioTransportConfig | AcpSseTransportConfig;

// ============================================================================
// JSON-RPC 标准错误码
// ============================================================================

/** JSON-RPC 错误码 */
export const JsonRpcErrorCode = {
  /** 解析错误 */
  PARSE_ERROR: -32700,
  /** 无效请求 */
  INVALID_REQUEST: -32600,
  /** 方法未找到 */
  METHOD_NOT_FOUND: -32601,
  /** 无效参数 */
  INVALID_PARAMS: -32602,
  /** 内部错误 */
  INTERNAL_ERROR: -32603,
  /** ACP 特定: 任务未找到 */
  TASK_NOT_FOUND: -32001,
  /** ACP 特定: 任务已完成 */
  TASK_ALREADY_COMPLETED: -32002,
  /** ACP 特定: 能力不支持 */
  CAPABILITY_NOT_SUPPORTED: -32003,
} as const;

// ============================================================================
// JSON-RPC 消息工具函数
// ============================================================================

/**
 * 创建 JSON-RPC 请求
 */
export function createJsonRpcRequest<TParams = unknown>(
  method: string,
  params?: TParams,
  id?: JsonRpcId,
): JsonRpcRequest<TParams> {
  return {
    jsonrpc: '2.0',
    method,
    ...(params !== undefined && { params }),
    ...(id !== undefined && { id }),
  };
}

/**
 * 创建 JSON-RPC 通知
 */
export function createJsonRpcNotification<TParams = unknown>(
  method: string,
  params?: TParams,
): JsonRpcNotification<TParams> {
  return {
    jsonrpc: '2.0',
    method,
    ...(params !== undefined && { params }),
  };
}

/**
 * 创建 JSON-RPC 成功响应
 */
export function createJsonRpcSuccessResponse<TResult = unknown>(
  result: TResult,
  id: JsonRpcId,
): JsonRpcSuccessResponse<TResult> {
  return {
    jsonrpc: '2.0',
    result,
    id,
  };
}

/**
 * 创建 JSON-RPC 错误响应
 */
export function createJsonRpcErrorResponse(
  code: number,
  message: string,
  id: JsonRpcId,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    error: { code, message, ...(data !== undefined && { data }) },
    id,
  };
}

/**
 * 判断消息是否为 JSON-RPC 请求（包括通知）
 */
export function isJsonRpcRequest(message: unknown): message is JsonRpcRequest {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as Record<string, unknown>).jsonrpc === '2.0' &&
    typeof (message as Record<string, unknown>).method === 'string' &&
    !('result' in message) &&
    !('error' in message)
  );
}

/**
 * 判断消息是否为 JSON-RPC 通知（无 id 字段的请求）
 */
export function isJsonRpcNotification(message: unknown): message is JsonRpcNotification {
  return isJsonRpcRequest(message) && !('id' in message);
}

/**
 * 判断消息是否为 JSON-RPC 响应
 */
export function isJsonRpcResponse(message: unknown): message is JsonRpcResponse {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as Record<string, unknown>).jsonrpc === '2.0' &&
    ('result' in message || 'error' in message) &&
    'id' in message
  );
}

/**
 * 解析 JSON-RPC 消息
 *
 * @throws {Error} 如果消息不是有效的 JSON-RPC 2.0 消息
 */
export function parseJsonRpcMessage(data: string): JsonRpcMessage {
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    throw new Error('Invalid JSON-RPC message: not valid JSON');
  }

  if (typeof message !== 'object' || message === null) {
    throw new Error('Invalid JSON-RPC message: not an object');
  }

  const obj = message as Record<string, unknown>;

  if (obj.jsonrpc !== '2.0') {
    throw new Error('Invalid JSON-RPC message: missing or invalid jsonrpc version');
  }

  if (isJsonRpcResponse(message)) {
    return message;
  }

  if (isJsonRpcRequest(message)) {
    return message;
  }

  throw new Error('Invalid JSON-RPC message: missing method, result, or error');
}

/**
 * 序列化 JSON-RPC 消息
 */
export function serializeJsonRpcMessage(message: JsonRpcMessage): string {
  return JSON.stringify(message);
}
