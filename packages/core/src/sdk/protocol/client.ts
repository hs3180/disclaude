/**
 * ACP 协议客户端
 *
 * 实现 ACP (Agent Communication Protocol) 的 HTTP 客户端，
 * 提供 Agent 发现、运行管理和 SSE 流式消息处理能力。
 *
 * @see https://agentcommunicationprotocol.dev
 * @see Issue #1333 - 支持OpenAI Agent
 */

import type {
  ACPAgentManifest,
  ACPAgentName,
  ACPClientConfig,
  ACPEvent,
  ACPRun,
  ACPRunCreateRequest,
  ACPRunEventsListResponse,
  ACPRunResumeRequest,
  ACPAgentsListResponse,
  ACPSession,
} from './types.js';
import {
  ACPConnectionError,
  ACPProtocolError,
  ACPTimeoutError,
} from './errors.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('ACPClient');

/** 默认请求超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * ACP 协议客户端
 *
 * 提供与 ACP 服务器通信的完整 API，包括：
 * - Agent 发现（list、get）
 * - Run 管理（create、get、resume、cancel）
 * - SSE 流式事件处理
 * - Session 管理
 */
export class ACPClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private disposed = false;

  constructor(config: ACPClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeout ?? DEFAULT_TIMEOUT_MS;
    this.headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...config.headers,
    };
  }

  // ==========================================================================
  // Agent 发现
  // ==========================================================================

  /**
   * 列出所有可用的 Agent
   *
   * @param options - 查询选项
   * @returns Agent 清单列表
   */
  async listAgents(options?: { limit?: number; offset?: number }): Promise<ACPAgentManifest[]> {
    this.ensureNotDisposed();

    const params = new URLSearchParams();
    if (options?.limit !== undefined) {
      params.set('limit', String(options.limit));
    }
    if (options?.offset !== undefined) {
      params.set('offset', String(options.offset));
    }

    const response = await this.request<ACPAgentsListResponse>(
      `/agents${params.toString() ? `?${params}` : ''}`
    );

    return response.agents;
  }

  /**
   * 获取指定 Agent 的清单信息
   *
   * @param name - Agent 名称
   * @returns Agent 清单
   */
  async getAgent(name: ACPAgentName): Promise<ACPAgentManifest> {
    this.ensureNotDisposed();

    const encodedName = encodeURIComponent(name);
    return await this.request<ACPAgentManifest>(`/agents/${encodedName}`);
  }

  // ==========================================================================
  // Run 管理
  // ==========================================================================

  /**
   * 创建并启动新的 Run
   *
   * @param request - Run 创建请求
   * @returns Run 对象
   */
  async createRun(request: ACPRunCreateRequest): Promise<ACPRun> {
    this.ensureNotDisposed();

    return await this.request<ACPRun>('/runs', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /**
   * 获取 Run 状态
   *
   * @param runId - Run ID
   * @returns Run 对象
   */
  async getRun(runId: string): Promise<ACPRun> {
    this.ensureNotDisposed();

    return await this.request<ACPRun>(`/runs/${runId}`);
  }

  /**
   * 恢复暂停的 Run
   *
   * @param request - Run 恢复请求
   * @returns Run 对象
   */
  async resumeRun(request: ACPRunResumeRequest): Promise<ACPRun> {
    this.ensureNotDisposed();

    return await this.request<ACPRun>(`/runs/${request.run_id}`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /**
   * 取消 Run
   *
   * @param runId - Run ID
   * @returns Run 对象
   */
  async cancelRun(runId: string): Promise<ACPRun> {
    this.ensureNotDisposed();

    return await this.request<ACPRun>(`/runs/${runId}/cancel`, {
      method: 'POST',
    });
  }

  /**
   * 获取 Run 事件列表
   *
   * @param runId - Run ID
   * @returns 事件列表
   */
  async listRunEvents(runId: string): Promise<ACPEvent[]> {
    this.ensureNotDisposed();

    const response = await this.request<ACPRunEventsListResponse>(
      `/runs/${runId}/events`
    );

    return response.events;
  }

  // ==========================================================================
  // 流式处理
  // ==========================================================================

  /**
   * 创建流式 Run，通过 SSE 接收事件
   *
   * @param request - Run 创建请求（mode 强制为 stream）
   * @returns SSE 事件异步生成器
   */
  async *streamRun(
    request: ACPRunCreateRequest
  ): AsyncGenerator<ACPEvent> {
    this.ensureNotDisposed();

    const streamRequest: ACPRunCreateRequest = {
      ...request,
      mode: 'stream',
    };

    const response = await this.fetchRaw('/runs', {
      method: 'POST',
      body: JSON.stringify(streamRequest),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw ACPProtocolError.fromResponse(response.status, body);
    }

    const contentType = response.headers.get('content-type') ?? '';

    if (!contentType.includes('text/event-stream')) {
      // 非 SSE 响应，解析为普通 Run 对象并转换为事件
      const run = await response.json() as ACPRun;
      yield { type: 'run.created', run } as ACPEvent;
      yield { type: 'run.completed', run } as ACPEvent;
      return;
    }

    yield* this.parseSSE(response.body);
  }

  // ==========================================================================
  // Session 管理
  // ==========================================================================

  /**
   * 获取 Session 详情
   *
   * @param sessionId - Session ID
   * @returns Session 对象
   */
  async getSession(sessionId: string): Promise<ACPSession> {
    this.ensureNotDisposed();

    return await this.request<ACPSession>(`/session/${sessionId}`);
  }

  // ==========================================================================
  // 健康检查
  // ==========================================================================

  /**
   * Ping ACP 服务器
   *
   * @returns 是否可达
   */
  async ping(): Promise<boolean> {
    try {
      const response = await this.fetchRaw('/ping', { method: 'GET' });
      return response.ok;
    } catch (error) {
      logger.warn({ err: error, url: this.baseUrl }, 'ACP ping failed');
      return false;
    }
  }

  // ==========================================================================
  // 生命周期
  // ==========================================================================

  /**
   * 获取客户端基础 URL
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * 释放客户端资源
   */
  dispose(): void {
    this.disposed = true;
  }

  // ==========================================================================
  // 内部方法
  // ==========================================================================

  /**
   * 发送 HTTP 请求并解析 JSON 响应
   */
  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await this.fetchRaw(path, options);

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw ACPProtocolError.fromResponse(response.status, body);
    }

    return response.json() as Promise<T>;
  }

  /**
   * 发送原始 HTTP 请求（带超时）
   */
  private async fetchRaw(path: string, options?: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          ...this.headers,
          ...options?.headers,
        },
      });

      return response;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ACPTimeoutError(this.timeoutMs);
      }

      throw new ACPConnectionError(url, error instanceof Error ? error : new Error(String(error)));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 解析 SSE (Server-Sent Events) 流
   */
  private async *parseSSE(body: ReadableStream<Uint8Array> | null): AsyncGenerator<ACPEvent> {
    if (!body) {
      return;
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        let currentData = '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            currentData = line.slice(6);
          } else if (line === '' && currentData) {
            // 空行表示事件结束
            const event = this.parseSSEEvent(currentData);
            if (event) {
              yield event;
            }
            currentData = '';
          }
        }

        // 处理末尾的 data（如果没有空行结尾）
        if (currentData && buffer === '') {
          const event = this.parseSSEEvent(currentData);
          if (event) {
            yield event;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * 解析单个 SSE 事件数据
   */
  private parseSSEEvent(data: string): ACPEvent | null {
    try {
      const parsed = JSON.parse(data) as ACPEvent;

      if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
        logger.warn({ data }, 'Invalid ACP SSE event: missing type field');
        return null;
      }

      return parsed;
    } catch (error) {
      logger.warn({ data, err: error }, 'Failed to parse ACP SSE event');
      return null;
    }
  }

  /**
   * 确保客户端未被释放
   */
  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error('ACPClient has been disposed');
    }
  }
}
