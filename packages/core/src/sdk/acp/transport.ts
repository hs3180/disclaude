/**
 * ACP 传输层抽象
 *
 * 提供传输层的抽象接口和 stdio 传输实现。
 * stdio 传输通过子进程的 stdin/stdout 进行 JSON-RPC 消息通信，
 * 使用 newline-delimited JSON (NDJSON) 协议。
 *
 * Issue #1333: 支持OpenAI Agent - PR A (ACP 协议基础设施)
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createLogger } from '../../utils/logger.js';
import {
  parseJsonRpcMessage,
  serializeJsonRpcMessage,
  type JsonRpcMessage,
} from './types.js';

const logger = createLogger('AcpTransport');

// ============================================================================
// 传输层接口
// ============================================================================

/**
 * ACP 传输层接口
 *
 * 定义了传输层必须实现的方法，支持 stdio 和 SSE 两种传输方式。
 */
export interface IAcpTransport {
  /** 连接名称（用于日志） */
  readonly name: string;

  /** 是否已连接 */
  readonly connected: boolean;

  /** 连接传输层 */
  connect(): Promise<void>;

  /** 发送 JSON-RPC 消息 */
  send(message: JsonRpcMessage): Promise<void>;

  /** 注册消息处理器 */
  onMessage(handler: (message: JsonRpcMessage) => void): void;

  /** 注册错误处理器 */
  onError(handler: (error: Error) => void): void;

  /** 注册关闭处理器 */
  onClose(handler: () => void): void;

  /** 断开连接 */
  disconnect(): Promise<void>;
}

// ============================================================================
// stdio 传输实现
// ============================================================================

/**
 * stdio 传输层实现
 *
 * 通过子进程的 stdin/stdout 进行 JSON-RPC 2.0 消息通信。
 * 每行一个 JSON 消息（newline-delimited JSON）。
 */
export class StdioTransport implements IAcpTransport {
  readonly name: string;
  private process: ChildProcess | null = null;
  private _connected = false;
  private buffer = '';
  private messageHandlers: Array<(message: JsonRpcMessage) => void> = [];
  private errorHandlers: Array<(error: Error) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private readonly command: string;
  private readonly args: string[];
  private readonly env: Record<string, string>;

  constructor(config: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    name?: string;
  }) {
    this.command = config.command;
    this.args = config.args ?? [];
    this.env = config.env ?? {};
    this.name = config.name ?? `stdio:${config.command}`;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    if (this._connected) {
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        const mergedEnv = { ...process.env, ...this.env } as Record<string, string>;

        this.process = spawn(this.command, this.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: mergedEnv,
        });

        const proc = this.process;

        proc.stdout?.on('data', (data: Buffer) => {
          this.handleData(data.toString());
        });

        proc.stderr?.on('data', (data: Buffer) => {
          logger.warn({ stderr: data.toString().trim() }, 'Process stderr');
        });

        proc.on('error', (error: Error) => {
          logger.error({ err: error }, 'Process error');
          this._connected = false;
          this.notifyError(error);
          reject(error);
        });

        proc.on('close', (code: number | null) => {
          logger.info({ code }, 'Process closed');
          this._connected = false;
          this.notifyClose();
        });

        proc.on('spawn', () => {
          this._connected = true;
          logger.info(
            { command: this.command, args: this.args },
            'Process spawned',
          );
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this._connected || !this.process?.stdin) {
      throw new Error('Transport not connected');
    }

    const serialized = serializeJsonRpcMessage(message);
    return new Promise((resolve, reject) => {
      const ok = this.process!.stdin!.write(serialized + '\n', (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });

      if (!ok) {
        // Back-pressure: wait for drain event
        this.process!.stdin!.once('drain', () => resolve());
      }
    });
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  async disconnect(): Promise<void> {
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      this._connected = false;
    }
  }

  // ==========================================================================
  // 内部方法
  // ==========================================================================

  /**
   * 处理接收到的数据
   *
   * 使用 newline-delimited JSON 协议，
   * 支持缓冲不完整的消息行。
   */
  private handleData(data: string): void {
    this.buffer += data;

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        continue;
      }

      try {
        const message = parseJsonRpcMessage(line);
        this.notifyMessage(message);
      } catch (error) {
        logger.error({ line, err: error }, 'Failed to parse message');
        this.notifyError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  private notifyMessage(message: JsonRpcMessage): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (error) {
        logger.error({ err: error }, 'Message handler error');
      }
    }
  }

  private notifyError(error: Error): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch (handlerError) {
        logger.error({ err: handlerError }, 'Error handler error');
      }
    }
  }

  private notifyClose(): void {
    for (const handler of this.closeHandlers) {
      try {
        handler();
      } catch (error) {
        logger.error({ err: error }, 'Close handler error');
      }
    }
  }
}
