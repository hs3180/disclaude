/**
 * ACP (Agent Communication Protocol) 客户端
 *
 * 轻量级 HTTP 客户端，实现 ACP 协议的 REST API 通信。
 * 支持 Agent 发现、Run 生命周期管理和 SSE 流式事件。
 *
 * 这是 ACP 协议基础设施的核心组件，供后续 ACP Provider (PR B) 使用。
 *
 * @module sdk/providers/acp/client
 */

import type {
  ACPAgentManifest,
  ACPClientConfig,
  ACPConnectionInfo,
  ACPConnectionState,
  ACPErrorModel,
  ACPEvent,
  ACPRun,
  ACPRunCreateRequest,
  ACPMessage,
} from './types.js';

/** ACP API 路径常量 */
const ACP_PATHS = {
  ping: '/ping',
  agents: '/agents',
  agent: (name: string) => `/agents/${encodeURIComponent(name)}`,
  runs: '/runs',
  run: (id: string) => `/runs/${encodeURIComponent(id)}`,
  runCancel: (id: string) => `/runs/${encodeURIComponent(id)}/cancel`,
} as const;

/**
 * ACP 协议错误
 */
export class ACPProtocolError extends Error {
  constructor(
    message: string,
    public readonly code: ACPErrorModel['code'],
    public readonly statusCode?: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'ACPProtocolError';
  }
}

/**
 * ACP 客户端
 *
 * 封装 ACP REST API 的 HTTP 通信，提供：
 * - Agent 发现（列出和获取 Agent 清单）
 * - Run 生命周期管理（创建、查询、取消）
 * - SSE 流式事件消费
 * - 连接状态管理
 */
