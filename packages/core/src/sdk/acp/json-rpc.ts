/**
 * ACP JSON-RPC 2.0 消息层
 *
 * 提供 JSON-RPC 2.0 消息的序列化、反序列化、请求/响应关联等功能。
 * 支持 ndJSON（换行分隔的 JSON）流式传输。
 *
 * @see https://www.jsonrpc.org/specification
 * @see Issue #1333 - 支持OpenAI Agent
 */

import type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  JsonRpcError as JsonRpcErrorType,
} from './types.js';
import { JsonRpcErrorCode } from './types.js';

// ============================================================================
// 消息验证与创建
// ============================================================================

/**
 * 判断消息是否为 JSON-RPC 请求
 */
export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return (
    'jsonrpc' in msg &&
    msg.jsonrpc === '2.0' &&
    'method' in msg &&
    'id' in msg &&
    typeof msg.id === 'number'
  );
}

/**
 * 判断消息是否为 JSON-RPC 通知
 */
export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return (
    'jsonrpc' in msg &&
    msg.jsonrpc === '2.0' &&
    'method' in msg &&
    !('id' in msg)
  );
}

/**
 * 判断消息是否为 JSON-RPC 成功响应
 */
export function isSuccessResponse(msg: JsonRpcMessage): msg is JsonRpcSuccessResponse {
  return (
    'jsonrpc' in msg &&
    msg.jsonrpc === '2.0' &&
    'id' in msg &&
    'result' in msg
  );
}

/**
 * 判断消息是否为 JSON-RPC 错误响应
 */
export function isErrorResponse(msg: JsonRpcMessage): msg is JsonRpcErrorResponse {
  return (
    'jsonrpc' in msg &&
    msg.jsonrpc === '2.0' &&
    'id' in msg &&
    'error' in msg
  );
}

/**
 * 判断消息是否为响应（成功或错误）
 */
export function isResponse(msg: JsonRpcMessage): boolean {
  return isSuccessResponse(msg) || isErrorResponse(msg);
}

// ============================================================================
// 消息创建工厂
// ============================================================================

let nextId = 0;

/**
 * 创建 JSON-RPC 请求
 *
 * @param method - 方法名
 * @param params - 参数
 * @returns 请求消息
 */
export function createRequest<TParams = unknown>(
  method: string,
  params?: TParams
): JsonRpcRequest<TParams> {
  return {
    jsonrpc: '2.0',
    id: nextId++,
    method,
    params,
  };
}

/**
 * 创建 JSON-RPC 通知
 *
 * @param method - 方法名
 * @param params - 参数
 * @returns 通知消息
 */
export function createNotification<TParams = unknown>(
  method: string,
  params?: TParams
): JsonRpcNotification<TParams> {
  return {
    jsonrpc: '2.0',
    method,
    params,
  };
}

/**
 * 创建 JSON-RPC 成功响应
 *
 * @param id - 请求 ID
 * @param result - 结果
 * @returns 成功响应
 */
export function createSuccessResponse<TResult = unknown>(
  id: number,
  result: TResult
): JsonRpcSuccessResponse<TResult> {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

/**
 * 创建 JSON-RPC 错误响应
 *
 * @param id - 请求 ID（null 表示无法关联到具体请求）
 * @param code - 错误码
 * @param message - 错误消息
 * @param data - 附加错误数据
 * @returns 错误响应
 */
export function createErrorResponse(
  id: number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, data },
  };
}

/**
 * 创建标准错误对象
 */
export function createError(
  code: number,
  message: string,
  data?: unknown
): JsonRpcErrorType {
  return { code, message, data };
}

// ============================================================================
// 消息序列化与反序列化
// ============================================================================

/**
 * 序列化 JSON-RPC 消息为 ndJSON 格式
 *
 * 将消息对象序列化为 JSON 字符串并追加换行符。
 *
 * @param message - JSON-RPC 消息
 * @returns ndJSON 格式字符串
 */
export function serializeMessage(message: JsonRpcMessage): string {
  return JSON.stringify(message) + '\n';
}

/**
 * 从 ndJSON 流数据中解析消息
 *
 * 将换行分隔的 JSON 数据解析为消息数组。
 *
 * @param data - 原始数据字符串（可能包含多行）
 * @returns 解析后的消息数组
 */
export function parseMessages(data: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];

  const lines = data.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as JsonRpcMessage;
      messages.push(parsed);
    } catch {
      // 跳过无法解析的行（由上层处理日志）
    }
  }

  return messages;
}

/**
 * 验证 JSON-RPC 消息的基本结构
 *
 * @param msg - 待验证的消息
 * @returns 是否为有效的 JSON-RPC 消息
 */
export function isValidJsonRpcMessage(msg: unknown): msg is JsonRpcMessage {
  if (typeof msg !== 'object' || msg === null) {
    return false;
  }

  const obj = msg as Record<string, unknown>;
  if (obj.jsonrpc !== '2.0') {
    return false;
  }

  // 必须有 method 字段（请求/通知）或 result/error 字段（响应）
  const hasMethod = typeof obj.method === 'string';
  const hasResult = 'result' in obj;
  const hasError = 'error' in obj;

  return hasMethod || hasResult || hasError;
}

// ============================================================================
// 错误工具函数
// ============================================================================

/**
 * 创建 JSON-RPC 错误的 Error 对象
 */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }

  /** 解析错误 */
  static parseError(data?: unknown): JsonRpcError {
    return new JsonRpcError(JsonRpcErrorCode.PARSE_ERROR, 'Parse error', data);
  }

  /** 无效请求 */
  static invalidRequest(data?: unknown): JsonRpcError {
    return new JsonRpcError(JsonRpcErrorCode.INVALID_REQUEST, 'Invalid Request', data);
  }

  /** 方法未找到 */
  static methodNotFound(method: string): JsonRpcError {
    return new JsonRpcError(JsonRpcErrorCode.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  /** 无效参数 */
  static invalidParams(data?: unknown): JsonRpcError {
    return new JsonRpcError(JsonRpcErrorCode.INVALID_PARAMS, 'Invalid params', data);
  }

  /** 内部错误 */
  static internalError(data?: unknown): JsonRpcError {
    return new JsonRpcError(JsonRpcErrorCode.INTERNAL_ERROR, 'Internal error', data);
  }

  /** 转换为 JSON-RPC 错误响应 */
  toResponse(id: number | null): JsonRpcErrorResponse {
    return createErrorResponse(id, this.code, this.message, this.data);
  }
}

/**
 * 重置消息 ID 计数器（用于测试）
 */
export function resetIdCounter(): void {
  nextId = 0;
}
