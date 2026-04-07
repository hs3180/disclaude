/**
 * ACP Client
 *
 * ACP (Agent Communication Protocol) 客户端实现。
 * 通过 stdio 传输层与 ACP Server 通信，提供高层 API。
 *
 * 生命周期:
 * 1. connect() — 启动子进程，发送 initialize 握手
 * 2. sendTask() — 发送任务
 * 3. cancelTask() — 取消任务
 * 4. disconnect() — 断开连接
 *
 * @see https://github.com/openai/agentic-communication-protocol
 * @see Issue #1333
 */

import type {
  AcpClientInfo,
  AcpInitializeResult,
  AcpServerCapabilities,
  AcpServerInfo,
  AcpTaskCancelParams,
  AcpTaskCancelResult,
  AcpTaskMessage,
  AcpTaskMetadata,
  AcpTaskPriority,
  AcpTaskSendParams,
  AcpTaskSendResult,
  AcpTaskStatusNotification,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
} from './types.js';
import { AcpStdioTransport, type IAcpTransport, type TransportMessageListener } from './transport.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('AcpClient');

/** 默认客户端信息 */
const DEFAULT_CLIENT_INFO: AcpClientInfo = {
  name: 'disclaude-acp-client',
  version: '0.1.0',
};

/** 默认请求超时（30 秒） */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * ACP Client 状态
 */
export type AcpClientState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * ACP Client 配置
 *
 * 支持通过 transport 字段注入自定义传输层实现（用于测试）。
 */
export interface AcpClientOptions {
  /** 传输层配置或自定义传输层实例 */
  readonly transport: AcpStdioTransportConfig | IAcpTransport;
  /** 客户端信息 */
  readonly clientInfo?: AcpClientInfo;
  /** 请求超时（毫秒） */
  readonly requestTimeoutMs?: number;
}

/**
 * ACP Client
 *
 * 提供 ACP 协议的高层 API，通过 stdio 传输层与 ACP Server 通信。
 * 支持依赖注入：可通过 transport 字段传入自定义 IAcpTransport 实例。
 */
export class AcpClient {
  private transport: IAcpTransport;
  private clientInfo: AcpClientInfo;
  private requestTimeoutMs: number;
  private state: AcpClientState = 'disconnected';
  private initializeResult: AcpInitializeResult | null = null;

  /** Pending JSON-RPC requests waiting for responses */
  private pendingRequests = new Map<
    string | number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /** Task state change listeners */
  private taskStatusListeners = new Map<
    string,
    Set<(notification: AcpTaskStatusNotification) => void>
  >();

  constructor(options: AcpClientOptions) {
    // Support dependency injection: accept either config (creates AcpStdioTransport)
    // or an existing IAcpTransport instance
    this.transport = 'connect' in options.transport && typeof options.transport.connect === 'function'
      ? options.transport as IAcpTransport
      : new AcpStdioTransport(options.transport as AcpStdioTransportConfig);
    this.clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    // Register transport message handler
    this.transport.onMessage(this.handleMessage.bind(this));
    this.transport.onError(this.handleTransportError.bind(this));
    this.transport.onClose(this.handleTransportClose.bind(this));
  }

  // ==========================================================================
  // 连接生命周期
  // ==========================================================================

  /**
   * 连接到 ACP Server
   *
   * 启动子进程并发送 initialize 握手请求。
   *
   * @returns 初始化结果（服务器能力和信息）
   * @throws 如果连接失败或初始化超时
   */
  async connect(): Promise<AcpInitializeResult> {
    if (this.state === 'connected') {
      throw new Error('Client is already connected');
    }

    this.state = 'connecting';

    try {
      // Start the child process
      await this.transport.connect();

      // Send initialize handshake
      this.initializeResult = await this.sendRequest<AcpInitializeResult>(
        'initialize',
        {
          capabilities: {
            protocolVersions: ['2025-03-26'],
          },
          clientInfo: this.clientInfo,
        }
      );

      this.state = 'connected';
      logger.info(
        {
          protocolVersion: this.initializeResult.protocolVersion,
          serverInfo: this.initializeResult.serverInfo,
        },
        'ACP client connected'
      );

      return this.initializeResult;
    } catch (err) {
      this.state = 'error';
      this.disconnect();
      throw err;
    }
  }

  /**
   * 断开连接
   *
   * 终止子进程并清理所有 pending 请求。
   */
  disconnect(): void {
    // Clear all timers and reject pending requests
    // Note: Copy entries first to avoid concurrent modification
    const entries = [...this.pendingRequests.entries()];
    this.pendingRequests.clear();

    for (const [, pending] of entries) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Client disconnected'));
    }

    // Clear task status listeners
    this.taskStatusListeners.clear();

    // Disconnect transport
    this.transport.disconnect();

    this.state = 'disconnected';
    this.initializeResult = null;

