/**
 * ACP 客户端
 *
 * 实现 JSON-RPC 2.0 消息处理、请求/响应关联、通知分发，
 * 以及 ACP 协议的能力协商和任务管理。
 *
 * @module acp/client
 * @see Issue #1333 - 支持OpenAI Agent via ACP
 */

import { EventEmitter } from 'node:events';
import {
  AcpMethod,
  AcpNotification as AcpNotifConst,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcMessage,
  type AcpInitializeParams,
  type AcpInitializeResult,
  type AcpTaskCreateParams,
  type AcpTaskCreateResult,
  type AcpTaskSendParams,
  type AcpTaskCancelParams,
  type AcpTaskGetParams,
  type AcpTaskInfo,
  type AcpTaskCloseParams,
  type AcpTaskForkParams,
  type AcpTaskForkResult,
  type AcpTaskListResult,
  type AcpTransportConfig,
  type AcpAgentCapabilities,
  type AcpTaskStatusNotification,
  type AcpTaskMessageNotification,
  type AcpTaskArtefactNotification,
  type AcpClientEvents,
} from './types.js';
import { createTransport, type AcpTransport, type StdioTransport } from './transport.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AcpClient');

// ============================================================================
// ACP 客户端
// ============================================================================

/**
 * ACP 客户端
 *
 * 通过 JSON-RPC 2.0 协议与 ACP Agent 通信。
 * 支持 stdio 和 SSE 两种传输方式。
 *
 * @example
 * ```typescript
 * const client = new AcpClient({
 *   type: 'stdio',
 *   command: 'npx',
 *   args: ['-y', 'openai-acp-server'],
 * });
 *
 * const result = await client.connect({
 *   clientName: 'disclaude',
 *   clientVersion: '1.0.0',
 *   capabilities: { subscriptions: true },
 * });
 *
 * console.log(result.agentName, result.capabilities);
 * ```
 */
