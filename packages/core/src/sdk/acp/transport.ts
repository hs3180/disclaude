/**
 * ACP stdio 传输层
 *
 * 通过 stdio（子进程的 stdin/stdout）与 ACP Server 通信。
 * 使用换行分隔的 JSON-RPC 2.0 消息格式。
 *
 * @see Issue #1333
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type {
  JsonRpcMessage,
  JsonRpcNotification,
  AcpStdioTransportConfig,
} from './types.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('AcpStdioTransport');

/** 传输层消息监听器 */
export type TransportMessageListener = (message: JsonRpcMessage) => void;

/** 传输层错误监听器 */
export type TransportErrorListener = (error: Error) => void;

/** 传输层关闭监听器 */
export type TransportCloseListener = (code: number | null, signal: string | null) => void;

/**
 * ACP 传输层接口
 *
 * 定义传输层必须实现的接口，支持依赖注入和测试。
 * AcpStdioTransport 是默认实现（通过 stdio 子进程通信）。
 */
export interface IAcpTransport {
  /** 连接到 ACP Server */
  connect(): Promise<void>;
  /** 发送 JSON-RPC 消息 */
  send(message: JsonRpcMessage): void;
  /** 断开连接 */
  disconnect(): void;
  /** 注册消息监听器，返回取消注册函数 */
  onMessage(listener: TransportMessageListener): () => void;
  /** 注册错误监听器，返回取消注册函数 */
  onError(listener: TransportErrorListener): () => void;
  /** 注册关闭监听器，返回取消注册函数 */
  onClose(listener: TransportCloseListener): () => void;
  /** 传输层是否已连接 */
  readonly connected: boolean;
}

/**
 * ACP stdio 传输层
 *
 * 管理与 ACP Server 子进程的 stdio 通信。
 * 负责消息序列化、反序列化和进程生命周期管理。
 */
export class AcpStdioTransport {
  private process: ChildProcess | null = null;
  private buffer = '';
  private messageListeners = new Set<TransportMessageListener>();
  private errorListeners = new Set<TransportErrorListener>();
  private closeListeners = new Set<TransportCloseListener>();
  private config: Required<AcpStdioTransportConfig>;

  constructor(config: AcpStdioTransportConfig) {
    this.config = {
      startupTimeoutMs: 30_000,
      ...config,
      args: config.args ?? [],
      env: { ...process.env, ...config.env },
    };
  }

  /**
   * 启动子进程并建立通信
   *
   * @throws 如果进程启动失败或超时
   */
  connect(): Promise<void> {
    if (this.process) {
      throw new Error('Transport is already connected');
    }

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.kill();
        reject(new Error(
          `ACP server startup timed out after ${this.config.startupTimeoutMs}ms`
        ));
      }, this.config.startupTimeoutMs);

      this.process = spawn(this.config.command, this.config.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.config.env,
        cwd: this.config.cwd,
      });

      const proc = this.process;

      // Handle process errors
      proc.on('error', (err) => {
        clearTimeout(timeout);
        logger.error({ err }, 'ACP server process error');
        this.notifyError(err);
        reject(err);
      });

      // Handle process exit
      proc.on('close', (code, signal) => {
        clearTimeout(timeout);
        logger.info({ code, signal }, 'ACP server process exited');
        this.process = null;
        this.notifyClose(code, signal);
      });

      // Handle stderr output (for logging)
      if (proc.stderr) {
        proc.stderr.on('data', (data: Buffer) => {
          const text = data.toString().trim();
          if (text) {
            logger.debug({ stderr: text }, 'ACP server stderr');
          }
        });
      }

      // Handle stdout data (JSON-RPC messages)
      if (proc.stdout) {
        proc.stdout.on('data', (data: Buffer) => {
          this.appendData(data.toString());
        });

        // Process is ready once stdout is readable
        proc.stdout.on('readable', () => {
          clearTimeout(timeout);
          resolve();
        });
      }
    });
  }

  /**
   * 发送 JSON-RPC 消息到 ACP Server
   *
   * @param message - JSON-RPC 消息
   */
  send(message: JsonRpcMessage): void {
    if (!this.process || !this.process.stdin) {
      throw new Error('Transport is not connected');
    }

    if (this.process.stdin.writableEnded || this.process.stdin.destroyed) {
      throw new Error('Transport stdin is closed');
    }

    const json = JSON.stringify(message);
    logger.debug({ message: json }, 'Sending ACP message');
    this.process.stdin.write(`${json}\n`);
  }

  /**
   * 断开连接并终止子进程
   */
  disconnect(): void {
    this.kill();
  }

  /**
   * 注册消息监听器
   *
   * @param listener - 消息监听器
   * @returns 取消注册函数
   */
  onMessage(listener: TransportMessageListener): () => void {
    this.messageListeners.add(listener);
    return () => { this.messageListeners.delete(listener); };
  }

  /**
   * 注册错误监听器
   *
   * @param listener - 错误监听器
   * @returns 取消注册函数
   */
  onError(listener: TransportErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => { this.errorListeners.delete(listener); };
  }

  /**
   * 注册关闭监听器
   *
   * @param listener - 关闭监听器
   * @returns 取消注册函数
   */
  onClose(listener: TransportCloseListener): () => void {
    this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }

  /**
   * 传输层是否已连接
   */
  get connected(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /**
   * 处理接收到的数据（换行分隔的 JSON）
   */
  private appendData(data: string): void {
    this.buffer += data;

    // Split by newlines and process complete messages
    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const message = JSON.parse(trimmed) as JsonRpcMessage;
        logger.debug({ message: trimmed }, 'Received ACP message');
        this.notifyMessage(message);
      } catch (err) {
        logger.warn({ line: trimmed, err }, 'Failed to parse ACP message');
        this.notifyError(
          new Error(`Invalid JSON-RPC message: ${trimmed}`)
        );
      }
    }
  }

  /**
   * 通知所有消息监听器
   */
  private notifyMessage(message: JsonRpcMessage): void {
    for (const listener of this.messageListeners) {
      try {
        listener(message);
      } catch (err) {
        logger.error({ err }, 'Message listener error');
      }
    }
  }

  /**
   * 通知所有错误监听器
   */
  private notifyError(error: Error): void {
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch (err) {
        logger.error({ err }, 'Error listener error');
      }
    }
  }

  /**
   * 通知所有关闭监听器
   */
  private notifyClose(code: number | null, signal: string | null): void {
    for (const listener of this.closeListeners) {
      try {
        listener(code, signal);
      } catch (err) {
        logger.error({ err }, 'Close listener error');
      }
    }
  }

  /**
   * 终止子进程
   */
  private kill(): void {
    if (this.process) {
      try {
        this.process.stdin?.end();
      } catch {
        // Ignore stdin close errors
      }

      try {
        this.process.kill('SIGTERM');
      } catch {
        // Process may already be dead
      }

      this.process = null;
    }
  }
}

/**
 * 创建 JSON-RPC 通知
 *
 * @param method - 方法名
 * @param params - 参数
 * @returns JSON-RPC 通知对象
 */
export function createNotification<TParams = Record<string, unknown>>(
  method: string,
  params?: TParams
): JsonRpcNotification<TParams> {
  const notification: JsonRpcNotification<TParams> = {
    jsonrpc: '2.0',
    method,
  };
  if (params !== undefined) {
    notification.params = params;
  }
  return notification;
}
