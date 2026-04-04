/**
 * ACP 传输层
 *
 * 提供 ACP 协议的传输抽象和实现，支持 stdio 和 SSE 两种传输方式。
 *
 * - StdioTransport: 通过子进程的 stdin/stdout 进行 JSON-RPC 通信
 * - SSETransport: 通过 Server-Sent Events 进行 JSON-RPC 通信
 *
 * @module acp/transport
 * @see Issue #1333 - 支持OpenAI Agent via ACP
 */

import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import type { JsonRpcMessage, AcpTransportConfig, AcpStdioConfig, AcpSseConfig } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AcpTransport');

// ============================================================================
// 传输层接口
// ============================================================================

/**
 * ACP 传输层接口
 *
 * 所有传输实现（stdio、SSE 等）都需要实现此接口。
 */
export interface AcpTransport {
  /** 发送 JSON-RPC 消息 */
  send(message: JsonRpcMessage): Promise<void>;
  /** 接收 JSON-RPC 消息回调 */
  onMessage(callback: (message: JsonRpcMessage) => void): void;
  /** 连接是否活跃 */
  readonly connected: boolean;
  /** 关闭连接 */
  close(): Promise<void>;
  /** 注册事件监听（close, error） */
  on(event: string, handler: (...args: unknown[]) => void): void;
}

// ============================================================================
// StdioTransport
// ============================================================================

/**
 * stdio 传输层
 *
 * 通过子进程的 stdin/stdout 进行 JSON-RPC 通信。
 * 每行一个 JSON 消息（newline-delimited JSON）。
 */
export class StdioTransport extends EventEmitter implements AcpTransport {
  private process: ChildProcess | null = null;
  private _connected = false;
  private messageCallback: ((message: JsonRpcMessage) => void) | null = null;
  private buffer = '';

  /**
   * 创建 stdio 传输层
   *
   * @param config - stdio 传输配置
   */
  constructor(private readonly config: AcpStdioConfig) {
    super();
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * 启动子进程并建立连接
   */
  connect(): Promise<void> {
    if (this._connected) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const proc = spawn(this.config.command, this.config.args ?? [], {
        env: { ...process.env, ...this.config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.process = proc;

      proc.stdout?.on('data', (data: Buffer) => {
        this.handleData(data.toString());
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text) {
          logger.warn({ stderr: text }, 'Process stderr output');
        }
      });

      proc.on('error', (err) => {
        logger.error({ err, command: this.config.command }, 'Process error');
        this._connected = false;
        this.emit('error', err);
        reject(err);
      });

      proc.on('close', (code) => {
        logger.info({ code }, 'Process closed');
        this._connected = false;
        this.emit('close');
      });

      // 等待进程启动
      proc.on('spawn', () => {
        this._connected = true;
        logger.info(
          { command: this.config.command, args: this.config.args },
          'Process started'
        );
        resolve();
      });

      // 超时保护
      setTimeout(() => {
        if (!this._connected) {
          reject(new Error(`Process failed to start within timeout: ${this.config.command}`));
        }
      }, 30000);
    });
  }

  send(message: JsonRpcMessage): Promise<void> {
    if (!this._connected || !this.process?.stdin) {
      return Promise.reject(new Error('Transport not connected'));
    }

    const json = `${JSON.stringify(message)}\n`;

    return new Promise<void>((resolve, reject) => {
      const stdin = this.process?.stdin;
      if (!stdin) {
        reject(new Error('Transport not connected'));
        return;
      }
      const written = stdin.write(json, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });

      // Handle backpressure
      if (!written) {
        stdin.once('drain', () => {
          resolve();
        });
      }
    });
  }

  onMessage(callback: (message: JsonRpcMessage) => void): void {
    this.messageCallback = callback;
  }

  close(): Promise<void> {
    this._connected = false;
    this.messageCallback = null;
    this.buffer = '';

    if (this.process) {
      const proc = this.process;
      this.process = null;

      return new Promise<void>((resolve) => {
        // Kill the process
        proc.kill('SIGTERM');

        // Force kill after timeout
        const forceKillTimer = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, 5000);

        proc.on('exit', () => {
          clearTimeout(forceKillTimer);
          resolve();
        });
      });
    }

    return Promise.resolve();
  }

  /**
   * 处理从 stdout 读取的数据
   *
   * 支持 newline-delimited JSON 格式。
   */
  private handleData(data: string): void {
    this.buffer += data;

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      try {
        const message = JSON.parse(line) as JsonRpcMessage;
        this.messageCallback?.(message);
      } catch (err) {
        logger.warn({ line, err }, 'Failed to parse JSON-RPC message');
      }
    }
  }
}

// ============================================================================
// SSETransport
// ============================================================================

/**
 * SSE 传输层
 *
 * 通过 Server-Sent Events (SSE) 进行 JSON-RPC 通信。
 * 接收通过 SSE event stream，发送通过 HTTP POST。
 */
export class SSETransport extends EventEmitter implements AcpTransport {
  private abortController: AbortController | null = null;
  private eventSource: EventSource | null = null;
  private _connected = false;
  private messageCallback: ((message: JsonRpcMessage) => void) | null = null;

  /**
   * 创建 SSE 传输层
   *
   * @param config - SSE 传输配置
   */
  constructor(private readonly config: AcpSseConfig) {
    super();
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * 建立 SSE 连接
   */
  connect(): Promise<void> {
    if (this._connected) {
      return Promise.resolve();
    }

    this.abortController = new AbortController();
    const { signal } = this.abortController;

    return new Promise<void>((resolve, reject) => {
      if (typeof EventSource === 'undefined') {
        reject(new Error('EventSource is not available in this environment'));
        return;
      }

      const eventSource = new EventSource(this.config.url);
      this.eventSource = eventSource;

      eventSource.onopen = () => {
        this._connected = true;
        logger.info({ url: this.config.url }, 'SSE connection established');
        resolve();
      };

      eventSource.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as JsonRpcMessage;
          this.messageCallback?.(message);
        } catch (err) {
          logger.warn({ data: event.data, err }, 'Failed to parse SSE message');
        }
      };

      eventSource.onerror = () => {
        const errMsg = 'SSE connection error';
        if (!this._connected) {
          reject(new Error(errMsg));
        } else {
          logger.error({}, errMsg);
          this._connected = false;
          this.emit('error', new Error(errMsg));
        }
      };

      // Abort signal handling
      signal.addEventListener('abort', () => {
        eventSource.close();
        this._connected = false;
      });
    });
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this._connected) {
      throw new Error('Transport not connected');
    }

    const response = await fetch(this.config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.config.headers,
      },
      body: JSON.stringify(message),
      signal: this.abortController?.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  }

  onMessage(callback: (message: JsonRpcMessage) => void): void {
    this.messageCallback = callback;
  }

  close(): Promise<void> {
    this._connected = false;
    this.messageCallback = null;

    this.abortController?.abort();
    this.abortController = null;

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    return Promise.resolve();
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 ACP 传输层
 *
 * 根据配置类型创建对应的传输层实例。
 *
 * @param config - 传输配置
 * @returns 传输层实例
 */
export function createTransport(config: AcpTransportConfig): AcpTransport {
  switch (config.type) {
    case 'stdio':
      return new StdioTransport(config);
    case 'sse':
      return new SSETransport(config);
    default:
      throw new Error(`Unknown transport type: ${(config as { type: string }).type}`);
  }
}
