/**
 * JSON-RPC 2.0 消息构建与解析
 *
 * 提供 JSON-RPC 2.0 消息的构建、解析和验证功能。
 *
 * @module sdk/acp/json-rpc
 * @see Issue #1333
 */

import { AcpErrorCodes, type JsonRpcError, type JsonRpcErrorResponse, type JsonRpcId, type JsonRpcMessage, type JsonRpcRequest, type JsonRpcSuccessResponse } from './types.js';

/**
 * JSON-RPC 消息解析器
 *
 * 处理从传输层接收到的原始字符串数据，支持流式分帧。
 * JSON-RPC over stdio/SSE 使用换行符分隔消息。
 */
export class JsonRpcMessageParser {
  private buffer = '';

  /**
   * 将接收到的原始数据追加到解析缓冲区
   *
   * @param data - 原始字符串数据
   * @returns 解析出的完整 JSON-RPC 消息列表
   */
  feed(data: string): JsonRpcMessage[] {
    this.buffer += data;
    const messages: JsonRpcMessage[] = [];

    // 按换行符分割消息（JSON-RPC over stdio/SSE 使用换行分隔）
    const lines = this.buffer.split('\n');
    // 最后一行可能不完整，保留在 buffer 中
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed);
        const message = validateJsonRpcMessage(parsed);
        if (message) {
          messages.push(message);
        }
      } catch {
        // 无效 JSON，跳过（日志由调用者处理）
      }
    }

    return messages;
  }

  /**
   * 重置解析器状态
   */
  reset(): void {
    this.buffer = '';
  }
}

/**
 * 构建 JSON-RPC 2.0 请求
 *
 * @param method - 方法名
 * @param params - 参数
 * @param id - 请求 ID
 * @returns JSON-RPC 请求对象
 */
export function createRequest(method: string, params?: unknown, id?: JsonRpcId): JsonRpcRequest {
  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    method,
  };
  if (params !== undefined) {
    request.params = params;
  }
  if (id !== undefined) {
    request.id = id;
  }
  return request;
}

/**
 * 构建 JSON-RPC 2.0 成功响应
 *
 * @param id - 对应请求的 ID
 * @param result - 结果数据
 * @returns JSON-RPC 成功响应
 */
export function createSuccessResponse(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return {
    jsonrpc: '2.0',
    result,
    id,
  };
}

/**
 * 构建 JSON-RPC 2.0 错误响应
 *
 * @param id - 对应请求的 ID（解析错误时为 null）
 * @param code - 错误码
 * @param message - 错误消息
 * @param data - 附加数据
 * @returns JSON-RPC 错误响应
 */
export function createErrorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcErrorResponse {
  const error: JsonRpcError = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return {
    jsonrpc: '2.0',
    error,
    id,
  };
}

/**
 * 序列化 JSON-RPC 消息为字符串
 *
 * @param message - JSON-RPC 消息
 * @returns 换行符结尾的 JSON 字符串
 */
export function serializeMessage(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * 验证并规范化 JSON-RPC 消息
 *
 * @param raw - 原始解析结果
 * @returns 规范化后的 JSON-RPC 消息，或 null（如果无效）
 */
export function validateJsonRpcMessage(raw: unknown): JsonRpcMessage | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }

  const obj = raw as Record<string, unknown>;

  // 必须包含 jsonrpc: "2.0"
  if (obj.jsonrpc !== '2.0') {
    return null;
  }

  // 判断是请求还是响应
  if ('method' in obj && typeof obj.method === 'string') {
    // 请求或通知
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method: obj.method as string,
    };
    if ('params' in obj) {
      request.params = obj.params;
    }
    if ('id' in obj && (typeof obj.id === 'string' || typeof obj.id === 'number')) {
      request.id = obj.id as JsonRpcId;
    }
    return request;
  }

  if ('result' in obj || 'error' in obj) {
    // 响应
    if ('error' in obj) {
      const err = obj.error as Record<string, unknown>;
      if (typeof err.code !== 'number' || typeof err.message !== 'string') {
        return null;
      }
      const errorObj: JsonRpcError = { code: err.code, message: err.message };
      if ('data' in err) {
        errorObj.data = err.data;
      }
      const errorResponse: JsonRpcErrorResponse = {
        jsonrpc: '2.0',
        error: errorObj,
        id: ('id' in obj ? obj.id : null) as JsonRpcId | null,
      };
      return errorResponse;
    }

    const successResponse: JsonRpcSuccessResponse = {
      jsonrpc: '2.0',
      result: obj.result,
      id: obj.id as JsonRpcId,
    };
    return successResponse;
  }

  return null;
}

/**
 * 判断 JSON-RPC 消息是否为错误响应
 */
export function isErrorResponse(response: JsonRpcMessage): response is JsonRpcErrorResponse {
  return 'jsonrpc' in response && 'error' in response && !('method' in response);
}

/**
 * 从 JSON-RPC 错误响应中提取错误信息
 */
export function extractError(response: JsonRpcErrorResponse): { code: number; message: string; data?: unknown } {
  return {
    code: response.error.code,
    message: response.error.message,
    data: response.error.data,
  };
}

/**
 * 创建标准 ACP 错误响应
 */
export function createAcpError(
  id: JsonRpcId | null,
  code: (typeof AcpErrorCodes)[keyof typeof AcpErrorCodes],
  message: string
): JsonRpcErrorResponse {
  return createErrorResponse(id, code, message);
}
