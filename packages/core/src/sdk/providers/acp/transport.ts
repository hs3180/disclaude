/**
 * ACP 传输层 - stdio 传输实现
 *
 * 通过子进程的 stdin/stdout 与 ACP Server 通信。
 * 每条消息独占一行（newline-delimited JSON）。
 *
 * @module sdk/providers/acp/transport
 */

import { ChildProcess, spawn } from 'node:child_process';
import { createLogger } from '../../../utils/logger.js';
import type { JsonRpcMessage, AcpTransportConfig, AcpStdioTransportConfig } from './types.js';

const logger = createLogger('AcpTransport');

/** 传输层事件处理器类型 */
export type TransportMessageHandler = (message: JsonRpcMessage) => void;
export type TransportErrorHandler = (error: Error) => void;
export type TransportCloseHandler = (code: number | null) => void;

/**
 * ACP 传输层抽象接口
 *
 * 定义与 ACP Server 通信的传输层契约。
 * 支持 stdio（子进程）和 SSE（HTTP）两种传输方式。
 */
export interface IAcpTransport {
  /** 发送 JSON-RPC 消息 */
  send(message: JsonRpcMessage): void;
  /** 注册消息处理器 */
  onMessage(handler: TransportMessageHandler): void;
  /** 注册错误处理器 */
  onError(handler: TransportErrorHandler): void;
  /** 注册关闭处理器 */
  onClose(handler: TransportCloseHandler): void;
  /** 建立连接 */
  connect(): Promise<void>;
  /** 断开连接 */
  disconnect(): void;
  /** 连接是否活跃 */
  readonly connected: boolean;
}

/**
 * ACP stdio 传输实现
 *
 * 通过子进程的 stdin/stdout 与 ACP Server 通信。
 * 使用 newline-delimited JSON (NDJSON) 格式传输消息。
 *
 * @example
 * ```typescript
 * const transport = new StdioTransport({
 *   type: 'stdio',
 *   command: 'npx',
 *   args: ['@openai/acp-server'],
 *   env: { ...process.env, OPENAI_API_KEY: '...' },
 * });
 *
 * await transport.connect();
 * transport.onMessage(msg => console.log('Received:', msg));
 * transport.send({ jsonrpc: '2.0', id: 1, method: 'acp/initialize', params: {...} });
 * ```
 */
export class StdioTransport implements IAcpTransport {
  private process: ChildProcess | null = null;
  private messageHandlers: TransportMessageHandler[] = [];
  private errorHandlers: TransportErrorHandler[] = [];
  private closeHandlers: TransportCloseHandler[] = [];
  private _connected = false;
  private buffer = '';
  private readonly config: AcpStdioTransportConfig;

  constructor(config: AcpTransportConfig) {
    if (config.type !== 'stdio') {
      throw new Error(`StdioTransport only supports 'stdio' config, got '${config.type}'`);
    }
    this.config = config;
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * 启动 ACP Server 子进程并建立连接
   */
  connect(): Promise<void> {
    if (this._connected) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(this.config.command, this.config.args ?? [], {
        env: { ...process.env, ...this.config.env },
        cwd: this.config.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.process = proc;

      // 收集 stderr 输出用于调试
      let stderrOutput = '';
      if (proc.stderr) {
        proc.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          stderrOutput += text;
          logger.debug({ stderr: text.trimEnd() }, 'ACP server stderr');
        });
      }

      // 监听进程退出
      proc.on('exit', (code, signal) => {
        logger.info({ code, signal }, 'ACP server process exited');
        this._connected = false;
        for (const handler of this.closeHandlers) {
          handler(code);
        }
      });

      // 监听进程错误（如命令不存在）
      proc.on('error', (error) => {
        logger.error({ err: error }, 'ACP server process error');
        for (const handler of this.errorHandlers) {
          handler(error);
        }
        // 如果还没连接成功，reject 启动 Promise
        if (!this._connected) {
          reject(error);
        }
      });

      // 从 stdout 读取消息（NDJSON 格式）
      if (proc.stdout) {
        proc.stdout.on('data', (chunk: Buffer) => {
          this.buffer += chunk.toString();
          this.processBuffer();
        });
      }

      // 等待进程启动（给一定时间让服务端初始化）
      // 使用 'spawn' 事件确认进程已创建
      proc.once('spawn', () => {
        this._connected = true;
        logger.info(
          { command: this.config.command, args: this.config.args },
          'ACP server process started'
        );
        resolve();
      });

      // 如果进程立即退出（如命令不存在），reject
      proc.once('exit', (code) => {
        if (!this._connected) {
          reject(new Error(
            `ACP server process exited immediately with code ${code}. ` +
            `stderr: ${stderrOutput || '(empty)'}`
          ));
        }
      });
    });
  }

  /**
   * 通过 stdin 发送 JSON-RPC 消息
   *
   * 消息以 newline-delimited JSON 格式发送。
   */
  send(message: JsonRpcMessage): void {
    if (!this._connected || !this.process?.stdin) {
      logger.warn('Cannot send message: transport not connected');
      return;
    }

    const line = `${JSON.stringify(message)  }\n`;
    this.process.stdin.write(line);
    logger.debug(
      { id: 'id' in message ? message.id : undefined, method: 'method' in message ? message.method : undefined },
      'Sent message to ACP server'
    );
  }

  /**
   * 注册消息处理器
   */
  onMessage(handler: TransportMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /**
   * 注册错误处理器
   */
  onError(handler: TransportErrorHandler): void {
    this.errorHandlers.push(handler);
  }

  /**
   * 注册关闭处理器
   */
  onClose(handler: TransportCloseHandler): void {
    this.closeHandlers.push(handler);
  }

  /**
   * 断开连接并终止子进程
   */
  disconnect(): void {
    if (this.process) {
      logger.info('Disconnecting ACP transport');
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this._connected = false;
    this.buffer = '';
  }

  /**
   * 处理 stdout 缓冲区中的 NDJSON 数据
   *
   * 每行是一个完整的 JSON-RPC 消息。
   */
  private processBuffer(): void {
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      try {
        const message = JSON.parse(line) as JsonRpcMessage;
        for (const handler of this.messageHandlers) {
          handler(message);
        }
      } catch (error) {
        logger.warn({ line, error }, 'Failed to parse ACP message');
      }
    }
  }
}

/**
 * 创建 ACP 传输层实例
 *
 * 根据配置类型创建对应的传输实现。
 * 目前仅支持 stdio 传输。
 *
 * @param config - 传输配置
 * @returns 传输层实例
 */
export function createTransport(config: AcpTransportConfig): IAcpTransport {
  switch (config.type) {
    case 'stdio':
      return new StdioTransport(config);
    case 'sse':
      throw new Error('SSE transport is not yet implemented. Use stdio transport.');
    default:
      throw new Error(`Unknown transport type: '${(config as { type: string }).type}'`);
  }
}
