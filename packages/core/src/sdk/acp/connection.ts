/**
 * ACP 连接管理
 *
 * 管理 ACP Client 与 Server 之间的连接生命周期，包括：
 * - 能力协商（initialize 握手）
 * - 请求/响应关联
 * - 超时管理
 * - 连接状态管理
 *
 * @module sdk/acp/connection
 * @see Issue #1333
 */

import { createLogger } from '../../utils/logger.js';
import {
  AcpMethods,
  type AcpConnectionConfig,
  type AcpInitializeResult,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcSuccessResponse,
} from './types.js';
import {
  extractError,
  isErrorResponse,
  JsonRpcMessageParser,
} from './json-rpc.js';
import { createTransport, type IAcpTransport, type TransportEvent } from './transport.js';

const logger = createLogger('AcpConnection');

/** ACP 连接状态 */
export type AcpConnectionState = 'disconnected' | 'connecting' | 'ready' | 'closed';

/** 待处理的请求 */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * ACP 连接管理器
 *
 * 负责建立连接、能力协商和消息收发。
 */
export class AcpConnection {
  private transport: IAcpTransport;
  private parser = new JsonRpcMessageParser();
  private state: AcpConnectionState = 'disconnected';
  private pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private notificationCallback: ((method: string, params: unknown) => void) | null = null;
  private nextId = 1;

  private readonly requestTimeout: number;

  /** Server 能力声明（initialize 后可用） */
  private serverCapabilities: AcpInitializeResult['capabilities'] | null = null;

  /** Server 信息（initialize 后可用） */
  private serverInfo: AcpInitializeResult['serverInfo'] | null = null;

  /**
   * 创建 ACP 连接
   *
   * @param config - 连接配置
   */
  constructor(private readonly config: AcpConnectionConfig) {
    this.requestTimeout = config.requestTimeout ?? 120000;

    this.transport = createTransport(config.transport, (event: TransportEvent) => {
      this.handleTransportEvent(event);
    });
    this.transport.setParser(this.parser);
  }

  /**
   * 获取当前连接状态
   */
  getState(): AcpConnectionState {
    return this.state;
  }

  /**
   * 获取 Server 能力声明
   */
  getServerCapabilities(): AcpInitializeResult['capabilities'] | null {
    return this.serverCapabilities;
  }

  /**
   * 获取 Server 信息
   */
  getServerInfo(): AcpInitializeResult['serverInfo'] | null {
    return this.serverInfo;
  }

  /**
   * 建立连接并完成能力协商
   *
   * @param clientInfo - Client 信息
   * @returns Server 的能力声明
   */
  async connect(
    clientInfo: { name: string; version: string } = { name: 'disclaude', version: '0.1.0' }
  ): Promise<AcpInitializeResult> {
    if (this.state === 'ready') {
      return {
        capabilities: this.serverCapabilities as AcpInitializeResult['capabilities'],
        serverInfo: this.serverInfo as AcpInitializeResult['serverInfo'],
        protocolVersion: '2025-06-01',
      };
    }

    if (this.state !== 'disconnected') {
      throw new Error(`Cannot connect in state: ${this.state}`);
    }

    this.state = 'connecting';

    try {
      // 启动传输层
      if ('start' in this.transport) {
        (this.transport as unknown as { start(): void }).start();
      }

      // 发送 initialize 请求
      const result = await this.sendRequest<AcpInitializeResult>(AcpMethods.INITIALIZE, {
        capabilities: {
          protocolVersion: '2025-06-01',
          role: 'client',
          ...this.config.capabilities,
        },
        clientInfo,
      });

      this.serverCapabilities = result.capabilities;
      this.serverInfo = result.serverInfo;
      this.state = 'ready';

      logger.info(
        { serverName: result.serverInfo.name, serverVersion: result.serverInfo.version },
        'ACP connection established'
      );

      return result;
    } catch (err) {
      this.state = 'closed';
      this.transport.close();
      throw err;
    }
  }

  /**
   * 注册通知回调
   *
   * @param callback - 通知回调函数
   */
  onNotification(callback: (method: string, params: unknown) => void): void {
    this.notificationCallback = callback;
  }

  /**
   * 发送请求并等待响应
   *
   * @param method - ACP 方法名
   * @param params - 请求参数
   * @returns 响应结果
   */
  sendRequest<T>(method: string, params?: unknown): Promise<T> {
    if (this.state !== 'ready') {
      throw new Error(`Connection not ready (state: ${this.state})`);
    }

    const id = this.generateId();
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      id,
    };
    if (params !== undefined) {
      request.params = params;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout (${this.requestTimeout}ms): ${method}`));
      }, this.requestTimeout);

      this.pendingRequests.set(id, { resolve: resolve as (result: unknown) => void, reject, timer });

      try {
        this.transport.send(request);
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  /**
   * 关闭连接
   */
  close(): void {
    if (this.state === 'closed') {
      return;
    }

    this.state = 'closed';

    // 拒绝所有待处理的请求
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
      this.pendingRequests.delete(id);
    }

    this.transport.close();
    logger.info('ACP connection closed');
  }

  /**
   * 处理传输层事件
   */
  private handleTransportEvent(event: TransportEvent): void {
    switch (event.type) {
      case 'message':
        if (event.message) {
          this.handleMessage(event.message);
        }
        break;
      case 'error':
        logger.error({ err: event.error }, 'Transport error');
        break;
      case 'close':
        if (this.state !== 'closed') {
          this.state = 'closed';
          // 拒绝所有待处理的请求
          for (const [id, pending] of this.pendingRequests) {
            clearTimeout(pending.timer);
            pending.reject(new Error(`Transport closed (exit code: ${event.exitCode})`));
            this.pendingRequests.delete(id);
          }
        }
        break;
    }
  }

  /**
   * 处理 JSON-RPC 消息
   */
  private handleMessage(message: JsonRpcMessage): void {
    // 判断是响应还是请求/通知
    if ('result' in message || ('error' in message && !('method' in message))) {
      // 响应
      const response = message as JsonRpcSuccessResponse | JsonRpcErrorResponse;
      const { id } = response;

      if (typeof id === 'string' || typeof id === 'number') {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(id);

          if (isErrorResponse(response)) {
            const error = extractError(response);
            pending.reject(new Error(`ACP error ${error.code}: ${error.message}`));
          } else {
            pending.resolve(response.result);
          }
        }
      }
    } else if ('method' in message) {
      // 通知或 Server 发起的请求
      const request = message as JsonRpcRequest;
      if (request.id === undefined) {
        // 无 id 的是通知
        this.notificationCallback?.(request.method, request.params);
      }
    }
  }

  /**
   * 生成唯一的请求 ID
   */
  private generateId(): JsonRpcId {
    return this.nextId++;
  }
}
