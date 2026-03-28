/**
 * ACP 传输层
 *
 * 提供 ACP 协议的传输抽象，支持 stdio 和 SSE 两种传输方式。
 *
 * - **stdio**: 通过子进程的 stdin/stdout 进行通信，适用于本地 ACP Server
 * - **sse**: 通过 Server-Sent Events 进行通信，适用于远程 ACP Server
 *
 * @module acp/transport
 * Related: Issue #1333
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { serializeMessage, parseMessage, type JsonRpcMessage } from './json-rpc.js';
import type { AcpConnectionConfig } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AcpTransport');

// ============================================================================
// 传输接口
// ============================================================================

/** 消息处理器 */
export type MessageHandler = (message: JsonRpcMessage) => void;

/** 错误处理器 */
export type ErrorHandler = (error: Error) => void;

/** 传输状态 */
export type TransportState = 'disconnected' | 'connecting' | 'connected' | 'closed';

/** 传输接口 */
export interface AcpTransport {
  /** 当前状态 */
  readonly state: TransportState;
  /** 建立连接 */
  connect(): Promise<void>;
  /** 发送消息 */
  send(message: JsonRpcMessage): void;
  /** 注册消息处理器 */
  onMessage(handler: MessageHandler): void;
  /** 注册错误处理器 */
  onError(handler: ErrorHandler): void;
  /** 关闭连接 */
  close(): Promise<void>;
}

// ============================================================================
// stdio 传输
// ============================================================================

/**
 * stdio 传输实现
 *
 * 通过启动子进程并使用 stdin/stdout 进行 JSON-RPC 消息通信。
 * 每条消息以换行符分隔（JSON Lines 格式）。
 */
export class StdioTransport implements AcpTransport {
  private config: { command: string; args?: string[]; env?: Record<string, string> };
  private process: ChildProcess | null = null;
  private _state: TransportState = 'disconnected';
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private buffer = '';

  constructor(config: AcpConnectionConfig & { type: 'stdio' }) {
    this.config = { command: config.command, args: config.args, env: config.env };
  }

  get state(): TransportState {
    return this._state;
  }

  /**
   * 启动子进程并建立连接
   */
  async connect(): Promise<void> {
    if (this._state === 'connected') {
      return;
    }
    this._state = 'connecting';

    return new Promise((resolve, reject) => {
      const proc = spawn(this.config.command, this.config.args ?? [], {
        env: { ...process.env, ...this.config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.process = proc;

      proc.stdin?.on('error', (err) => {
        // Handle EPIPE and other stdin errors gracefully
        logger.debug({ err }, 'Process stdin error');
      });

      proc.stdout?.on('data', (data: Buffer) => {
        this.handleData(data.toString());
      });

      proc.stderr?.on('data', (data: Buffer) => {
        logger.debug({ stderr: data.toString() }, 'Process stderr');
      });

      proc.on('error', (err) => {
        this._state = 'disconnected';
        this.notifyError(err);
        reject(err);
      });

      proc.on('close', (code) => {
        const wasConnected = this._state === 'connected';
        this._state = 'closed';
        if (wasConnected) {
          logger.info({ code }, 'Process closed');
        }
      });

      this._state = 'connected';
      resolve();
    });
  }

  /**
   * 通过 stdin 发送 JSON-RPC 消息
   */
  send(message: JsonRpcMessage): void {
    if (this._state !== 'connected' || !this.process?.stdin) {
      throw new Error(`Cannot send message in state: ${this._state}`);
    }

    const json = serializeMessage(message) + '\n';
    // Handle EPIPE when child process has closed stdin
    if (!this.process.stdin.write(json)) {
      logger.warn('stdin buffer full, message may not be sent');
    }
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onError(handler: ErrorHandler): void {
    this.errorHandlers.push(handler);
  }

  async close(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this._state = 'closed';
    this.messageHandlers = [];
    this.errorHandlers = [];
  }

  /**
   * 处理从 stdout 读取的数据
   *
   * 使用缓冲区处理跨 chunk 的消息边界。
   * 消息以换行符分隔（JSON Lines 格式）。
   */
  private handleData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    // 保留最后一个可能不完整的行
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const result = parseMessage(trimmed);
      if (result.valid && 'message' in result) {
        for (const handler of this.messageHandlers) {
          handler(result.message);
        }
      } else if (result.valid && 'batch' in result) {
        for (const msg of result.batch) {
          for (const handler of this.messageHandlers) {
            handler(msg);
          }
        }
      } else {
        logger.warn(
          { error: (result as { valid: false; error: string }).error, line: trimmed },
          'Failed to parse message',
        );
      }
    }
  }

  private notifyError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }
}

// ============================================================================
// SSE 传输
// ============================================================================

/**
 * SSE 传输实现
 *
 * 通过 HTTP POST 发送消息，通过 SSE 接收消息。
 * 适用于远程 ACP Server 部署场景。
 */
export class SseTransport implements AcpTransport {
  private config: { url: string; headers?: Record<string, string> };
  private _state: TransportState = 'disconnected';
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private abortController: AbortController | null = null;

