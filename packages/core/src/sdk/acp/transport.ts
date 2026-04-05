/**
 * ACP 传输层抽象与 Stdio 传输实现
 *
 * 提供 ACP 协议的传输层抽象接口和基于 stdio 的具体实现。
 * stdio 传输使用 stdin/stdout 以换行分隔的 JSON 格式进行消息传递。
 *
 * @module acp/transport
 */

import { EventEmitter } from 'node:events';
import {
  parseMessage,
  serializeMessage,
  isJsonRpcResponse,
  type JsonRpcMessage,
} from './json-rpc.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('AcpStdioTransport');

// ============================================================================
// 传输层事件
// ============================================================================

/** 传输层事件映射 */
export interface TransportEvents {
  /** 收到 JSON-RPC 响应 */
  response: [JsonRpcMessage & { id: string | number }];
  /** 收到 JSON-RPC 通知（无 id） */
  notification: [JsonRpcMessage];
  /** 连接关闭 */
  close: [];
  /** 发生错误 */
  error: [Error];
}

// ============================================================================
// 传输层接口
// ============================================================================

/** ACP 传输层抽象接口 */
export interface IAcpTransport {
  /** 发送 JSON-RPC 消息 */
  send(message: JsonRpcMessage): void;
  /** 关闭连接 */
  close(): void;
  /** 注册事件监听 */
  on<K extends keyof TransportEvents>(event: K, listener: (...args: TransportEvents[K]) => void): void;
  /** 移除事件监听 */
  off<K extends keyof TransportEvents>(event: K, listener: (...args: TransportEvents[K]) => void): void;
  /** 传输层是否已连接 */
  readonly connected: boolean;
}

// ============================================================================
// Stdio 传输配置
// ============================================================================

/** Stdio 传输配置 */
export interface StdioTransportConfig {
  /** 子进程的 stdin 可写流（默认 process.stdin） */
  stdin?: NodeJS.WritableStream;
  /** 子进程的 stdout 可读流（默认 process.stdout） */
  stdout?: NodeJS.ReadableStream;
}

// ============================================================================
// Stdio 传输实现
// ============================================================================

/**
 * 基于 stdio 的 ACP 传输层
 *
 * 使用 Node.js 的 stdin/stdout 以换行分隔的 JSON (NDJSON) 格式
 * 进行 JSON-RPC 消息的读写。
 *
 * ## 消息格式
 *
 * 每条消息为单行 JSON + 换行符 (`\n`)。
 *
 * ## 使用示例
 *
 * ```typescript
 * const transport = new StdioTransport();
 * transport.on('notification', (msg) => console.log('Notification:', msg));
 * transport.on('response', (msg) => console.log('Response:', msg));
 *
 * // 启动输入监听
 * transport.start();
 *
 * // 发送消息
 * transport.send(createRequest('initialize', { ... }));
 * ```
 */
export class StdioTransport extends EventEmitter<TransportEvents> implements IAcpTransport {
  private _connected = false;
  private readonly writable: NodeJS.WritableStream;
  private readonly readable: NodeJS.ReadableStream;
  private buffer = '';
  private boundHandleData: (chunk: Buffer | string) => void;

  constructor(config?: StdioTransportConfig) {
    super();
    this.writable = config?.stdin ?? process.stdin;
    this.readable = config?.stdout ?? process.stdout;
    this.boundHandleData = this.handleData.bind(this);
  }

  /** 传输层是否已连接 */
  get connected(): boolean {
    return this._connected;
  }

  /**
   * 启动传输层，开始监听输入流
   *
   * 从可读流中读取数据，按换行符分割消息并解析。
   */
  start(): void {
    if (this._connected) {
      return;
    }

    this._connected = true;

    const stream = this.readable;

    if ('on' in stream && typeof stream.on === 'function') {
      stream.on('data', this.boundHandleData);

      stream.on('end', () => {
        logger.info('Stdio stream ended');
        this.handleClose();
      });

      stream.on('error', (err: Error) => {
        logger.error({ err }, 'Stdio stream error');
        this.emit('error', err);
      });
    }
  }

  /**
   * 发送 JSON-RPC 消息
   *
   * 将消息序列化为单行 JSON 并写入可写流。
   *
   * @param message - JSON-RPC 消息
   */
  send(message: JsonRpcMessage): void {
    if (!this._connected) {
      throw new Error('Transport is not connected');
    }

    const serialized = serializeMessage(message);

    if ('write' in this.writable && typeof this.writable.write === 'function') {
      const ok = this.writable.write(serialized);
      if (!ok) {
        logger.warn('Stdio write buffer full, data may be back-pressured');
      }
    }

    logger.debug(
      { method: 'method' in message ? (message as unknown as Record<string, unknown>).method : 'response' },
      'Message sent'
    );
  }

  /**
   * 关闭传输层
   *
   * 停止监听输入流并清理资源。
   */
  close(): void {
    if (!this._connected) {
      return;
    }

    this._connected = false;
    this.buffer = '';

    if ('removeListener' in this.readable && typeof this.readable.removeListener === 'function') {
      this.readable.removeListener('data', this.boundHandleData);
    }

    this.emit('close');
    this.removeAllListeners();
    logger.info('Transport closed');
  }

  /**
   * 处理接收到的数据
   *
   * 将数据追加到缓冲区，按换行符分割并逐条解析消息。
   *
   * @param chunk - 接收到的数据块
   */
  private handleData(chunk: Buffer | string): void {
    this.buffer += chunk.toString();

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        continue;
      }

      try {
        const message = parseMessage(line);

        if (isJsonRpcResponse(message)) {
          this.emit('response', message as JsonRpcMessage & { id: string | number });
        } else {
          this.emit('notification', message);
        }
      } catch (err) {
        logger.error({ line, err }, 'Failed to parse message');
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /**
   * 处理连接关闭
   */
  private handleClose(): void {
    if (this._connected) {
      this._connected = false;
      this.emit('close');
    }
  }
}