    logger.info('ACP client disconnected');
  }

  // ==========================================================================
  // 任务操作
  // ==========================================================================

  /**
   * 发送任务到 ACP Server
   *
   * @param message - 任务消息
   * @param metadata - 任务元数据（可选）
   * @returns 任务发送结果（包含 taskId 和初始状态）
   */
  // eslint-disable-next-line require-await
  async sendTask(
    message: AcpTaskMessage,
    metadata?: AcpTaskMetadata & { priority?: AcpTaskPriority }
  ): Promise<AcpTaskSendResult> {
    this.ensureConnected();

    const params: AcpTaskSendParams = { message };
    if (metadata) {
      params.metadata = metadata;
    }

    return this.sendRequest<AcpTaskSendResult>('tasks/send', params);
  }

  /**
   * 取消正在执行的任务
   *
   * @param taskId - 任务 ID
   * @returns 取消结果
   */
  // eslint-disable-next-line require-await
  async cancelTask(taskId: string): Promise<AcpTaskCancelResult> {
    this.ensureConnected();

    const params: AcpTaskCancelParams = { taskId };
    return this.sendRequest<AcpTaskCancelResult>('tasks/cancel', params);
  }

  // ==========================================================================
  // 事件监听
  // ==========================================================================

  /**
   * 监听任务状态变更
   *
   * @param taskId - 任务 ID
   * @param listener - 状态变更监听器
   * @returns 取消监听函数
   */
  onTaskStatus(
    taskId: string,
    listener: (notification: AcpTaskStatusNotification) => void
  ): () => void {
    let listeners = this.taskStatusListeners.get(taskId);
    if (!listeners) {
      listeners = new Set();
      this.taskStatusListeners.set(taskId, listeners);
    }
    listeners.add(listener);

    return () => {
      const currentListeners = this.taskStatusListeners.get(taskId);
      if (currentListeners) {
        currentListeners.delete(listener);
        if (currentListeners.size === 0) {
          this.taskStatusListeners.delete(taskId);
        }
      }
    };
  }

  // ==========================================================================
  // 状态查询
  // ==========================================================================

  /**
   * 获取客户端当前状态
   */
  getState(): AcpClientState {
    return this.state;
  }

  /**
   * 获取服务器能力（连接后可用）
   */
  getServerCapabilities(): AcpServerCapabilities | null {
    return this.initializeResult?.capabilities ?? null;
  }

  /**
   * 获取服务器信息（连接后可用）
   */
  getServerInfo(): AcpServerInfo | null {
    return this.initializeResult?.serverInfo ?? null;
  }

  /**
   * 获取协商后的协议版本
   */
  getProtocolVersion(): string | null {
    return this.initializeResult?.protocolVersion ?? null;
  }

  /**
   * 客户端是否已连接
   */
  get isConnected(): boolean {
    return this.state === 'connected';
  }

  // ==========================================================================
  // 内部方法
  // ==========================================================================

  /**
   * 确保客户端已连接
   */
  private ensureConnected(): void {
    if (this.state !== 'connected') {
      throw new Error(`Client is not connected (current state: ${this.state})`);
    }
  }

  /**
   * 发送 JSON-RPC 请求并等待响应
   */
  private sendRequest<TResult>(
    method: string,
    params: Record<string, unknown>
  ): Promise<TResult> {
    const promise = new Promise<TResult>((resolve, reject) => {
      const id = this.generateId();

      // Set up timeout
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(
          `Request '${method}' timed out after ${this.requestTimeoutMs}ms`
        ));
      }, this.requestTimeoutMs);

      // Store pending request
      this.pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });

      // Send request
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      try {
        this.transport.send(request);
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });

    // Prevent unhandled rejections from cleanup (disconnect/timeout)
    // when the caller has already stopped awaiting
    promise.catch(() => {});

    return promise;
  }

  /**
   * 处理从传输层接收到的消息
   */
  private handleMessage: TransportMessageListener = (message: JsonRpcMessage) => {
    // Check if this is a response to a pending request
    if ('id' in message && message.id !== undefined && message.id !== null) {
      const pending = this.pendingRequests.get(message.id as string | number);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.id as string | number);

        if ('error' in message) {
          const errorResponse = message as JsonRpcErrorResponse;
          pending.reject(
            new AcpError(
              errorResponse.error.message,
              errorResponse.error.code,
              errorResponse.error.data
            )
          );
        } else {
          const successResponse = message as JsonRpcSuccessResponse;
          pending.resolve(successResponse.result);
        }
        return;
      }
    }

    // Handle notifications
    if (!('id' in message)) {
      this.handleNotification(message);
    }
  };

  /**
   * 处理通知消息
   */
  private handleNotification(message: JsonRpcMessage): void {
    if (!('method' in message)) {
      return;
    }

    const { method } = message as { method: string };

    switch (method) {
      case 'notifications/task/status': {
        const params = (message as { params?: unknown }).params as AcpTaskStatusNotification | undefined;
        if (params?.taskId) {
          this.notifyTaskStatus(params);
        }
        break;
      }

      default:
        logger.debug({ method }, 'Unhandled ACP notification');
    }
  }

  /**
   * 通知任务状态监听器
   */
  private notifyTaskStatus(notification: AcpTaskStatusNotification): void {
    const listeners = this.taskStatusListeners.get(notification.taskId);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(notification);
        } catch (err) {
          logger.error({ err, taskId: notification.taskId }, 'Task status listener error');
        }
      }
    }
  }

  /**
   * 处理传输层错误
   */
  private handleTransportError(error: Error): void {
    if (this.state === 'connecting') {
      // Error during connection will be propagated via connect() promise
      return;
    }

    this.state = 'error';
    logger.error({ err: error }, 'ACP transport error');

    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  /**
   * 处理传输层关闭
   */
  private handleTransportClose(_code: number | null, _signal: string | null): void {
    if (this.state === 'connected') {
      this.state = 'disconnected';
      logger.info('ACP transport closed unexpectedly');

      // Reject all pending requests
      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Transport closed'));
      }
      this.pendingRequests.clear();
    }
  }

  /**
   * 生成唯一的请求 ID
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}

/**
 * ACP 协议错误
 */
export class AcpError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = 'AcpError';
    this.code = code;
    this.data = data;
  }
}
