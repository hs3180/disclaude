/**
 * JSON-RPC 2.0 协议类型定义和工具函数
 *
 * ACP (Agent Communication Protocol) 基于 JSON-RPC 2.0 进行通信。
 * 参考规范: https://www.jsonrpc.org/specification
 */

// ============================================================================
// JSON-RPC 2.0 基础类型
// ============================================================================

/** JSON-RPC 2.0 请求 ID 类型 */
export type JsonRpcId = string | number | null;

/** JSON-RPC 2.0 参数类型 */
export type JsonRpcParams = Record<string, unknown> | unknown[];

// ============================================================================
// JSON-RPC 2.0 消息类型
// ============================================================================

/**
 * JSON-RPC 2.0 请求消息
 */
export interface JsonRpcRequest {
  /** JSON-RPC 版本，必须为 "2.0" */
  jsonrpc: '2.0';
  /** 请求方法名 */
  method: string;
  /** 请求参数 */
  params?: JsonRpcParams;
  /** 请求 ID（用于关联响应） */
  id?: JsonRpcId;
}

/**
 * JSON-RPC 2.0 成功响应
 */
export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  /** 关联的请求 ID */
  id: JsonRpcId;
  /** 成功结果 */
  result: unknown;
}

/**
 * JSON-RPC 2.0 错误对象
 */
export interface JsonRpcError {
  /** 错误码 */
  code: number;
  /** 错误消息 */
  message: string;
  /** 额外错误数据 */
  data?: unknown;
}

/**
 * JSON-RPC 2.0 错误响应
 */
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  /** 关联的请求 ID */
  id: JsonRpcId;
  /** 错误信息 */
  error: JsonRpcError;
}

/**
 * JSON-RPC 2.0 响应（成功或错误）
 */
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/**
 * JSON-RPC 2.0 通知（无 ID 的请求，不需要响应）
 */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: JsonRpcParams;
  // 故意省略 id 字段 — 通知不携带 id
}

/**
 * JSON-RPC 2.0 消息联合类型
 */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ============================================================================
// 预定义错误码
// ============================================================================

/** 标准错误码 */
export const JsonRpcErrorCode = {
  /** 解析错误 — 无效的 JSON */
  PARSE_ERROR: -32700,
  /** 无效请求 — 发送的 JSON 不是一个有效的请求对象 */
  INVALID_REQUEST: -32600,
  /** 方法未找到 */
  METHOD_NOT_FOUND: -32601,
  /** 无效参数 */
  INVALID_PARAMS: -32602,
  /** 内部错误 */
  INTERNAL_ERROR: -32603,
  /** 服务器错误基值（-32000 ~ -32099） */
  SERVER_ERROR_START: -32000,
  /** 服务器错误上限 */
  SERVER_ERROR_END: -32099,
} as const;

// ============================================================================
// 类型守卫
// ============================================================================

/**
 * 判断消息是否为请求（有 id 字段的请求）
 */
export function isJsonRpcRequest(msg: unknown): msg is JsonRpcRequest {
  if (typeof msg !== 'object' || msg === null) {return false;}
  const obj = msg as Record<string, unknown>;
  return (
    obj.jsonrpc === '2.0' &&
    typeof obj.method === 'string' &&
    !('result' in obj) &&
    !('error' in obj) &&
    'id' in obj
  );
}

/**
 * 判断消息是否为通知（无 id 字段的请求）
 */
export function isJsonRpcNotification(msg: unknown): msg is JsonRpcNotification {
  if (typeof msg !== 'object' || msg === null) {return false;}
  const obj = msg as Record<string, unknown>;
  return (
    obj.jsonrpc === '2.0' &&
    typeof obj.method === 'string' &&
    !('result' in obj) &&
    !('error' in obj) &&
    !('id' in obj)
  );
}

/**
 * 判断消息是否为响应
 */
export function isJsonRpcResponse(msg: unknown): msg is JsonRpcResponse {
  if (typeof msg !== 'object' || msg === null) {return false;}
  const obj = msg as Record<string, unknown>;
  return (
    obj.jsonrpc === '2.0' &&
    ('result' in obj || 'error' in obj) &&
    'id' in obj
  );
}

/**
 * 判断响应是否为成功响应
 */
export function isSuccessResponse(msg: unknown): msg is JsonRpcSuccessResponse {
  return typeof msg === 'object' && msg !== null && 'result' in msg;
}

/**
 * 判断响应是否为错误响应
 */
export function isErrorResponse(msg: unknown): msg is JsonRpcErrorResponse {
  return typeof msg === 'object' && msg !== null && 'error' in msg;
}

// ============================================================================
// 消息创建工具函数
// ============================================================================

/**
 * 创建 JSON-RPC 请求
 */
export function createRequest(
  method: string,
  params?: JsonRpcParams,
  id?: JsonRpcId
): JsonRpcRequest {
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
export function createNotification(
  method: string,
  params?: JsonRpcParams
): JsonRpcNotification {
  return {
    jsonrpc: '2.0',
    method,
    ...(params !== undefined && { params }),
  };
}

/**
 * 创建 JSON-RPC 成功响应
 */
export function createSuccessResponse(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

/**
 * 创建 JSON-RPC 错误响应
 */
export function createErrorResponse(
  id: JsonRpcId,
  error: JsonRpcError
): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    id,
    error,
  };
}

/**
 * 创建 JSON-RPC 错误对象
 */
export function createError(
  code: number,
  message: string,
  data?: unknown
): JsonRpcError {
  return { code, message, ...(data !== undefined && { data }) };
}

// ============================================================================
// 序列化/反序列化
// ============================================================================

/**
 * 解析 JSON-RPC 消息字符串
 *
 * 支持单条消息或批量消息（JSON 数组）。
 *
 * @param data - JSON 字符串
 * @returns 解析后的消息数组
 * @throws {JsonRpcParseError} 当 JSON 格式无效时
 */
export function parseJsonRpcMessage(data: string): JsonRpcMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new JsonRpcParseError('Invalid JSON');
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      throw new JsonRpcParseError('Empty batch');
    }
    return parsed;
  }

  return [parsed as JsonRpcMessage];
}

/**
 * 序列化 JSON-RPC 消息为字符串
 */
export function serializeJsonRpcMessage(msg: JsonRpcMessage): string {
  return JSON.stringify(msg);
}

/**
 * 验证消息是否为有效的 JSON-RPC 2.0 消息
 */
export function isValidJsonRpcMessage(msg: unknown): msg is JsonRpcMessage {
  if (typeof msg !== 'object' || msg === null) {
    return false;
  }

  const obj = msg as Record<string, unknown>;
  if (obj.jsonrpc !== '2.0') {
    return false;
  }

  // 请求或通知: 必须有 method 字段
  if ('method' in obj && typeof obj.method === 'string') {
    return true;
  }

  // 响应: 必须有 id 且有 result 或 error 字段
  if ('id' in obj && ('result' in obj || 'error' in obj)) {
    return true;
  }

  return false;
}

// ============================================================================
// 自定义错误类型
// ============================================================================

/**
 * JSON-RPC 解析错误
 */
export class JsonRpcParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonRpcParseError';
  }
}

/**
 * JSON-RPC 协议错误
 */
export class JsonRpcProtocolError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: JsonRpcError) {
    super(error.message);
    this.name = 'JsonRpcProtocolError';
    this.code = error.code;
    this.data = error.data;
  }
}
