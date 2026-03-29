/**
 * ACP 客户端
 *
 * 管理 ACP 协议的连接生命周期、能力协商和消息路由。
 * 封装 JSON-RPC 请求/响应的关联，并通过事件回调处理通知。
 *
 * @see Issue #1333 - 支持OpenAI Agent
 */

import { createLogger } from '../../../utils/logger.js';
import { AcpStdioTransport } from './transport.js';
import {
  ACP_PROTOCOL_VERSION,
  AcpMethod,
  isJsonRpcResponse,
  isJsonRpcNotification,
  isAcpTaskNotification,
  type AcpTransportConfig,
  type AcpInitializeResult,
  type AcpTaskSendParams,
  type AcpTaskSendResult,
  type AcpTaskCancelResult,
  type AcpTaskNotificationParams,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type AcpClientCapabilities,
} from './types.js';

const logger = createLogger('AcpClient');

/** ACP 任务通知回调 */
export type AcpTaskNotificationCallback = (params: AcpTaskNotificationParams) => void;

/**
 * ACP 客户端
 *
 * 负责：
 * 1. 通过 stdio 传输层连接 ACP 服务端
 * 2. 执行 initialize 握手和能力协商
 * 3. 发送 JSON-RPC 请求并关联响应
 * 4. 路由通知到对应的回调处理器
 */
export class AcpClient {
  private transport: AcpStdioTransport;
  private requestId = 0;
  private pendingRequests = new Map<string | number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private notificationCallbacks = new Map<string, AcpTaskNotificationCallback>();
  private _initialized = false;
  private _initializeResult: AcpInitializeResult | null = null;

  constructor(config: AcpTransportConfig) {
    this.transport = new AcpStdioTransport(config);

    // 绑定传输层事件
    this.transport.onMessage((message) => this.handleMessage(message));
    this.transport.setErrorHandler((error) => this.handleTransportError(error));
    this.transport.setCloseHandler((code, signal) => {
      logger.info({ code, signal }, 'ACP transport closed');
      // 拒绝所有待处理请求
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`ACP connection closed (request ${id})`));
      }
      this.pendingRequests.clear();
      this._initialized = false;
    });
  }

  /** 是否已初始化 */
  get initialized(): boolean {
    return this._initialized;
  }

  /** 初始化结果（包含服务端能力信息） */
  get initializeResult(): AcpInitializeResult | null {
    return this._initializeResult;
  }

  /** 客户端信息 */
  readonly clientInfo = {
    name: 'disclaude',
    version: '1.0.0',
  };

  /** 客户端能力声明 */
  readonly capabilities: AcpClientCapabilities = {
    streaming: true,
    pushNotifications: true,
  };

  /**
   * 连接到 ACP 服务端并完成初始化握手
   *
   * @throws 如果连接失败或初始化握手失败
   */
  async connect(): Promise<AcpInitializeResult> {
    // 连接传输层
    await this.transport.connect();

    // 执行初始化握手
    const result = await this.sendRequest<AcpInitializeResult>(AcpMethod.Initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: this.clientInfo,
      capabilities: this.capabilities,
    });

    this._initialized = true;
    this._initializeResult = result;

    logger.info(
      {
        serverInfo: result.serverInfo,
        capabilities: result.capabilities,
        protocolVersion: result.protocolVersion,
      },
      'ACP client initialized'
    );

    return result;
  }

  /**
   * 发送任务到 ACP 服务端
   *
   * @param params - 任务参数（消息和选项）
   * @returns 任务 ID
   */
  async sendTask(params: AcpTaskSendParams): Promise<string> {
    this.ensureInitialized();

    const result = await this.sendRequest<AcpTaskSendResult>(AcpMethod.TaskSend, params);
    return result.taskId;
  }

  /**
   * 取消正在执行的任务
   *
   * @param taskId - 任务 ID
   */
  async cancelTask(taskId: string): Promise<boolean> {
    this.ensureInitialized();

    const result = await this.sendRequest<AcpTaskCancelResult>(AcpMethod.TaskCancel, {
      taskId,
    });
    return result.cancelled;
  }

  /**
   * 注册任务通知回调
   *
   * 当服务端推送任务状态更新时调用。
   *
   * @param taskId - 任务 ID
   * @param callback - 通知回调
   */
  onTaskNotification(taskId: string, callback: AcpTaskNotificationCallback): void {
    this.notificationCallbacks.set(taskId, callback);
  }

  /**
   * 移除任务通知回调
   *
   * @param taskId - 任务 ID
   */
  removeTaskNotification(taskId: string): void {
    this.notificationCallbacks.delete(taskId);
  }

  /**
   * 断开连接并清理资源
   */
  disconnect(): void {
    // 拒绝所有待处理请求
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`ACP client disconnecting (request ${id})`));
    }
    this.pendingRequests.clear();
    this.notificationCallbacks.clear();

    this.transport.disconnect();
    this._initialized = false;
    this._initializeResult = null;

    logger.info('ACP client disconnected');
  }

  /**
   * 发送 JSON-RPC 请求并等待响应
   */
  private sendRequest<TResult>(
    method: string,
    params: unknown,
    timeoutMs: number = 30000
  ): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      const id = ++this.requestId;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`ACP request timeout: ${method} (id: ${id}, ${timeoutMs}ms)`));
      }, timeoutMs);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.pendingRequests.set(id, { resolve: resolve as any, reject, timer });

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.transport.send(request);
    });
  }

  /**
   * 处理从传输层收到的消息
   *
   * 路由 JSON-RPC 响应和通知到对应的处理器。
   */
  private handleMessage(message: unknown): void {
    // JSON-RPC 响应
    if (isJsonRpcResponse(message)) {
      this.handleResponse(message);
      return;
    }

    // ACP 任务通知
    if (isAcpTaskNotification(message)) {
      if (message.params) {
        this.handleTaskNotification(message.params);
      }
      return;
    }

    // 其他 JSON-RPC 通知
    if (isJsonRpcNotification(message)) {
      logger.debug(
        { method: message.method, params: message.params },
        'ACP notification received'
      );
      return;
    }

    logger.warn({ message }, 'ACP client received unknown message type');
  }

  /**
   * 处理 JSON-RPC 响应
   */
  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      logger.warn({ id: response.id }, 'ACP received response for unknown request');
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(response.id);

    if (response.error) {
      const error = new Error(
        `ACP error ${response.error.code}: ${response.error.message}`
      );
      pending.reject(error);
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * 处理 ACP 任务通知
   */
  private handleTaskNotification(params: AcpTaskNotificationParams): void {
    const callback = this.notificationCallbacks.get(params.taskId);
    if (callback) {
      callback(params);
    } else {
      logger.debug(
        { taskId: params.taskId, type: params.type },
        'ACP task notification without registered callback'
      );
    }
  }

  /**
   * 处理传输层错误
   */
  private handleTransportError(error: Error): void {
    logger.error({ err: error }, 'ACP transport error');
    // 不需要额外处理 - setCloseHandler 会清理 pending requests
  }

  /**
   * 确保客户端已初始化
   */
  private ensureInitialized(): void {
    if (!this._initialized) {
      throw new Error('ACP client not initialized. Call connect() first.');
    }
  }
}
