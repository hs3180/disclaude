/**
 * ACP 连接管理器
 *
 * 管理与 ACP Server 的连接生命周期，包括：
 * - 初始化握手和能力协商
 * - 请求/响应关联（通过 JSON-RPC ID）
 * - 消息路由和事件分发
 *
 * Issue #1333: 支持OpenAI Agent - PR A (ACP 协议基础设施)
 */

import { createLogger } from '../../utils/logger.js';
import type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcResponse,
  AcpInitializeParams,
  AcpInitializeResult,
  AcpServerCapabilities,
} from './types.js';
import {
  AcpMethod,
  createJsonRpcRequest,
  createJsonRpcErrorResponse,
  JsonRpcErrorCode,
} from './types.js';
import type { IAcpTransport } from './transport.js';

const logger = createLogger('AcpConnection');

// ============================================================================
// 连接状态
// ============================================================================

/** ACP 连接状态 */
export type AcpConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

// ============================================================================
// 连接事件
// ============================================================================

/** 连接事件映射 */
export interface AcpConnectionEvents {
  /** 收到通知消息 */
  notification: (method: string, params: unknown) => void;
  /** 连接状态变更 */
  stateChange: (state: AcpConnectionState) => void;
  /** 错误 */
  error: (error: Error) => void;
}

// ============================================================================
// 待处理请求
// ============================================================================

/** 待处理请求条目 */
interface PendingRequest {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ============================================================================
// 常量
// ============================================================================

/** 默认请求超时时间（毫秒） */
const DEFAULT_REQUEST_TIMEOUT = 30_000;

/** ACP 客户端信息 */
const CLIENT_INFO = {
  name: 'disclaude',
  version: '0.0.1',
} as const;

// ============================================================================
// ACP 连接管理器
// ============================================================================

/**
 * ACP 连接管理器
 *
 * 管理与 ACP Server 的连接，处理初始化握手、消息路由和请求关联。
 */
export class AcpConnection {
  private transport: IAcpTransport;
  private _state: AcpConnectionState = 'disconnected';
  private serverCapabilities: AcpServerCapabilities | null = null;
  private serverInfo: { name: string; version: string } | null = null;
  private protocolVersion: string | null = null;
  private pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private nextId = 1;
  private requestTimeout: number;
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  /**
   * @param transport - 传输层实例
   * @param options - 连接选项
   */
  constructor(
    transport: IAcpTransport,
    options?: { requestTimeout?: number },
  ) {
    this.transport = transport;
    this.requestTimeout = options?.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;

    // 注册传输层事件
    this.transport.onMessage((message) => this.handleMessage(message));
    this.transport.onError((error) => this.handleError(error));
    this.transport.onClose(() => this.handleClose());
  }

  // ==========================================================================
  // 属性
  // ==========================================================================

  /** 连接状态 */
  get state(): AcpConnectionState {
    return this._state;
  }

  /** 服务端能力（连接成功后可用） */
  get capabilities(): AcpServerCapabilities | null {
    return this.serverCapabilities;
  }

  /** 服务端信息 */
  get serverInfoValue(): { name: string; version: string } | null {
    return this.serverInfo;
  }

  /** 协议版本 */
  get protocolVersionValue(): string | null {
    return this.protocolVersion;
  }

  // ==========================================================================
  // 连接管理
  // ==========================================================================

  /**
   * 连接到 ACP Server 并完成初始化握手
   *
   * @param clientCapabilities - 客户端能力声明
   * @param transportType - 传输方式
   */
  async connect(
    clientCapabilities?: AcpInitializeParams['capabilities'],
    transportType: 'stdio' | 'sse' = 'stdio',
  ): Promise<void> {
    if (this._state === 'connected') {
      return;
    }

    this.setState('connecting');

    try {
      // 建立传输层连接
      await this.transport.connect();

      // 发送 initialize 请求
      const initParams: AcpInitializeParams = {
        clientInfo: CLIENT_INFO,
        capabilities:
          clientCapabilities ?? {
            transports: ['stdio', 'sse'],
            streaming: true,
          },
        transport: transportType,
      };

      const initResult = await this.sendRequest<AcpInitializeResult>(
        AcpMethod.INITIALIZE,
        initParams,
      );

      this.serverCapabilities = initResult.capabilities;
      this.serverInfo = initResult.serverInfo;
      this.protocolVersion = initResult.protocolVersion;

      // 发送 initialized 通知
      await this.transport.send({
        jsonrpc: '2.0',
        method: AcpMethod.INITIALIZED,
      });

      this.setState('connected');
      logger.info(
        {
          server: initResult.serverInfo,
          protocol: initResult.protocolVersion,
          capabilities: initResult.capabilities,
        },
        'ACP connection established',
      );
    } catch (error) {
      this.setState('error');
      throw error;
    }
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    // 拒绝所有待处理请求
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
      this.pendingRequests.delete(id);
    }

