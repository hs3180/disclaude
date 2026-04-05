/**
 * JSON-RPC 2.0 消息类型与工具函数
 *
 * ACP 协议基于 JSON-RPC 2.0 规范，本模块定义了请求、响应、通知和错误的标准类型，
 * 以及用于构建和解析 JSON-RPC 消息的工具函数。
 *
 * @see https://www.jsonrpc.org/specification
 * @module acp/json-rpc
 */

// ============================================================================
// JSON-RPC 2.0 基础类型
// ============================================================================

/** JSON-RPC 请求 ID 类型 */
export type JsonRpcId = string | number | null;

/** JSON-RPC 错误码（保留值） */
export enum JsonRpcErrorCode {
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
}

/** JSON-RPC 错误对象 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** JSON-RPC 请求 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

/** JSON-RPC 通知（无 id，不期望响应） */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/** JSON-RPC 成功响应 */
export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

/** JSON-RPC 错误响应 */
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcError;
}

/** JSON-RPC 响应联合类型 */
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/** JSON-RPC 消息联合类型 */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ============================================================================
// 类型守卫
// ============================================================================

/** 检查消息是否为 JSON-RPC 请求（有 id 字段且有 method） */
export function isJsonRpcRequest(msg: unknown): msg is JsonRpcRequest {
  return (
    typeof msg === 'object' && msg !== null &&
    (msg as Record<string, unknown>).jsonrpc === '2.0' &&
    typeof (msg as Record<string, unknown>).method === 'string' &&
    'id' in msg
  );
}

/** 检查消息是否为 JSON-RPC 通知（无 id 字段但有 method） */
export function isJsonRpcNotification(msg: unknown): msg is JsonRpcNotification {
  return (
    typeof msg === 'object' && msg !== null &&
    (msg as Record<string, unknown>).jsonrpc === '2.0' &&
    typeof (msg as Record<string, unknown>).method === 'string' &&
    !('id' in msg)
  );
}

/** 检查消息是否为 JSON-RPC 响应（有 id 字段且有 result 或 error） */
export function isJsonRpcResponse(msg: unknown): msg is JsonRpcResponse {
  return (
    typeof msg === 'object' && msg !== null &&
    (msg as Record<string, unknown>).jsonrpc === '2.0' &&
    'id' in msg &&
    ('result' in msg || 'error' in msg)
  );
}

/** 检查 JSON-RPC 响应是否为错误响应 */
export function isJsonRpcErrorResponse(
  response: JsonRpcResponse
): response is JsonRpcErrorResponse {
  return 'error' in response;
}

// ============================================================================
// 消息构建工具
// ============================================================================

/** 请求 ID 计数器 */
let nextId = 1;

/**
 * 生成唯一的请求 ID
 *
 * @returns 递增的数字 ID
 */
export function generateId(): number {
  return nextId++;
}

/**
 * 重置请求 ID 计数器（用于测试）
 */
export function resetIdCounter(): void {
  nextId = 1;
}

/**
 * 构建 JSON-RPC 请求
 *
 * @param method - 方法名
 * @param params - 参数（可选）
 * @param id - 请求 ID（可选，默认自动生成）
 * @returns JSON-RPC 请求对象
 */
export function createRequest(
  method: string,
  params?: unknown,
  id?: JsonRpcId
): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id: id ?? generateId(),
    method,
    params,
  };
}

/**
 * 构建 JSON-RPC 通知
 *
 * @param method - 方法名
 * @param params - 参数（可选）
 * @returns JSON-RPC 通知对象
 */
export function createNotification(
  method: string,
  params?: unknown
): JsonRpcNotification {
  return {
    jsonrpc: '2.0',
    method,
    params,
  };
}

/**
 * 构建 JSON-RPC 成功响应
 *
 * @param id - 请求 ID
 * @param result - 结果数据
 * @returns JSON-RPC 成功响应对象
 */
export function createSuccessResponse(
  id: JsonRpcId,
  result: unknown
): JsonRpcSuccessResponse {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

/**
 * 构建 JSON-RPC 错误响应
 *
 * @param id - 请求 ID
 * @param code - 错误码
 * @param message - 错误消息
 * @param data - 附加数据（可选）
 * @returns JSON-RPC 错误响应对象
 */
export function createErrorResponse(
  id: JsonRpcId,
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

// ============================================================================
// 消息解析与序列化
// ============================================================================

/**
 * 解析 JSON-RPC 消息
 *
 * 将原始字符串解析为 JSON-RPC 消息对象。
 *
 * @param data - 原始 JSON 字符串
 * @returns 解析后的 JSON-RPC 消息
 * @throws 如果 JSON 格式无效
 */
export function parseMessage(data: string): JsonRpcMessage {
  const parsed = JSON.parse(data);

  if (typeof parsed !== 'object' || parsed === null || parsed.jsonrpc !== '2.0') {
    throw new Error('Invalid JSON-RPC message: missing "jsonrpc": "2.0" field');
  }

  return parsed as JsonRpcMessage;
}

/**
 * 序列化 JSON-RPC 消息
 *
 * 将 JSON-RPC 消息对象序列化为字符串（单行 JSON + 换行符）。
 * 换行符作为消息分隔符，用于 stdio 传输。
 *
 * @param message - JSON-RPC 消息
 * @returns 序列化后的字符串（含尾部换行符）
 */
export function serializeMessage(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}
