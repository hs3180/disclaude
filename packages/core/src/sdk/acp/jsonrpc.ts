/**
 * JSON-RPC 2.0 消息类型和工具函数
 *
 * 提供 JSON-RPC 2.0 协议的类型定义和消息构造/解析工具，
 * 作为 ACP 协议的可选传输编码层。
 *
 * @see https://www.jsonrpc.org/specification
 * @see Issue #1333 - 支持OpenAI Agent
 * @module sdk/acp/jsonrpc
 */

import { randomUUID } from 'node:crypto';

// ============================================================================
// JSON-RPC 2.0 类型定义
// ============================================================================

/** JSON-RPC 2.0 请求（通知无 id） */
export interface JsonRpcRequest {
  /** JSON-RPC 版本，固定为 "2.0" */
  jsonrpc: '2.0';
  /** 方法名 */
  method: string;
  /** 参数（位置参数为数组，命名参数为对象） */
  params?: unknown;
  /** 请求 ID（通知时省略） */
  id?: string | number | null;
}

/** JSON-RPC 2.0 成功响应 */
export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  /** 对应请求的 ID */
  id: string | number | null;
  result: unknown;
}

/** JSON-RPC 2.0 错误对象 */
export interface JsonRpcError {
  /** 错误码 */
  code: number;
  /** 错误消息 */
  message: string;
  /** 附加数据 */
  data?: unknown;
}

/** JSON-RPC 2.0 错误响应 */
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  error: JsonRpcError;
}

/** JSON-RPC 2.0 响应联合类型 */
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/** JSON-RPC 2.0 消息联合类型 */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse;

// ============================================================================
// 预定义错误码
// ============================================================================

/** JSON-RPC 2.0 标准错误码 */
export const JsonRpcErrorCode = {
  /** 解析错误：服务端收到无效 JSON */
  PARSE_ERROR: -32700,
  /** 无效请求：发送的 JSON 不是一个有效的请求对象 */
  INVALID_REQUEST: -32600,
  /** 方法不存在 */
  METHOD_NOT_FOUND: -32601,
  /** 无效参数 */
  INVALID_PARAMS: -32602,
  /** 内部 JSON-RPC 错误 */
  INTERNAL_ERROR: -32603,
  /** 服务器错误（-32000 ~ -32099） */
  SERVER_ERROR: -32000,
} as const;

// ============================================================================
// ACP 方法名常量
// ============================================================================

/** ACP over JSON-RPC 方法名 */
export const AcpJsonRpcMethod = {
  /** 健康检查 */
  PING: 'acp.ping',
  /** 列出所有 Agent */
  LIST_AGENTS: 'acp.listAgents',
  /** 获取 Agent Manifest */
  GET_AGENT: 'acp.getAgent',
  /** 创建并执行 Run */
  CREATE_RUN: 'acp.createRun',
  /** 获取 Run 状态 */
  GET_RUN: 'acp.getRun',
  /** 恢复暂停的 Run */
  RESUME_RUN: 'acp.resumeRun',
  /** 取消 Run */
  CANCEL_RUN: 'acp.cancelRun',
  /** 获取 Run 事件列表 */
  GET_RUN_EVENTS: 'acp.getRunEvents',
  /** 获取会话信息 */
  GET_SESSION: 'acp.getSession',
} as const;

// ============================================================================
// 消息构造工具
// ============================================================================

/**
 * 创建 JSON-RPC 2.0 请求
 *
 * @param method - 方法名
 * @param params - 参数
 * @param id - 请求 ID（默认自动生成 UUID）
 */
export function createRequest(
  method: string,
  params?: unknown,
  id?: string
): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    method,
    params,
    id: id ?? randomUUID(),
  };
}

/**
 * 创建 JSON-RPC 2.0 通知（无 id，不期望响应）
 *
 * @param method - 方法名
 * @param params - 参数
 */
export function createNotification(
  method: string,
  params?: unknown
): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    method,
    params,
  };
}

/**
 * 创建 JSON-RPC 2.0 成功响应
 *
 * @param id - 对应请求的 ID
 * @param result - 结果数据
 */
export function createSuccessResponse(
  id: string | number | null,
  result: unknown
): JsonRpcSuccessResponse {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

/**
 * 创建 JSON-RPC 2.0 错误响应
 *
 * @param id - 对应请求的 ID
 * @param code - 错误码
 * @param message - 错误消息
 * @param data - 附加数据
 */
export function createErrorResponse(
  id: string | number | null,
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
// 消息解析工具
// ============================================================================

/**
 * 判断 JSON-RPC 消息是否为请求
 */
export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'method' in message && !('result' in message) && !('error' in message);
}

/**
 * 判断 JSON-RPC 消息是否为通知
 */
export function isNotification(message: JsonRpcMessage): boolean {
  return isRequest(message) && message.id === undefined;
}

/**
 * 判断 JSON-RPC 消息是否为成功响应
 */
export function isSuccessResponse(
  message: JsonRpcMessage
): message is JsonRpcSuccessResponse {
  return 'result' in message && 'id' in message && !('method' in message);
}

/**
 * 判断 JSON-RPC 消息是否为错误响应
 */
export function isErrorResponse(
  message: JsonRpcMessage
): message is JsonRpcErrorResponse {
  return 'error' in message && 'id' in message && !('method' in message);
}

/**
 * 验证 JSON-RPC 2.0 消息的基本结构
 *
 * @param data - 待验证的数据
 * @returns 验证结果
 */
export function validateMessage(data: unknown): {
  valid: boolean;
  error?: string;
} {
  if (typeof data !== 'object' || data === null) {
    return { valid: false, error: 'Message must be an object' };
  }

  const msg = data as Record<string, unknown>;

  if (msg.jsonrpc !== '2.0') {
    return { valid: false, error: 'jsonrpc must be "2.0"' };
  }

  // 请求或通知
  if ('method' in msg) {
    if (typeof msg.method !== 'string') {
      return { valid: false, error: 'method must be a string' };
    }
    return { valid: true };
  }

  // 响应
  if ('result' in msg || 'error' in msg) {
    if (!('id' in msg)) {
      return { valid: false, error: 'Response must have an id' };
    }
    if ('error' in msg) {
      const err = msg.error as Record<string, unknown>;
      if (typeof err.code !== 'number' || typeof err.message !== 'string') {
        return { valid: false, error: 'Error must have numeric code and string message' };
      }
    }
    return { valid: true };
  }

  return { valid: false, error: 'Message must have method, result, or error' };
}