    await this.transport.disconnect();
    this.setState('disconnected');
    this.serverCapabilities = null;
    this.serverInfo = null;
    this.protocolVersion = null;
  }

  // ==========================================================================
  // 消息发送
  // ==========================================================================

  /**
   * 发送 JSON-RPC 请求并等待响应
   *
   * @param method - 方法名称
   * @param params - 请求参数
   * @param timeout - 超时时间（毫秒），默认使用连接配置
   * @returns 响应结果
   */
  async sendRequest<TResult = unknown>(
    method: string,
    params?: unknown,
    timeout?: number,
  ): Promise<TResult> {
    const id = this.generateId();
    const request = createJsonRpcRequest(method, params, id);

    return new Promise<TResult>((resolve, reject) => {
      const actualTimeout = timeout ?? this.requestTimeout;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(`Request ${method} timed out after ${actualTimeout}ms`),
        );
      }, actualTimeout);

      this.pendingRequests.set(id, {
        resolve,
        reject,
        timer,
      });

      this.transport.send(request).catch((error: Error) => {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error);
      });
    });
  }

  /**
   * 发送 JSON-RPC 通知（不等待响应）
   *
   * @param method - 方法名称
   * @param params - 通知参数
   */
  async sendNotification(method: string, params?: unknown): Promise<void> {
    await this.transport.send({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined && { params }),
    });
  }

  // ==========================================================================
  // 事件监听
  // ==========================================================================

  /**
   * 注册事件监听器
   */
  on<K extends keyof AcpConnectionEvents>(
    event: K,
    handler: AcpConnectionEvents[K],
  ): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners
      .get(event)!
      .add(handler as (...args: unknown[]) => void);
  }

  /**
   * 移除事件监听器
   */
  off<K extends keyof AcpConnectionEvents>(
    event: K,
    handler: AcpConnectionEvents[K],
  ): void {
    this.listeners
      .get(event)
      ?.delete(handler as (...args: unknown[]) => void);
  }

  // ==========================================================================
  // 内部方法
  // ==========================================================================

  /**
   * 处理接收到的消息
   */
  private handleMessage(message: JsonRpcMessage): void {
    // 响应：匹配待处理请求
    if ('result' in message || 'error' in message) {
      const response = message as JsonRpcResponse;
      const id = response.id;

      if (id !== null && id !== undefined) {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(id);

          if ('error' in response) {
            const err = response.error;
            pending.reject(
              new Error(`JSON-RPC error ${err.code}: ${err.message}`),
            );
          } else {
            // Extract the result from the success response
            pending.resolve(
              ('result' in response ? response.result : undefined),
            );
          }
        } else {
          logger.warn({ id }, 'Received response for unknown request');
        }
      }
      return;
    }

    // 通知或请求：分发给监听器
    if ('method' in message) {
      const method = message.method;
      const params = 'params' in message ? message.params : undefined;

      // 如果有 id，则视为请求（需要响应）
      if ('id' in message && message.id !== undefined) {
        logger.warn(
          { method, id: message.id },
          'Received unexpected request from server',
        );
        void this.transport.send(
          createJsonRpcErrorResponse(
            JsonRpcErrorCode.METHOD_NOT_FOUND,
            `Method not found: ${method}`,
            message.id as JsonRpcId,
          ),
        );
        return;
      }

      // 通知：分发给 notification 监听器
      const handlers = this.listeners.get('notification');
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(method, params);
          } catch (error) {
            logger.error({ err: error, method }, 'Notification handler error');
          }
        }
      }
    }
  }

  private handleError(error: Error): void {
    const handlers = this.listeners.get('error');
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(error);
        } catch (handlerError) {
          logger.error({ err: handlerError }, 'Error handler error');
        }
      }
    }
  }

  private handleClose(): void {
    // 拒绝所有待处理请求
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
      this.pendingRequests.delete(id);
    }

    if (this._state === 'connected') {
      this.setState('disconnected');
    }
  }

  private setState(state: AcpConnectionState): void {
    const previous = this._state;
    this._state = state;

    if (previous !== state) {
      const handlers = this.listeners.get('stateChange');
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(state);
          } catch (error) {
            logger.error(
              { err: error },
              'State change handler error',
            );
          }
        }
      }
    }
  }

  private generateId(): JsonRpcId {
    return this.nextId++;
  }
}
