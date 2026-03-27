/**
 * ACP 连接管理器
 *
 * 管理 ACP Client 与 Server 之间的连接生命周期：
 * - 建立连接并完成能力协商
 * - 管理 JSON-RPC 请求/响应匹配
 * - 处理通知消息的分发
 * - 连接断开和清理
 *
 * @module sdk/providers/acp/connection
 */

import { EventEmitter } from 'node:events';
import { createLogger } from '../../../utils/logger.js';
import {
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcSuccessResponse,
  type JsonRpcErrorResponse,
  type JsonRpcNotification,
  type AcpTransportConfig,
  type AcpClientCapabilities,
  type AcpServerCapabilities,
  type AcpInitializeParams,
  type AcpInitializeResult,
  AcpMethod,
} from './types.js';
import { createTransport, type IAcpTransport } from './transport.js';

const logger = createLogger('AcpConnection');

/** 连接状态 */
export type AcpConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/** 待处理请求的解析器 */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 连接管理器配置 */
export interface AcpConnectionConfig {
  /** 传输层配置（与 transport 二选一） */
  transportConfig?: AcpTransportConfig;
  /** 自定义传输层实例（与 transportConfig 二选一，用于测试或高级场景） */
  transport?: IAcpTransport;
  /** 客户端名称（默认: disclaude） */
  clientName?: string;
  /** 客户端版本（默认: 0.1.0） */
  clientVersion?: string;
  /** 客户端能力声明 */
  capabilities?: AcpClientCapabilities;
  /** 请求超时时间（毫秒，默认: 30000） */
  requestTimeout?: number;
}

/**
 * ACP 连接管理器
 *
 * 封装传输层，提供：
 * - 连接建立和能力协商
 * - JSON-RPC 请求/响应匹配（通过 id）
 * - 通知消息分发
 * - 自动重连和错误处理
 *
 * @example
 * ```typescript
 * const connection = new AcpConnection({
 *   type: 'stdio',
 *   command: 'npx',
 *   args: ['@openai/acp-server'],
 *   env: { OPENAI_API_KEY: '...' },
 * });
 *
 * const serverCapabilities = await connection.connect();
 * console.log('Server models:', serverCapabilities.models);
 *
 * connection.onNotification('acp/notification/message', (params) => {
 *   console.log('Message from agent:', params.message);
 * });
 *
 * const result = await connection.sendRequest('acp/task/send', { taskId: '...', message: {...} });
 * connection.disconnect();
 * ```
 */
export class AcpConnection extends EventEmitter {
  private transport: IAcpTransport;
  private state: AcpConnectionState = 'disconnected';
  private pendingRequests = new Map<string | number, PendingRequest>();
  private serverCapabilities: AcpServerCapabilities | null = null;
  private protocolVersion = '';
  private nextId = 1;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly capabilities: AcpClientCapabilities;
  private readonly requestTimeout: number;

  /**
   * 使用传输层配置创建连接
   *
   * @param config - 传输层配置
   */
  constructor(config: AcpTransportConfig);

  /**
   * 使用完整配置创建连接
   *
   * @param config - 完整连接配置
   */
  constructor(config: AcpConnectionConfig);

  /**
   * 使用自定义传输层实例创建连接（依赖注入，用于测试）
   *
   * @param transport - 自定义传输层实例
   * @param options - 可选的连接选项
   */
  constructor(transport: IAcpTransport, options?: {
    clientName?: string;
    clientVersion?: string;
    capabilities?: AcpClientCapabilities;
    requestTimeout?: number;
  });

