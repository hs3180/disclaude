/**
 * ACP 客户端连接管理
 *
 * 管理与 ACP Server 的连接生命周期，包括：
 * - 能力协商（initialize 握手）
 * - 请求-响应匹配
 * - 待处理请求的超时管理
 * - 连接关闭与资源清理
 *
 * @module acp/acp-client
 */

import {
  type JsonRpcResponse,
  createRequest,
  resetIdCounter,
} from './json-rpc.js';
import {
  AcpMethod,
  type AcpInitializeParams,
  type AcpInitializeResult,
  type AcpNewSessionParams,
  type AcpNewSessionResult,
  type AcpListSessionsParams,
  type AcpListSessionsResult,
  type AcpLoadSessionParams,
  type AcpLoadSessionResult,
  type AcpCloseSessionParams,
  type AcpCloseSessionResult,
  type AcpPromptParams,
  type AcpPromptResult,
  type AcpSessionUpdateParams,
  type AcpMethodName,
} from './types.js';
import type { IAcpTransport } from './transport.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('AcpClient');

/** AcpClient 配置 */
export interface AcpClientConfig {
  /** 传输层实例 */
  transport: IAcpTransport;
  /** 请求超时时间（毫秒），默认 30000 */
  requestTimeoutMs?: number;
}

/** 待处理请求 */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * ACP 客户端
 *
 * 管理与 ACP Server 的 JSON-RPC 通信。
 *
 * ## 使用示例
 *
 * ```typescript
 * const transport = new StdioTransport();
 * const client = new AcpClient({ transport });
 *
 * // 初始化
 * const { serverInfo, capabilities } = await client.initialize({
 *   clientInfo: { name: 'disclaude', version: '1.0.0' },
 *   capabilities: { streaming: true },
 * });
 *
 * // 创建会话
 * const { sessionId } = await client.newSession();
 *
 * // 发送 Prompt
 * const result = await client.prompt({
 *   sessionId,
 *   message: { role: 'user', content: 'Hello' },
 * });
 * ```
 */
export class AcpClient {
  private readonly transport: IAcpTransport;
  private readonly requestTimeoutMs: number;
  private pendingRequests = new Map<string | number, PendingRequest>();
  private initialized = false;
  private serverCapabilities: AcpInitializeResult['capabilities'] | null = null;

  // 通知回调
  private sessionUpdateHandlers: Array<(params: AcpSessionUpdateParams) => void> = [];

  constructor(config: AcpClientConfig) {
    this.transport = config.transport;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30000;
  }

  /** 客户端是否已完成初始化握手 */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /** 服务端能力（初始化后可用） */
  get capabilities(): AcpInitializeResult['capabilities'] | null {
    return this.serverCapabilities;
  }

  /**
   * 连接到 ACP Server 并完成初始化握手
   *
   * @param params - 初始化参数（客户端信息 + 能力）
   * @returns 服务端信息和能力
   */
  async initialize(params: AcpInitializeParams): Promise<AcpInitializeResult> {
    if (this.initialized) {
      throw new Error('Client is already initialized');
    }

    this.setupTransportListeners();
    this.resetIdCounter();

    const result = await this.sendRequest<AcpInitializeResult>(
      AcpMethod.Initialize,
      params
    );

    this.initialized = true;
    this.serverCapabilities = result.capabilities;

    logger.info(
      { server: result.serverInfo, capabilities: result.capabilities },
      'ACP client initialized'
    );

    return result;
  }

  /**
   * 创建新的 ACP 会话
   *
   * @param params - 会话参数
   * @returns 会话 ID
   */
  newSession(params?: AcpNewSessionParams): Promise<AcpNewSessionResult> {
    try { this.requireInitialized(); } catch (err) { return Promise.reject(err); }
    return this.sendRequest<AcpNewSessionResult>(AcpMethod.NewSession, params);
  }

  /**
   * 列出所有会话
   *
   * @param params - 列表参数
   * @returns 会话列表
   */
  listSessions(params?: AcpListSessionsParams): Promise<AcpListSessionsResult> {
    try { this.requireInitialized(); } catch (err) { return Promise.reject(err); }
    return this.sendRequest<AcpListSessionsResult>(AcpMethod.ListSessions, params);
  }

