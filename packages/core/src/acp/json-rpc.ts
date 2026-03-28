/**
 * JSON-RPC 2.0 消息格式实现
 *
 * 提供 JSON-RPC 2.0 消息的创建、解析和验证功能。
 * 基于 JSON-RPC 2.0 规范: https://www.jsonrpc.org/specification
 *
 * @module acp/json-rpc
 * Related: Issue #1333
 */

import { v4 as uuidv4 } from 'uuid';
import { AcpErrorCode } from './types.js';

// ============================================================================
// JSON-RPC 2.0 类型定义
// ============================================================================

/** JSON-RPC 版本标识 */
const JSONRPC_VERSION = '2.0' as const;

/** JSON-RPC 2.0 请求 */
export interface JsonRpcRequest<T = unknown> {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: T;
}

/** JSON-RPC 2.0 通知（无 id 字段，不期望响应） */
export interface JsonRpcNotification<T = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: T;
}

/** JSON-RPC 2.0 成功响应 */
export interface JsonRpcSuccessResponse<T = unknown> {
  jsonrpc: '2.0';
  id: string;
  result: T;
}

/** JSON-RPC 2.0 错误对象 */
export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** JSON-RPC 2.0 错误响应 */
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: string | null;
  error: JsonRpcErrorObject;
}

/** JSON-RPC 2.0 消息联合类型 */
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

/** JSON-RPC 2.0 批量消息 */
export type JsonRpcBatch = JsonRpcMessage[];

// ============================================================================
// 消息创建
// ============================================================================

/**
 * 创建 JSON-RPC 请求
 *
 * @param method - 方法名
 * @param params - 参数（可选）
 * @param id - 请求 ID（可选，默认自动生成 UUID）
 */
export function createRequest<T = unknown>(
  method: string,
  params?: T,
  id?: string,
): JsonRpcRequest<T> {
  return {
    jsonrpc: JSONRPC_VERSION,
    id: id ?? uuidv4(),
    method,
    params,
  };
}

/**
 * 创建 JSON-RPC 通知
 *
 * 通知没有 id 字段，服务端不需要响应。
 *
 * @param method - 方法名
 * @param params - 参数（可选）
 */
export function createNotification<T = unknown>(
  method: string,
  params?: T,
): JsonRpcNotification<T> {
  return {
    jsonrpc: JSONRPC_VERSION,
    method,
    params,
  };
}

/**
 * 创建 JSON-RPC 成功响应
 *
 * @param id - 对应请求的 ID
 * @param result - 结果数据
 */
export function createSuccessResponse<T = unknown>(
  id: string,
  result: T,
): JsonRpcSuccessResponse<T> {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    result,
  };
}

/**
 * 创建 JSON-RPC 错误响应
 *
 * @param id - 对应请求的 ID（错误通知时为 null）
 * @param code - 错误码
 * @param message - 错误消息
 * @param data - 附加数据（可选）
 */
export function createErrorResponse(
  id: string | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message, data },
  };
}

/**
 * 创建标准 ACP 错误响应
 *
 * @param errorCode - ACP 错误码枚举
 * @param id - 请求 ID（可选）
 * @param data - 附加数据（可选）
 */
export function createStandardError(
  errorCode: AcpErrorCode,
  id?: string | null,
  data?: unknown,
): JsonRpcErrorResponse {
  const errorKey = String(AcpErrorCode[errorCode] ?? 'UnknownError');
  return createErrorResponse(id ?? null, errorCode, errorKey, data);
}

// ============================================================================
// 消息验证与解析
// ============================================================================

/** 验证结果 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/** 解析结果 */
export type ParseResult =
  | { valid: true; message: JsonRpcMessage }
  | { valid: true; batch: JsonRpcBatch }
  | { valid: false; error: string };

/**
 * 验证 JSON-RPC 2.0 消息
 *
 * @param msg - 待验证的消息对象
 */
export function validateMessage(msg: unknown): ValidationResult {
  if (typeof msg !== 'object' || msg === null) {
    return { valid: false, error: 'Message must be an object' };
  }

  const obj = msg as Record<string, unknown>;

  if (obj.jsonrpc !== '2.0') {
    return { valid: false, error: 'jsonrpc version must be "2.0"' };
  }

  // 请求或通知: 需要 method 字段
  if (typeof obj.method === 'string') {
    if (
      'id' in obj &&
      obj.id !== undefined &&
      obj.id !== null &&
      typeof obj.id !== 'string' &&
      typeof obj.id !== 'number'
    ) {
      return { valid: false, error: 'id must be a string, number, or null' };
    }
    if ('result' in obj || 'error' in obj) {
      return {
        valid: false,
        error: 'Request/Notification must not have "result" or "error"',
      };
    }
    return { valid: true };
  }

  // 响应: 需要有 id 和 result 或 error
  if ('id' in obj && ('result' in obj || 'error' in obj)) {
    if (obj.result !== undefined && obj.error !== undefined) {
      return {
        valid: false,
        error: 'Response must not have both "result" and "error"',
      };
    }
    if (obj.error !== undefined) {
      const err = obj.error as Record<string, unknown>;
      if (typeof err.code !== 'number' || typeof err.message !== 'string') {
        return {
          valid: false,
          error: 'Error must have numeric "code" and string "message"',
        };
      }
    }
    return { valid: true };
  }

  return {
    valid: false,
    error:
      'Message must have "method" (request/notification) or "id" + "result"/"error" (response)',
  };
}

/**
 * 判断消息是否为通知
 */
export function isNotification(
  msg: JsonRpcMessage,
): msg is JsonRpcNotification {
  return 'method' in msg && !('id' in msg);
}

/**
 * 判断消息是否为请求
 */
export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'method' in msg && 'id' in msg;
}

/**
 * 判断消息是否为响应（成功或错误）
 */
export function isResponse(
  msg: JsonRpcMessage,
): msg is JsonRpcSuccessResponse | JsonRpcErrorResponse {
  return 'result' in msg || 'error' in msg;
}

/**
 * 判断消息是否为错误响应
 */
export function isErrorResponse(msg: JsonRpcMessage): msg is JsonRpcErrorResponse {
  return 'error' in msg;
}

/**
 * 判断消息是否为成功响应
 */
export function isSuccessResponse(
  msg: JsonRpcMessage,
): msg is JsonRpcSuccessResponse {
  return 'result' in msg;
}

/**
 * 从 JSON 字符串解析 JSON-RPC 消息
 *
 * 支持单条消息和批量消息。
 *
 * @param json - JSON 字符串
 */
export function parseMessage(json: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { valid: false, error: 'Invalid JSON' };
  }

  // 批量消息
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return { valid: false, error: 'Empty batch is not allowed' };
    }
    const batch: JsonRpcBatch = [];
    for (const item of parsed) {
      const result = validateMessage(item);
      if (!result.valid) {
        return { valid: false, error: `Invalid message in batch: ${result.error}` };
      }
      batch.push(item as JsonRpcMessage);
    }
    return { valid: true, batch };
  }

  // 单条消息
  const result = validateMessage(parsed);
  if (!result.valid) {
    return { valid: false, error: result.error! };
  }
  return { valid: true, message: parsed as JsonRpcMessage };
}

/**
 * 将 JSON-RPC 消息序列化为 JSON 字符串
 *
 * @param msg - JSON-RPC 消息或批量消息
 */
export function serializeMessage(
  msg: JsonRpcMessage | JsonRpcBatch,
): string {
  return JSON.stringify(msg);
}