  constructor(
    configOrTransport: AcpConnectionConfig | AcpTransportConfig | IAcpTransport,
    options?: {
      clientName?: string;
      clientVersion?: string;
      capabilities?: AcpClientCapabilities;
      requestTimeout?: number;
    }
  ) {
    super();

    // Determine if we received a transport instance or config
    if ('onMessage' in configOrTransport && 'send' in configOrTransport && 'connect' in configOrTransport) {
      // Direct transport instance (dependency injection)
      this.transport = configOrTransport as IAcpTransport;
      this.clientName = options?.clientName ?? 'disclaude';
      this.clientVersion = options?.clientVersion ?? '0.1.0';
      this.capabilities = options?.capabilities ?? {
        inputFormats: ['text', 'content_blocks'],
        toolFormats: ['tool_use', 'tool_result'],
        streaming: true,
      };
      this.requestTimeout = options?.requestTimeout ?? 30000;
    } else {
      // Config object
      const config = configOrTransport as AcpConnectionConfig | AcpTransportConfig;
      if ('transportConfig' in config && config.transportConfig) {
        this.transport = createTransport(config.transportConfig);
      } else if ('type' in config) {
        this.transport = createTransport(config as AcpTransportConfig);
      } else if ('transport' in config && config.transport) {
        this.transport = config.transport;
      } else {
        throw new Error('AcpConnection requires transportConfig, transport, or a valid AcpTransportConfig');
      }
      const fullConfig = config as AcpConnectionConfig;
      this.clientName = fullConfig.clientName ?? 'disclaude';
      this.clientVersion = fullConfig.clientVersion ?? '0.1.0';
      this.capabilities = fullConfig.capabilities ?? {
        inputFormats: ['text', 'content_blocks'],
        toolFormats: ['tool_use', 'tool_result'],
        streaming: true,
      };
      this.requestTimeout = fullConfig.requestTimeout ?? 30000;
    }

    // 绑定传输层事件
    this.transport.onMessage((msg) => this.handleMessage(msg));
    this.transport.onError((err) => this.handleError(err));
    this.transport.onClose((code) => this.handleClose(code));
  }

  /**
   * 获取当前连接状态
   */
  getState(): AcpConnectionState {
    return this.state;
  }

  /**
   * 获取服务端能力声明（连接后可用）
   */
  getServerCapabilities(): AcpServerCapabilities | null {
    return this.serverCapabilities;
  }

  /**
   * 获取协议版本
   */
  getProtocolVersion(): string {
    return this.protocolVersion;
  }

  /**
   * 是否已连接
   */
  get isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * 建立连接并完成能力协商
   *
   * 1. 启动传输层（如 stdio 子进程）
   * 2. 发送 acp/initialize 请求
   * 3. 验证服务端能力声明
   * 4. 标记连接为已建立
   *
   * @returns 服务端能力声明
   * @throws 如果连接或协商失败
   */
  async connect(): Promise<AcpServerCapabilities> {
    if (this.state === 'connected') {
      return this.serverCapabilities ?? { models: [], toolUse: false, streaming: false };
    }

    this.state = 'connecting';
    this.emit('state-change', this.state);

    try {
      // Step 1: 建立传输层连接
      await this.transport.connect();

      // Step 2: 发送 acp/initialize 进行能力协商
      // 使用 doSendRequest 因为此时 state='connecting'，isConnected=false
      const initResult = await this.doSendRequest<AcpInitializeResult>(
        AcpMethod.INITIALIZE,
        {
          clientName: this.clientName,
          clientVersion: this.clientVersion,
          capabilities: this.capabilities,
        } satisfies AcpInitializeParams
      );

      // Step 3: 保存服务端能力
      this.serverCapabilities = initResult.capabilities;
      this.protocolVersion = initResult.protocolVersion;

      // Step 4: 标记为已连接
      this.state = 'connected';
      this.emit('state-change', this.state);

      logger.info(
        {
          serverName: initResult.serverName,
          serverVersion: initResult.serverVersion,
          protocolVersion: initResult.protocolVersion,
          models: initResult.capabilities.models?.map(m => m.id),
        },
        'ACP connection established'
      );

      return initResult.capabilities;
    } catch (error) {
      this.state = 'error';
      this.emit('state-change', this.state);
      throw error;
    }
  }

