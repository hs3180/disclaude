/**
 * ACP 连接管理器
 *
 * 管理 ACP Client 与 ACP Server 之间的传输连接。
 * 支持 stdio（子进程）和 SSE（Server-Sent Events）两种传输模式。
 */

import { EventEmitter } from 'node:events';
import { ChildProcess, spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import {
  parseJsonRpcMessage,
  serializeJsonRpcMessage,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  isJsonRpcNotification,
  isJsonRpcResponse,
} from './json-rpc.js';
import type {
  AcpConnectionState,
  AcpConnectionEvent,
} from './types.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('AcpConnection');

/** 默认连接超时（毫秒） */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** 响应超时（毫秒） */
const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000;

/**
 * ACP 连接管理器
 *
 * 负责建立和维护与 ACP Server 的传输连接，
 * 处理 JSON-RPC 消息的收发和路由。
 */
export class AcpConnection extends EventEmitter {
  private state: AcpConnectionState = 'disconnected';
  private childProcess: ChildProcess | null = null;
  private responseTimeoutMs: number;
  private pendingRequests = new Map<string | number, {
    resolve: (response: JsonRpcResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private notificationHandler: ((notification: JsonRpcNotification) => void) | null = null;
  private buffer = '';
  private disposed = false;

  constructor(options?: { responseTimeoutMs?: number }) {
    super();
    this.responseTimeoutMs = options?.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    // Prevent EventEmitter from throwing on unhandled 'error' events
    this.on('error', () => {});
  }

  /**
   * 获取当前连接状态
   */
  getState(): AcpConnectionState {
    return this.state;
  }

  /**
   * 设置通知处理器
   *
   * 当收到 JSON-RPC 通知时调用此处理器。
   */
  onNotification(handler: (notification: JsonRpcNotification) => void): void {
    this.notificationHandler = handler;
  }

  /**
   * 使用 stdio 传输连接到 ACP Server
   */
  async connectStdio(config: { command: string; args?: string[]; env?: Record<string, string> }): Promise<void> {
    this.assertDisconnected();

    this.setState('connecting');

    const child = spawn(config.command, config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...config.env },
    });

    this.childProcess = child;

    // 设置数据处理
    const {stdout} = child;
    if (stdout) {
      stdout.on('data', (chunk: Buffer) => {
        this.handleData(chunk.toString());
      });
    }

    const {stderr} = child;
    if (stderr) {
      stderr.on('data', (chunk: Buffer) => {
        logger.debug({ stderr: chunk.toString() }, 'Server stderr');
      });
    }

    // 处理进程退出
    child.on('exit', (code, signal) => {
      logger.info({ code, signal }, 'Server process exited');
      if (!this.disposed) {
        this.cleanup();
        this.setState('disconnected');
      }
    });

    child.on('error', (err) => {
      logger.error({ err }, 'Server process error');
      this.setState('error', err);
    });

    // 等待进程启动
    await this.waitForProcessStart(child);

    this.setState('connected');
  }

  /**
   * 发送 JSON-RPC 请求并等待响应
   */
  sendRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    this.assertConnected();

    if (request.id === undefined || request.id === null) {
      throw new Error('Request must have an id to receive a response');
    }

    const requestId = request.id;
    const serialized = serializeJsonRpcMessage(request);
    logger.debug({ method: request.method, id: requestId }, 'Sending request');

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request timeout: ${request.method} (id=${requestId})`));
      }, this.responseTimeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      this.writeToStdin(serialized);
    });
  }

  /**
   * 发送 JSON-RPC 通知（不需要响应）
   */
  sendNotification(notification: JsonRpcNotification): void {
    this.assertConnected();

    const serialized = serializeJsonRpcMessage(notification);
    logger.debug({ method: notification.method }, 'Sending notification');
    this.writeToStdin(serialized);
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    this.cleanup();
    this.setState('disconnected');
  }

  /**
   * 释放资源
   */
  dispose(): void {
    this.disposed = true;
    this.state = 'disconnected';
    this.cleanup();
    this.removeAllListeners();
  }

  /**
   * 获取 stdin 写入流（供 SSE 传输等扩展使用）
   */
  protected getStdin(): Writable | null {
    return this.childProcess?.stdin ?? null;
  }

  /**
   * 设置外部数据源（供 SSE 传输等扩展使用）
   */
  protected handleExternalData(data: string): void {
    this.handleData(data);
  }

  /**
   * 设置连接状态（带事件通知）
   */
  private setState(state: AcpConnectionState, error?: Error): void {
    const prevState = this.state;
    this.state = state;

    if (prevState !== state) {
      const event: AcpConnectionEvent = { type: state, error };
      this.emit(state, event);
      logger.debug({ from: prevState, to: state }, 'Connection state changed');
    }
  }

  /**
   * 断言未连接
   */
  private assertDisconnected(): void {
    if (this.state !== 'disconnected') {
      throw new Error(`Cannot connect: current state is "${this.state}"`);
    }
  }

  /**
   * 断言已连接
   */
  private assertConnected(): void {
    if (this.state !== 'connected' && this.state !== 'ready') {
      throw new Error(`Cannot send: current state is "${this.state}"`);
    }
  }

  /**
   * 等待子进程启动
   */
  private waitForProcessStart(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Process start timeout: ${DEFAULT_CONNECT_TIMEOUT_MS}ms`));
      }, DEFAULT_CONNECT_TIMEOUT_MS);

      const onSpawn = () => {
        clearTimeout(timer);
        child.removeListener('error', onError);
        resolve();
      };

      const onError = (err: Error) => {
        clearTimeout(timer);
        child.removeListener('spawn', onSpawn);
        reject(err);
      };

      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
  }

  /**
   * 处理收到的数据
   */
  private handleData(data: string): void {
    this.buffer += data;

    // 按行分割处理（JSON-RPC over stdio 每条消息一行）
    const lines = this.buffer.split('\n');
    // 最后一个元素可能是未完成的行，保留在 buffer 中
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      try {
        const messages = parseJsonRpcMessage(trimmed);
        for (const msg of messages) {
          this.routeMessage(msg);
        }
      } catch (err) {
        logger.warn({ line: trimmed, err }, 'Failed to parse incoming message');
      }
    }
  }

  /**
   * 路由 JSON-RPC 消息
   */
  private routeMessage(msg: JsonRpcMessage): void {
    if (isJsonRpcResponse(msg)) {
      this.handleResponse(msg);
    } else if (isJsonRpcNotification(msg)) {
      this.handleNotification(msg);
    } else {
      logger.warn({ msg }, 'Received unexpected JSON-RPC message type');
    }
  }

  /**
   * 处理响应
   */
  private handleResponse(response: JsonRpcResponse): void {
    const {id} = response;
    if (id === null) {
      logger.warn('Received response with null id, ignoring');
      return;
    }

    const pending = this.pendingRequests.get(id);
    if (!pending) {
      logger.warn({ id }, 'Received response for unknown request');
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(id);

    if ('error' in response) {
      logger.debug({ id, code: response.error.code }, 'Received error response');
      pending.reject(new Error(`JSON-RPC error ${response.error.code}: ${response.error.message}`));
    } else {
      logger.debug({ id }, 'Received success response');
      pending.resolve(response);
    }
  }

  /**
   * 处理通知
   */
  private handleNotification(notification: JsonRpcNotification): void {
    logger.debug({ method: notification.method }, 'Received notification');
    if (this.notificationHandler) {
      this.notificationHandler(notification);
    }
  }

  /**
   * 写入数据到子进程 stdin
   */
  private writeToStdin(data: string): void {
    const stdin = this.childProcess?.stdin;
    if (!stdin || stdin.destroyed) {
      throw new Error('Cannot write: stdin is not available');
    }
    stdin.write(`${data  }\n`);
  }

  /**
   * 清理资源
   */
  private cleanup(): void {
    // 拒绝所有等待中的请求
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();

    // 终止子进程
    if (this.childProcess && !this.childProcess.killed) {
      this.childProcess.kill('SIGTERM');
      this.childProcess = null;
    }

    this.buffer = '';
  }
}