  /**
   * 加载历史会话
   *
   * @param params - 加载参数（含 sessionId）
   * @returns 加载结果
   */
  loadSession(params: AcpLoadSessionParams): Promise<AcpLoadSessionResult> {
    try { this.requireInitialized(); } catch (err) { return Promise.reject(err); }
    return this.sendRequest<AcpLoadSessionResult>(AcpMethod.LoadSession, params);
  }

  /**
   * 关闭会话
   *
   * @param params - 关闭参数（含 sessionId）
   * @returns 关闭结果
   */
  closeSession(params: AcpCloseSessionParams): Promise<AcpCloseSessionResult> {
    try { this.requireInitialized(); } catch (err) { return Promise.reject(err); }
    return this.sendRequest<AcpCloseSessionResult>(AcpMethod.CloseSession, params);
  }

  /**
   * 发送 Prompt（核心交互方法）
   *
   * @param params - Prompt 参数（sessionId + 用户消息）
   * @returns Prompt 结果（停止原因 + 使用统计）
   */
  prompt(params: AcpPromptParams): Promise<AcpPromptResult> {
    try { this.requireInitialized(); } catch (err) { return Promise.reject(err); }
    return this.sendRequest<AcpPromptResult>(AcpMethod.Prompt, params);
  }

  /**
   * 注册 sessionUpdate 通知处理器
   *
   * @param handler - 通知处理回调
   * @returns 取消注册的函数
   */
  onSessionUpdate(handler: (params: AcpSessionUpdateParams) => void): () => void {
    this.sessionUpdateHandlers.push(handler);
    return () => {
      this.sessionUpdateHandlers = this.sessionUpdateHandlers.filter(h => h !== handler);
    };
  }

  /**
   * 关闭连接并清理资源
   *
   * 拒绝所有待处理请求，关闭传输层。
   */
  close(): void {
    // 拒绝所有待处理请求
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      try {
        pending.reject(new Error('Client closed'));
      } catch {
        // Ignore if promise is already settled
      }
      this.pendingRequests.delete(id);
    }

    this.initialized = false;
    this.serverCapabilities = null;
    this.sessionUpdateHandlers = [];
    this.transport.close();

    logger.info('ACP client closed');
  }

  /**
   * 发送 JSON-RPC 请求并等待响应
   */
  private sendRequest<T>(method: AcpMethodName, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const request = createRequest(method, params);
      const id = request.id as string | number;

      // 设置超时
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request "${method}" timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, { resolve: resolve as (result: unknown) => void, reject, timer });

      try {
        this.transport.send(request);
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * 设置传输层事件监听
   */
  private setupTransportListeners(): void {
    this.transport.on('response', (message) => {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.id);

        const response = message as unknown as JsonRpcResponse;
        if ('error' in response) {
          pending.reject(new Error(
            `ACP error ${response.error.code}: ${response.error.message}`
          ));
        } else {
          pending.resolve(response.result);
        }
      } else {
        logger.warn({ id: message.id }, 'Received response for unknown request');
      }
    });

    this.transport.on('notification', (message) => {
      const msg = message as { method: string; params?: unknown };
      if (msg.method === AcpMethod.SessionUpdate && msg.params) {
        for (const handler of this.sessionUpdateHandlers) {
          try {
            handler(msg.params as AcpSessionUpdateParams);
          } catch (err) {
            logger.error({ err }, 'Session update handler error');
          }
        }
      } else {
        logger.debug({ method: msg.method }, 'Received notification');
      }
    });

    this.transport.on('error', (err) => {
      logger.error({ err }, 'Transport error');
    });
  }

  /**
   * 确保客户端已初始化
   */
  private requireInitialized(): void {
    if (!this.initialized) {
      throw new Error('Client is not initialized. Call initialize() first.');
    }
  }

  /**
   * 重置 ID 计数器（用于测试）
   */
  private resetIdCounter(): void {
    resetIdCounter();
  }
}