  /**
   * 发送 JSON-RPC 请求并等待响应
   *
   * 自动分配请求 ID 并设置超时。
   *
   * @param method - 方法名
   * @param params - 方法参数
   * @returns 响应结果
   * @throws 如果请求超时或服务端返回错误
   */
  sendRequest<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.isConnected) {
      return Promise.reject(new Error('ACP connection is not established'));
    }

    return this.doSendRequest<T>(method, params);
  }

  /**
   * 内部发送请求方法（不检查连接状态）
   *
   * 用于 initialize 握手阶段（此时 state='connecting'，isConnected=false）。
   */
  private doSendRequest<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    return new Promise<T>((resolve, reject) => {
      // 设置超时
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`ACP request '${method}' timed out after ${this.requestTimeout}ms`));
      }, this.requestTimeout);

      // 注册待处理请求
      this.pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });

      // 发送请求
      this.transport.send(request);
    });
  }

  /**
   * 发送 JSON-RPC 通知（不期望响应）
   *
   * @param method - 方法名
   * @param params - 方法参数
   */
  sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.isConnected) {
      logger.warn(`Cannot send notification '${method}': not connected`);
      return;
    }

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };

    this.transport.send(notification);
  }

  /**
   * 注册通知处理器
   *
   * @param method - 通知方法名（如 'acp/notification/message'）
   * @param handler - 通知处理函数
   */
  onNotification(
    method: string,
    handler: (params: Record<string, unknown>) => void
  ): void {
    this.on(`notification:${method}`, handler);
  }

  /**
   * 移除通知处理器
   */
  offNotification(
    method: string,
    handler: (params: Record<string, unknown>) => void
  ): void {
    this.off(`notification:${method}`, handler);
  }

  /**
   * 断开连接
   *
   * 拒绝所有待处理请求，关闭传输层。
   */
  disconnect(): void {
    // 拒绝所有待处理请求
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();

    // 关闭传输层
    this.transport.disconnect();

    // 重置状态
    this.state = 'disconnected';
    this.serverCapabilities = null;
    this.protocolVersion = '';
    this.emit('state-change', this.state);

    logger.info('ACP connection disconnected');
  }

  /**
   * 处理收到的 JSON-RPC 消息
   */
  private handleMessage(message: JsonRpcMessage): void {
    // 判断消息类型：有 id 字段的是响应，否则是通知
    if ('id' in message && message.id !== undefined) {
      this.handleResponse(message as JsonRpcSuccessResponse | JsonRpcErrorResponse);
    } else if ('method' in message) {
      this.handleNotificationMessage(message as JsonRpcNotification);
    } else {
      logger.warn({ message }, 'Received unrecognized ACP message');
    }
  }

  /**
   * 处理 JSON-RPC 响应
   */
  private handleResponse(message: JsonRpcSuccessResponse | JsonRpcErrorResponse): void {
    const requestId = message.id;
    if (requestId === null || requestId === undefined) {
      logger.warn('Received response with null/undefined id');
      return;
    }

    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      logger.warn({ id: requestId }, 'Received response for unknown request');
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);

    if ('result' in message) {
      pending.resolve(message.result);
    } else if ('error' in message) {
      const {error} = message;
      pending.reject(new Error(
        `ACP error ${error.code}: ${error.message}${error.data ? ` (${JSON.stringify(error.data)})` : ''}`
      ));
    }
  }

  /**
   * 处理 JSON-RPC 通知
   */
  private handleNotificationMessage(message: JsonRpcNotification): void {
    const { method, params } = message;
    logger.debug({ method }, 'ACP notification received');
    this.emit(`notification:${method}`, params ?? {});
  }

  /**
   * 处理传输层错误
   */
  private handleError(error: Error): void {
    logger.error({ err: error }, 'ACP transport error');
    this.state = 'error';
    this.emit('state-change', this.state);
    this.emit('error', error);
  }

  /**
   * 处理传输层关闭
   */
  private handleClose(code: number | null): void {
    logger.info({ code }, 'ACP transport closed');
    if (this.state !== 'disconnected') {
      this.state = 'disconnected';
      this.emit('state-change', this.state);
      this.emit('close', code);
    }
  }
}
