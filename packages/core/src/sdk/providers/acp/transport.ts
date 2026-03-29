/**
 * ACP Stdio 传输层
 *
 * 通过 stdio (stdin/stdout) 与 ACP 服务端进程通信。
 * 每条消息以换行符分隔的 JSON 行传输。
 *
 * @see Issue #1333 - 支持OpenAI Agent
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from '../../../utils/logger.js';
import type { AcpTransportConfig, AcpConnectionState } from './types.js';

const logger = createLogger('AcpTransport');

/** 传输层事件处理器类型 */
export type TransportMessageHandler = (message: unknown) => void;
export type TransportErrorHandler = (error: Error) => void;
export type TransportCloseHandler = (code: number | null, signal: string | null) => void;

/**
 * ACP Stdio 传输层
 *
 * 管理与 ACP 服务端子进程的 stdio 通信。
 * 消息以换行符分隔的 JSON Lines 格式传输。
 *
 * 线程安全：所有回调通过 EventEmitter 异步调度。
 */
export class AcpStdioTransport {
  private process: ChildProcess | null = null;
  private messageHandler: TransportMessageHandler | null = null;
  private errorHandler: TransportErrorHandler | null = null;
  private closeHandler: TransportCloseHandler | null = null;
  private buffer = '';
  private _state: AcpConnectionState = 'disconnected';

  constructor(private readonly config: AcpTransportConfig) {}

  /** 获取当前连接状态 */
  get state(): AcpConnectionState {
    return this._state;
  }

  /**
   * 连接到 ACP 服务端
   *
   * 启动子进程并通过 stdio 建立通信通道。
   *
   * @throws 如果进程启动失败或连接超时
   */
  async connect(): Promise<void> {
    if (this._state === 'connected' || this._state === 'connecting') {
      return;
    }

    this._state = 'connecting';
    const timeout = this.config.connectionTimeout ?? 30000;

    try {
      this.process = spawn(this.config.command, this.config.args ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...this.config.env,
        },
        // Detach on Windows for proper process tree management
        detached: process.platform === 'win32',
        shell: false,
      });

      // 绑定事件处理
      this.process.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
      this.process.stderr?.on('data', (chunk: Buffer) => this.onStderr(chunk));
      this.process.on('error', (err) => this.onError(err));
      this.process.on('close', (code, signal) => this.onClose(code, signal));
      // Prevent unhandled EPIPE errors on stdin when process exits
      this.process.stdin?.on('error', () => {
        // Silently handle - the process-level close handler will manage state
      });

      // 等待进程就绪
      await this.waitForReady(timeout);
      this._state = 'connected';
      logger.info(
        { command: this.config.command, args: this.config.args, pid: this.process.pid },
        'ACP transport connected'
      );
    } catch (error) {
      this._state = 'error';
      this.cleanup();
      throw error;
    }
  }

  /**
   * 发送消息到 ACP 服务端
   *
   * @param message - JSON-RPC 请求或通知对象
   * @throws 如果未连接或写入失败
   */
  send(message: unknown): void {
    if (this._state !== 'connected' || !this.process?.stdin) {
      throw new Error(`ACP transport not connected (state: ${this._state})`);
    }

    const json = `${JSON.stringify(message)  }\n`;
    try {
      const result = this.process.stdin.write(json, 'utf-8');

      if (!result) {
        // Backpressure - wait for drain event
        logger.warn('ACP transport write backpressure, waiting for drain');
      }

      logger.debug({ message }, 'ACP transport sent');
    } catch (error) {
      // Handle EPIPE and other write errors gracefully
      this._state = 'error';
      logger.error({ err: error }, 'ACP transport write failed');
      this.errorHandler?.(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * 注册消息处理器
   *
   * @param handler - 收到消息时的回调
   */
  onMessage(handler: TransportMessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * 注册错误处理器
   *
   * @param handler - 发生错误时的回调
   */
  setErrorHandler(handler: TransportErrorHandler): void {
    this.errorHandler = handler;
  }

  /**
   * 注册关闭处理器
   *
   * @param handler - 进程关闭时的回调
   */
  setCloseHandler(handler: TransportCloseHandler): void {
    this.closeHandler = handler;
  }

  /**
   * 断开连接并清理资源
   */
  disconnect(): void {
    this.cleanup();
    this._state = 'disconnected';
    logger.info('ACP transport disconnected');
  }

  /**
   * 处理 stdout 数据
   *
   * 数据可能跨消息边界到达，需要缓冲并按换行符分割。
   */
  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf-8');

    // 按换行符分割消息
    const lines = this.buffer.split('\n');
    // 最后一行可能不完整，保留在缓冲区
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      try {
        const message = JSON.parse(trimmed);
        logger.debug({ message }, 'ACP transport received');
        this.messageHandler?.(message);
      } catch (error) {
        logger.error({ line: trimmed, err: error }, 'ACP transport failed to parse message');
        this.errorHandler?.(
          new Error(`Failed to parse ACP message: ${trimmed.slice(0, 100)}`)
        );
      }
    }
  }

  /**
   * 处理 stderr 数据（日志/调试输出）
   */
  private onStderr(chunk: Buffer): void {
    const text = chunk.toString('utf-8').trim();
    if (text.length > 0) {
      logger.debug({ stderr: text }, 'ACP server stderr');
    }
  }

  /**
   * 处理进程错误
   */
  private onError(error: Error): void {
    this._state = 'error';
    logger.error({ err: error }, 'ACP transport process error');
    this.errorHandler?.(error);
  }

  /**
   * 处理进程关闭
   */
  private onClose(code: number | null, signal: string | null): void {
    this._state = 'disconnected';
    logger.info({ code, signal }, 'ACP transport process closed');
    this.closeHandler?.(code, signal);
  }

  /**
   * 等待进程就绪
   *
   * 进程就绪条件：stdout 可读（进程已启动并初始化完成）。
   */
  private waitForReady(timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.process) {
        reject(new Error('ACP server process not created'));
        return;
      }

      // 如果进程已经退出
      if (this.process.killed || this.process.exitCode !== null) {
        reject(new Error(`ACP server process exited immediately (code: ${this.process.exitCode})`));
        return;
      }

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`ACP server connection timeout (${timeout}ms)`));
      }, timeout);

      const cleanup = () => {
        clearTimeout(timer);
      };

      // 进程启动成功即可认为就绪（ACP 协议通过 initialize 握手确认）
      this.process.stdout?.once('readable', () => {
        cleanup();
        resolve();
      });

      // 如果进程出错
      this.process.once('error', (err) => {
        cleanup();
        reject(new Error(`ACP server process error: ${err.message}`));
      });

      this.process.once('close', (code) => {
        cleanup();
        if (code !== null && code !== 0) {
          reject(new Error(`ACP server process exited with code ${code}`));
        }
      });
    });
  }

  /**
   * 清理进程资源
   */
  private cleanup(): void {
    if (this.process) {
      try {
        if (!this.process.killed && this.process.exitCode === null) {
          this.process.kill('SIGTERM');

          // 强制终止超时进程
          const forceKillTimer = setTimeout(() => {
            try {
              this.process?.kill('SIGKILL');
            } catch {
              // 进程可能已经退出
            }
          }, 5000);

          // 清理定时器（如果进程正常退出）
          this.process.once('exit', () => {
            clearTimeout(forceKillTimer);
          });
        }
      } catch (error) {
        logger.warn({ err: error }, 'ACP transport cleanup error');
      }
      this.process = null;
    }
    this.buffer = '';
  }
}
