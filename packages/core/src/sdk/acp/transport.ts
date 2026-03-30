/**
 * ACP 传输层
 *
 * 提供 stdio 和 SSE 两种传输方式，负责底层进程管理和数据收发。
 *
 * @module sdk/acp/transport
 * @see Issue #1333
 */

import { ChildProcess, spawn } from 'child_process';
import { createLogger } from '../../utils/logger.js';
import type { AcpStdioTransportConfig, AcpTransportConfig, JsonRpcMessage } from './types.js';
import { serializeMessage, type JsonRpcMessageParser } from './json-rpc.js';

const logger = createLogger('AcpTransport');

/**
 * 传输层事件类型
 */
export type TransportEventType = 'message' | 'error' | 'close';

/**
 * 传输层事件
 */
export interface TransportEvent {
  type: TransportEventType;
  /** 消息内容（仅 message 事件） */
  message?: JsonRpcMessage;
  /** 错误对象（仅 error 事件） */
  error?: Error;
  /** 退出码（仅 close 事件） */
  exitCode?: number | null;
}

/**
 * 传输层接口
 *
 * 所有传输方式（stdio、SSE）都需要实现此接口。
 */
export interface IAcpTransport {
  /** 发送 JSON-RPC 消息 */
  send(message: JsonRpcMessage): void;
  /** 设置消息解析器 */
  setParser(parser: JsonRpcMessageParser): void;
  /** 关闭传输连接 */
  close(): void;
  /** 是否已关闭 */
  readonly closed: boolean;
}

/**
 * stdio 传输实现
 *
 * 通过子进程的 stdin/stdout 进行 JSON-RPC 通信。
 * 适用于本地 ACP Server（如 Claude Code、Codex CLI）。
 */
export class StdioTransport implements IAcpTransport {
  private process: ChildProcess | null = null;
  private parser: JsonRpcMessageParser | null = null;
  private _closed = false;
  private eventCallback: ((event: TransportEvent) => void) | null = null;

  /**
   * 创建 stdio 传输实例
   *
   * @param config - stdio 传输配置
   * @param onEvent - 事件回调
   */
  constructor(
    private readonly config: AcpStdioTransportConfig,
    onEvent?: (event: TransportEvent) => void
  ) {
    if (onEvent) {
      this.eventCallback = onEvent;
    }
  }

  /** 是否已关闭 */
  get closed(): boolean {
    return this._closed;
  }

  /**
   * 设置消息解析器
   */
  setParser(parser: JsonRpcMessageParser): void {
    this.parser = parser;
  }

  /**
   * 设置事件回调
   */
  setEventCallback(callback: (event: TransportEvent) => void): void {
    this.eventCallback = callback;
  }

  /**
   * 启动子进程
   */
  start(): void {
    if (this.process) {
      throw new Error('Transport already started');
    }

    const { command, args, env, cwd } = this.config;
    const mergedEnv = { ...process.env, ...env };

    logger.info({ command, args, cwd }, 'Starting ACP stdio transport');

    this.process = spawn(command, args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: mergedEnv,
      cwd,
    });

    const proc = this.process;

    // 处理 stdout 数据
    proc.stdout?.on('data', (data: Buffer) => {
      if (this.parser && !this._closed) {
        const str = data.toString('utf-8');
        const messages = this.parser.feed(str);
        for (const msg of messages) {
          this.emit({ type: 'message', message: msg });
        }
      }
    });

    // 处理 stderr 数据（日志）
    proc.stderr?.on('data', (data: Buffer) => {
      const stderr = data.toString('utf-8');
      if (stderr.trim()) {
        logger.debug({ stderr }, 'ACP server stderr');
      }
    });

    // 处理进程退出
    proc.on('close', (code) => {
      this._closed = true;
      logger.info({ exitCode: code }, 'ACP server process closed');
      this.emit({ type: 'close', exitCode: code });
    });

    // 处理进程错误
    proc.on('error', (err) => {
      this._closed = true;
      logger.error({ err }, 'ACP server process error');
      this.emit({ type: 'error', error: err });
    });
  }

  /**
   * 发送 JSON-RPC 消息
   */
  send(message: JsonRpcMessage): void {
    if (this._closed || !this.process?.stdin) {
      throw new Error('Transport is closed');
    }

    const serialized = serializeMessage(message);
    this.process.stdin.write(serialized);
  }

  /**
   * 关闭传输连接
   */
  close(): void {
    if (this._closed) {
      return;
    }

    this._closed = true;

    if (this.process) {
      // 给子进程一点时间优雅退出
      const proc = this.process;
      const killTimeout = setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      }, 5000);

      proc.on('close', () => {
        clearTimeout(killTimeout);
      });

      proc.stdin?.end();
      proc.kill('SIGTERM');
      this.process = null;
    }

    this.parser?.reset();
    this.parser = null;
  }

  /**
   * 发射事件
   */
  private emit(event: TransportEvent): void {
    this.eventCallback?.(event);
  }
}

/**
 * 创建传输层实例
 *
 * @param config - 传输配置
 * @param onEvent - 事件回调
 * @returns 传输层实例
 */
export function createTransport(
  config: AcpTransportConfig,
  onEvent?: (event: TransportEvent) => void
): IAcpTransport {
  switch (config.type) {
    case 'stdio':
      return new StdioTransport(config, onEvent);
    case 'sse':
      // SSE 传输将在 PR C（OpenAI 集成）中实现
      throw new Error('SSE transport is not yet implemented');
    default:
      throw new Error(`Unknown transport type: ${(config as { type: string }).type}`);
  }
}