export class ACPClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly customFetch: typeof globalThis.fetch;
  private readonly defaultHeaders: Record<string, string>;
  private connectionState: ACPConnectionState = 'disconnected';
  private connectedAt?: Date;
  private lastError?: string;
  private cachedAgents?: ACPAgentManifest[];

  constructor(config: ACPClientConfig) {
    // 规范化 baseUrl，移除尾部斜杠
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeout = config.timeout ?? 30000;
    this.customFetch = config.fetch ?? globalThis.fetch;
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...config.headers,
    };
  }

  // ==========================================================================
  // 连接管理
  // ==========================================================================

  /**
   * 测试与 ACP Server 的连接
   *
   * @throws ACPProtocolError 如果连接失败
   */
  async connect(): Promise<void> {
    this.connectionState = 'connecting';
    try {
      await this.fetchJSON(ACP_PATHS.ping);
      this.connectionState = 'connected';
      this.connectedAt = new Date();
      this.lastError = undefined;
    } catch (error) {
      this.connectionState = 'error';
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /**
   * 断开连接（清理资源）
   */
  disconnect(): void {
    this.connectionState = 'disconnected';
    this.connectedAt = undefined;
    this.cachedAgents = undefined;
  }

  /**
   * 获取连接信息
   */
  getConnectionInfo(): ACPConnectionInfo {
    return {
      state: this.connectionState,
      baseUrl: this.baseUrl,
      connectedAt: this.connectedAt,
      lastError: this.lastError,
      agents: this.cachedAgents,
    };
  }

  // ==========================================================================
  // Agent 发现
  // ==========================================================================

  /**
   * 列出所有可用的 Agent
   *
   * @param options - 分页选项
   * @returns Agent 清单数组
   */
  async listAgents(options?: { limit?: number; offset?: number }): Promise<ACPAgentManifest[]> {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) {
      params.set('limit', String(options.limit));
    }
    if (options?.offset !== undefined) {
      params.set('offset', String(options.offset));
    }

    const query = params.toString();
    const path = query ? `${ACP_PATHS.agents}?${query}` : ACP_PATHS.agents;
    const agents = await this.fetchJSON<ACPAgentManifest[]>(path);

    this.cachedAgents = agents;
    return agents;
  }

  /**
   * 获取特定 Agent 的清单信息
   *
   * @param name - Agent 名称
   * @returns Agent 清单
   */
  getAgent(name: string): Promise<ACPAgentManifest> {
    return this.fetchJSON<ACPAgentManifest>(ACP_PATHS.agent(name));
  }

  // ==========================================================================
  // Run 生命周期
  // ==========================================================================

  /**
   * 创建并启动一个新的 Run（同步模式）
   *
   * @param request - Run 创建请求
   * @returns 完成的 Run 对象
   */
  runSync(request: ACPRunCreateRequest): Promise<ACPRun> {
    return this.fetchJSON<ACPRun>(ACP_PATHS.runs, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /**
   * 创建并启动一个新的 Run（异步模式）
   *
   * @param request - Run 创建请求
   * @returns 创建的 Run 对象（包含 run_id 用于后续轮询）
   */
  async runAsync(request: ACPRunCreateRequest): Promise<ACPRun> {
    const response = await this.fetchRaw(ACP_PATHS.runs, {
      method: 'POST',
      body: JSON.stringify(request),
      accept: 'application/json',
    });

    if (response.status !== 202) {
      const error = await this.parseError(response);
      throw new ACPProtocolError(
        error.message,
        error.code,
        response.status,
        error.data,
      );
    }

    return response.json() as Promise<ACPRun>;
  }

  /**
   * 获取 Run 状态
   *
   * @param runId - Run ID
   * @returns Run 对象
   */
  getRunStatus(runId: string): Promise<ACPRun> {
    return this.fetchJSON<ACPRun>(ACP_PATHS.run(runId));
  }

  /**
   * 取消正在执行的 Run
   *
   * @param runId - Run ID
   * @returns 取消后的 Run 对象
   */
  cancelRun(runId: string): Promise<ACPRun> {
    return this.fetchJSON<ACPRun>(ACP_PATHS.runCancel(runId), {
      method: 'POST',
    });
  }

  /**
   * 以流式模式创建 Run 并消费 SSE 事件
   *
   * @param request - Run 创建请求
   * @param onEvent - 事件回调函数
   * @param signal - 可选的 AbortSignal 用于取消
   */
  async runStream(
    request: ACPRunCreateRequest,
    onEvent: (event: ACPEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.fetchRaw(ACP_PATHS.runs, {
      method: 'POST',
      body: JSON.stringify(request),
      accept: 'text/event-stream',
      signal,
    });

    if (!response.body) {
      throw new ACPProtocolError('Response body is empty', 'server_error', response.status);
    }

    await this.consumeSSE(response.body, onEvent);
  }

  /**
   * 恢复一个处于 awaiting 状态的 Run
   *
   * @param runId - Run ID
   * @param message - 恢复消息
   * @returns 恢复后的 Run 对象
   */
  resumeRun(runId: string, message: ACPMessage): Promise<ACPRun> {
    return this.fetchJSON<ACPRun>(ACP_PATHS.run(runId), {
      method: 'POST',
      body: JSON.stringify({
        type: 'message',
        message,
      }),
    });
  }

  // ==========================================================================
  // 内部 HTTP 方法
  // ==========================================================================

  /**
   * 发送 JSON 请求并解析 JSON 响应
   */
  private async fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchRaw(path, {
      ...init,
      accept: 'application/json',
    });

    if (!response.ok) {
      const error = await this.parseError(response);
      throw new ACPProtocolError(
        error.message,
        error.code,
        response.status,
        error.data,
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * 发送 HTTP 请求（返回原始 Response）
   */
  private async fetchRaw(path: string, init?: RequestInit & { accept?: string }): Promise<Response> {
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
    };

    if (init?.accept) {
      headers['Accept'] = init.accept;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    // 如果外部提供了 signal，在它 abort 时也清理 timeout
    let externalAbortHandler: (() => void) | undefined;
    if (init?.signal) {
      if (init.signal.aborted) {
        clearTimeout(timeoutId);
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      externalAbortHandler = () => {
        clearTimeout(timeoutId);
        controller.abort();
      };
      init.signal.addEventListener('abort', externalAbortHandler);
    }

    try {
      const url = `${this.baseUrl}${path}`;
      const response = await this.customFetch(url, {
        ...init,
        headers: {
          ...headers,
          ...(init?.headers as Record<string, string> | undefined),
        },
        signal: controller.signal,
      });

      return response;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ACPProtocolError(
          `Request timeout after ${this.timeout}ms`,
          'server_error',
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      if (externalAbortHandler && init?.signal) {
        init.signal.removeEventListener('abort', externalAbortHandler);
      }
    }
  }

  /**
   * 从错误响应中解析 ACP 错误模型
   */
  private async parseError(response: Response): Promise<ACPErrorModel> {
    try {
      const body = await response.json() as ACPErrorModel | Record<string, unknown>;
      if ('code' in body && 'message' in body) {
        return body as ACPErrorModel;
      }
      return {
        code: 'server_error',
        message: String(body),
        data: body,
      };
    } catch {
      return {
        code: 'server_error',
        message: `HTTP ${response.status}: ${response.statusText}`,
      };
    }
  }

  /**
   * 消费 SSE 事件流
   *
   * 解析 text/event-stream 格式的响应体，
   * 将每个事件解析为 ACPEvent 并调用回调。
   */
  private async consumeSSE(
    body: ReadableStream<Uint8Array>,
    onEvent: (event: ACPEvent) => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // 处理缓冲区中剩余的数据
          if (buffer.trim()) {
            this.parseSSEBuffer(buffer, onEvent);
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // 按双换行符分割事件
        const events = buffer.split('\n\n');
        // 最后一个元素可能是不完整的事件，保留在缓冲区
        buffer = events.pop() ?? '';

        for (const event of events) {
          this.parseSSEBuffer(event, onEvent);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * 解析 SSE 事件缓冲区
   */
  private parseSSEBuffer(buffer: string, onEvent: (event: ACPEvent) => void): void {
    const lines = buffer.split('\n');
    let eventData = '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        // SSE event type is available but redundant with data.type in JSON payload
      } else if (line.startsWith('data:')) {
        eventData = line.slice(5).trim();
      }
      // 忽略 id: 和 retry: 行
    }

    if (!eventData) {
      return;
    }

    try {
      const parsed = JSON.parse(eventData) as ACPEvent;
      onEvent(parsed);
    } catch {
      // 无法解析的事件，跳过
    }
  }
}