export class AcpClient extends EventEmitter<AcpClientEvents> {
  private transport: AcpTransport;
  private nextId = 0;
  private pendingRequests = new Map<JsonRpcId, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolve: (result: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private _connected = false;
  private _initialized = false;
  private _agentCapabilities: AcpAgentCapabilities = {};
  private _agentName = '';
  private _agentVersion = '';
  private _protocolVersion = '';

  /**
   * 创建 ACP 客户端
   *
   * @param transportConfig - 传输配置
   */
  constructor(transportConfig: AcpTransportConfig) {
    super();
    this.transport = createTransport(transportConfig);
  }

  // ==========================================================================
  // 状态属性
  // ==========================================================================

  /** 是否已连接 */
  get connected(): boolean {
    return this._connected;
  }

  /** 是否已完成初始化握手 */
  get initialized(): boolean {
    return this._initialized;
  }

  /** Agent 名称（初始化后可用） */
  get agentName(): string {
    return this._agentName;
  }

  /** Agent 版本（初始化后可用） */
  get agentVersion(): string {
    return this._agentVersion;
  }

  /** Agent 能力（初始化后可用） */
  get agentCapabilities(): AcpAgentCapabilities {
    return this._agentCapabilities;
  }

  /** 协议版本（初始化后可用） */
  get protocolVersion(): string {
    return this._protocolVersion;
  }

  // ==========================================================================
  // 连接管理
  // ==========================================================================

  /**
   * 连接并执行 ACP 初始化握手
   *
   * @param params - 初始化参数
   * @param timeout - 请求超时时间（毫秒），默认 30000
   * @returns 初始化结果
   */
  async connect(
    params: AcpInitializeParams,
    timeout: number = 30000
  ): Promise<AcpInitializeResult> {
    // 连接传输层
    if ('connect' in this.transport) {
      await (this.transport as StdioTransport).connect();
    }

    this._connected = true;

    // Register message handler for incoming JSON-RPC messages
    this.transport.onMessage((message) => this.handleMessage(message));

    // 监听传输层事件
    this.transport.on('close', () => {
      this._connected = false;
      this._initialized = false;
      this.rejectAllPending('Transport closed');
      this.emit('close');
    });

    this.transport.on('error', (err: unknown) => {
      this.emit('error', err as Error);
    });

    // 执行初始化握手
    const result = await this.sendRequest<AcpInitializeResult>(
      AcpMethod.INITIALIZE,
      params,
      timeout
    );

    this._agentName = result.agentName;
    this._agentVersion = result.agentVersion;
    this._agentCapabilities = result.capabilities;
    this._protocolVersion = result.protocolVersion;
    this._initialized = true;

    logger.info(
      {
        agentName: result.agentName,
        agentVersion: result.agentVersion,
        protocolVersion: result.protocolVersion,
        capabilities: result.capabilities,
      },
      'ACP initialized'
    );

    return result;
  }

  /**
   * 关闭连接
   */
  async close(): Promise<void> {
    this._connected = false;
    this._initialized = false;
    this.rejectAllPending('Client closed');
    await this.transport.close();
    this.removeAllListeners();
  }

  // ==========================================================================
  // 任务管理方法
  // ==========================================================================

  /**
   * 创建新任务
   *
   * @param params - 任务创建参数
   * @param timeout - 请求超时（毫秒）
   * @returns 任务信息
   */
  createTask(
    params?: AcpTaskCreateParams,
    timeout?: number
  ): Promise<AcpTaskCreateResult> {
    return this.sendRequest<AcpTaskCreateResult>(
      AcpMethod.TASK_CREATE,
      params ?? {},
      timeout
    );
  }

  /**
   * 发送消息到任务
   *
   * @param params - 任务消息参数
   * @param timeout - 请求超时（毫秒）
   */
  sendTaskMessage(
    params: AcpTaskSendParams,
    timeout?: number
  ): Promise<void> {
    return this.sendRequest<void>(
      AcpMethod.TASK_SEND,
      params,
      timeout
    );
  }

  /**
   * 取消任务
   *
   * @param params - 任务取消参数
   * @param timeout - 请求超时（毫秒）
   */
  cancelTask(
    params: AcpTaskCancelParams,
    timeout?: number
  ): Promise<void> {
    return this.sendRequest<void>(
      AcpMethod.TASK_CANCEL,
      params,
      timeout
    );
  }

  /**
   * 获取任务信息
   *
   * @param params - 任务获取参数
   * @param timeout - 请求超时（毫秒）
   * @returns 任务信息
   */
  getTask(
    params: AcpTaskGetParams,
    timeout?: number
  ): Promise<AcpTaskInfo> {
    return this.sendRequest<AcpTaskInfo>(
      AcpMethod.TASK_GET,
      params,
      timeout
    );
  }

  /**
   * 列出所有任务
   *
   * @param timeout - 请求超时（毫秒）
   * @returns 任务列表
   */
  listTasks(timeout?: number): Promise<AcpTaskListResult> {
    return this.sendRequest<AcpTaskListResult>(
      AcpMethod.TASK_LIST,
      undefined,
      timeout
    );
  }

  /**
   * 关闭任务
   *
   * @param params - 任务关闭参数
   * @param timeout - 请求超时（毫秒）
   */
  closeTask(
    params: AcpTaskCloseParams,
    timeout?: number
  ): Promise<void> {
    return this.sendRequest<void>(
      AcpMethod.TASK_CLOSE,
      params,
      timeout
    );
  }

  /**
   * 分叉任务
   *
   * @param params - 任务分叉参数
   * @param timeout - 请求超时（毫秒）
   * @returns 新任务信息
   */
  forkTask(
    params: AcpTaskForkParams,
    timeout?: number
  ): Promise<AcpTaskForkResult> {
    return this.sendRequest<AcpTaskForkResult>(
      AcpMethod.TASK_FORK,
      params,
      timeout
    );
  }

  // ==========================================================================
  // JSON-RPC 核心方法
  // ==========================================================================

  /**
   * 发送 JSON-RPC 请求并等待响应
   *
   * @param method - 方法名
   * @param params - 参数
   * @param timeout - 超时时间（毫秒），默认 30000
   * @returns 响应结果
   */
  sendRequest<T>(
    method: string,
    params: unknown,
    timeout: number = 30000
  ): Promise<T> {
    if (!this._connected) {
      return Promise.reject(new Error('Not connected'));
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
      id,
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout (${method}, id=${id}, ${timeout}ms)`));
      }, timeout);

      this.pendingRequests.set(id, {
        resolve,
        reject,
        timer,
      });

      this.transport.send(request).catch((err) => {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      });
    });
  }

  /**
   * 处理收到的 JSON-RPC 消息
   *
   * 区分响应（关联 pending request）和通知（分发事件）。
   */
  private handleMessage(message: JsonRpcMessage): void {
    // Check if this is a response (has 'id' and either 'result' or 'error')
    if ('id' in message && message.id !== undefined) {
      const response = message as JsonRpcResponse;
      const pending = this.pendingRequests.get(response.id);

      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(response.id);
        if ('error' in response) {
          const errMsg = response.error?.message ?? 'Unknown JSON-RPC error';
          pending.reject(new Error(errMsg));
        } else {
          pending.resolve(response.result);
        }
      } else {
        logger.warn({ id: response.id }, 'Received response for unknown request');
      }
      return;
    }

    // Otherwise it's a notification or request
    if ('method' in message) {
      const request = message as JsonRpcRequest;
      this.handleNotification(request.method, request.params);
    }
  }

  /**
   * 处理 ACP 通知
   *
   * 将通知转换为客户端事件。
   */
  private handleNotification(method: string, params: unknown): void {
    switch (method) {
      case AcpNotifConst.TASK_STATUS: {
        const notification = params as AcpTaskStatusNotification;
        this.emit('task:status', notification);
        break;
      }
      case AcpNotifConst.TASK_MESSAGE: {
        const notification = params as AcpTaskMessageNotification;
        this.emit('task:message', notification);
        break;
      }
      case AcpNotifConst.TASK_ARTEFACT: {
        const notification = params as AcpTaskArtefactNotification;
        this.emit('task:artefact', notification);
        break;
      }
      default:
        logger.debug({ method, params }, 'Unknown ACP notification');
    }
  }

  /**
   * 拒绝所有待处理的请求
   */
  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pendingRequests.delete(id);
    }
  }
}