  constructor(config: AcpConnectionConfig & { type: 'sse' }) {
    this.config = { url: config.url, headers: config.headers };
  }

  get state(): TransportState {
    return this._state;
  }

  /**
   * 建立 SSE 连接
   *
   * 使用 fetch API 建立 SSE 连接，读取服务端推送的消息。
   */
  async connect(): Promise<void> {
    if (this._state === 'connected') {
      return;
    }
    this._state = 'connecting';
    this.abortController = new AbortController();

    try {
      const response = await fetch(this.config.url, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          ...this.config.headers,
        },
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('SSE response body is null');
      }

      this._state = 'connected';

      // 异步读取 SSE 流
      this.readSseStream(response.body).catch((err) => {
        if (this._state === 'connected') {
          this.notifyError(err instanceof Error ? err : new Error(String(err)));
        }
      });
    } catch (error) {
      this._state = 'disconnected';
      this.abortController = null;
      throw error;
    }
  }

  /**
   * 通过 HTTP POST 发送消息
   */
  send(message: JsonRpcMessage): void {
    if (this._state !== 'connected') {
      throw new Error(`Cannot send message in state: ${this._state}`);
    }

    const json = serializeMessage(message);

    // 使用 fetch POST 发送消息，不等待响应（fire-and-forget）
    fetch(this.config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.config.headers,
      },
      body: json,
    }).catch((err) => {
      logger.warn({ error: err }, 'Failed to send message via SSE transport');
    });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onError(handler: ErrorHandler): void {
    this.errorHandlers.push(handler);
  }

  async close(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this._state = 'closed';
    this.messageHandlers = [];
    this.errorHandlers = [];
  }

  /**
   * 读取 SSE 流并解析 JSON-RPC 消息
   */
  private async readSseStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // 解析 SSE 事件
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const event of events) {
          const data = this.parseSseEvent(event);
          if (!data) {
            continue;
          }

          const result = parseMessage(data);
          if (result.valid && 'message' in result) {
            for (const handler of this.messageHandlers) {
              handler(result.message);
            }
          } else if (result.valid && 'batch' in result) {
            for (const msg of result.batch) {
              for (const handler of this.messageHandlers) {
                handler(msg);
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
      if (this._state === 'connected') {
        this._state = 'closed';
      }
    }
  }

  /**
   * 解析单个 SSE 事件，提取 data 字段
   */
  private parseSseEvent(event: string): string | null {
    let data = '';
    for (const line of event.split('\n')) {
      if (line.startsWith('data:')) {
        data = line.slice(5).trim();
      }
    }
    return data || null;
  }

  private notifyError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }
}

// ============================================================================
// 传输工厂
// ============================================================================

/**
 * 创建传输实例
 *
 * @param config - 连接配置
 * @returns 对应传输类型的实例
 */
export function createTransport(config: AcpConnectionConfig): AcpTransport {
  switch (config.type) {
    case 'stdio':
      return new StdioTransport(config);
    case 'sse':
      return new SseTransport(config);
    default: {
      const exhaustive: never = config;
      throw new Error(`Unknown transport type: ${(exhaustive as AcpConnectionConfig).type}`);
    }
  }
}
