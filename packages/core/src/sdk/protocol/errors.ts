/**
 * ACP 协议错误类型
 *
 * @see Issue #1333 - 支持OpenAI Agent
 */

import type { ACPErrorCode } from './types.js';

/**
 * ACP 协议错误
 *
 * 表示与 ACP 服务器通信或协议处理过程中发生的错误。
 */
export class ACPProtocolError extends Error {
  /** ACP 错误码 */
  readonly code: ACPErrorCode;
  /** HTTP 状态码 */
  readonly statusCode: number;
  /** 错误详情数据 */
  readonly data?: Record<string, unknown>;

  constructor(
    message: string,
    code: ACPErrorCode = 'server_error',
    statusCode: number = 500,
    data?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ACPProtocolError';
    this.code = code;
    this.statusCode = statusCode;
    this.data = data;
  }

  /**
   * 从 HTTP 响应创建 ACPProtocolError
   */
  static fromResponse(statusCode: number, body: unknown): ACPProtocolError {
    if (typeof body === 'object' && body !== null) {
      const parsed = body as Record<string, unknown>;
      const code = isValidErrorCode(parsed.code) ? parsed.code : 'server_error';
      const message = typeof parsed.message === 'string'
        ? parsed.message
        : `ACP request failed with status ${statusCode}`;

      return new ACPProtocolError(message, code, statusCode, parsed.data as Record<string, unknown>);
    }

    return new ACPProtocolError(
      `ACP request failed with status ${statusCode}`,
      'server_error',
      statusCode
    );
  }
}

/**
 * ACP 连接错误
 *
 * 表示无法连接到 ACP 服务器。
 */
export class ACPConnectionError extends Error {
  /** 服务器 URL */
  readonly url: string;
  /** 底层错误 */
  readonly cause?: Error;

  constructor(url: string, cause?: Error) {
    super(`Failed to connect to ACP server at ${url}`);
    this.name = 'ACPConnectionError';
    this.url = url;
    this.cause = cause;
  }
}

/**
 * ACP 超时错误
 *
 * 表示请求超时。
 */
export class ACPTimeoutError extends Error {
  /** 超时时间（毫秒） */
  readonly timeoutMs: number;

  constructor(timeoutMs: number, operation: string = 'request') {
    super(`ACP ${operation} timed out after ${timeoutMs}ms`);
    this.name = 'ACPTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * 验证是否为有效的 ACP 错误码
 */
function isValidErrorCode(code: unknown): code is ACPErrorCode {
  return typeof code === 'string' && ['server_error', 'invalid_input', 'not_found'].includes(code);
}
