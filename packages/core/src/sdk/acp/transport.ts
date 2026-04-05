/**
 * ACP HTTP/SSE 传输层
 *
 * 实现 ACP 协议的 HTTP REST 传输，支持 sync/async/stream 三种执行模式。
 * Stream 模式使用 Server-Sent Events (SSE) 进行实时事件推送。
 *
 * @see https://github.com/i-am-bee/acp/blob/main/docs/spec/openapi.yaml
 * @see Issue #1333 - 支持OpenAI Agent
 * @module sdk/acp/transport
 */

import type {
  AcpAgentManifest,
  AcpClientConfig,
  AcpCreateRunRequest,
  AcpResumeRunRequest,
  AcpRun,
  AcpSession,
  AcpSseEvent,
  AcpRunEventData,
  AcpMessageEventData,
  AcpMessagePartEventData,
  AcpErrorEventData,
} from './types.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('AcpTransport');

// ============================================================================
// 传输层接口
// ============================================================================

/** ACP 传输层抽象接口 */
export interface IAcpTransport {
  /** 健康检查 */
  ping(): Promise<boolean>;
  /** 列出所有 Agent */
  listAgents(limit?: number, offset?: number): Promise<AcpAgentManifest[]>;
  /** 获取 Agent Manifest */
  getAgent(name: string): Promise<AcpAgentManifest>;
  /** 创建 Run */
  createRun(request: AcpCreateRunRequest): Promise<AcpRun>;
  /** 获取 Run 状态 */
  getRun(runId: string): Promise<AcpRun>;
  /** 恢复 Run */
  resumeRun(request: AcpResumeRunRequest): Promise<AcpRun>;
  /** 取消 Run */
  cancelRun(runId: string): Promise<void>;
  /** 流式执行 Run（SSE） */
  streamRun(request: AcpCreateRunRequest): AsyncGenerator<AcpSseEvent>;
  /** 获取会话信息 */
  getSession(sessionId: string): Promise<AcpSession>;
  /** 关闭连接、释放资源 */
  dispose(): void;
}

// ============================================================================
// HTTP 传输实现
// ============================================================================

/** 传输层配置选项 */
export interface AcpHttpTransportOptions {
  /** ACP Server 基础 URL */
  baseUrl: string;
  /** 请求超时（毫秒，默认 30000） */
  timeout?: number;
  /** 自定义请求头 */
  headers?: Record<string, string>;
  /** 重试次数（默认 3） */
  retries?: number;
  /** 重试基础延迟（毫秒，默认 1000） */
  retryDelay?: number;
}

/**
 * ACP HTTP 传输层实现
 *
 * 通过 HTTP REST API 与 ACP Server 通信，
 * 支持 sync/async/stream 三种执行模式。
 */
export class AcpHttpTransport implements IAcpTransport {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly headers: Record<string, string>;
  private readonly retries: number;
  private readonly retryDelay: number;
  private disposed = false;

  constructor(options: AcpHttpTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeout = options.timeout ?? 30000;
    this.headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...options.headers,
    };
    this.retries = options.retries ?? 3;
    this.retryDelay = options.retryDelay ?? 1000;
  }

  // ==========================================================================
  // 公开 API
  // ==========================================================================

  async ping(): Promise<boolean> {
    try {
      const response = await this.rawRequest('/ping');
      return response.ok;
    } catch {
      return false;
    }
  }

  async listAgents(limit = 100, offset = 0): Promise<AcpAgentManifest[]> {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    const data = await this.request<{ agents: AcpAgentManifest[] }>(
      `/agents?${params}`
    );
    return data.agents;
  }

  getAgent(name: string): Promise<AcpAgentManifest> {
    return this.request<AcpAgentManifest>(`/agents/${encodeURIComponent(name)}`);
  }

  async createRun(request: AcpCreateRunRequest): Promise<AcpRun> {
    const body = {
      ...request,
      mode: request.mode ?? 'sync',
    };
    const response = await this.rawRequest('/runs', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    // async 模式返回 202
    if (response.status === 202) {
      return response.json() as Promise<AcpRun>;
    }

    // sync 模式返回 200
    return response.json() as Promise<AcpRun>;
  }

  getRun(runId: string): Promise<AcpRun> {
    return this.request<AcpRun>(`/runs/${encodeURIComponent(runId)}`);
  }

  async resumeRun(request: AcpResumeRunRequest): Promise<AcpRun> {
    const body = {
      await_resume: request.await_resume,
      mode: request.mode ?? 'sync',
    };
    const response = await this.rawRequest(`/runs/${encodeURIComponent(request.run_id)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return response.json() as Promise<AcpRun>;
  }

  async cancelRun(runId: string): Promise<void> {
    await this.request<void>(`/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
    });
  }

  async *streamRun(request: AcpCreateRunRequest): AsyncGenerator<AcpSseEvent> {
    const body = {
      ...request,
      mode: 'stream',
    };

    const response = await this.rawRequest('/runs', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'Accept': 'text/event-stream',
      },
    });

    if (!response.body) {
      throw new Error('SSE response has no body');
    }

    yield* this.parseSSE(response.body);
  }

  getSession(sessionId: string): Promise<AcpSession> {
    return this.request<AcpSession>(
      `/session/${encodeURIComponent(sessionId)}`
    );
  }

  dispose(): void {
    this.disposed = true;
  }

  // ==========================================================================
  // HTTP 请求工具
  // ==========================================================================

  /**
   * 发送 HTTP 请求（带重试）
   */
  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await this.rawRequest(path, options);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AcpTransportError(
        `HTTP ${response.status}: ${text}`,
        response.status
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * 发送原始 HTTP 请求（带重试和超时）
   */
  private async rawRequest(
    path: string,
    options: RequestInit = {}
  ): Promise<Response> {
    this.ensureNotDisposed();

    const url = `${this.baseUrl}${path}`;
    const mergedHeaders: Record<string, string> = {
      ...this.headers,
    };

    // 合并自定义请求头
    if (options.headers) {
      const extraHeaders = options.headers as Record<string, string>;
      for (const [key, value] of Object.entries(extraHeaders)) {
        mergedHeaders[key] = value;
      }
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        this.ensureNotDisposed();

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        try {
          const response = await fetch(url, {
            ...options,
            headers: mergedHeaders,
            signal: controller.signal,
          });

          // 只对服务端错误进行重试
          if (response.status >= 500 && attempt < this.retries) {
            await this.backoff(attempt);
            continue;
          }

          return response;
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // 对网络错误和超时进行重试
        if (attempt < this.retries) {
          logger.warn(
            { attempt: attempt + 1, maxRetries: this.retries, error: lastError.message },
            'Request failed, retrying...'
          );
          await this.backoff(attempt);
        }
      }
    }

    throw new AcpTransportError(
      `Request failed after ${this.retries + 1} attempts: ${lastError?.message}`,
      0,
      lastError
    );
  }

  /**
   * 指数退避等待
   */
  private backoff(attempt: number): Promise<void> {
    const delay = this.retryDelay * Math.pow(2, attempt);
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  /**
   * 确保 transport 未被销毁
   */
  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error('Transport has been disposed');
    }
  }

  // ==========================================================================
  // SSE 解析器
  // ==========================================================================

  /**
   * 解析 SSE (Server-Sent Events) 流
   *
   * @param stream - 可读流
   */
  private async *parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<AcpSseEvent> {
    const reader = stream.getReader();
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

        let eventType: string | undefined;
        let eventData = '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            eventData = line.slice(5).trim();
          } else if (line === '' && eventData) {
            // 空行表示事件结束
            const event = this.parseSseEvent(eventType, eventData);
            if (event) {
              yield event;
            }
            eventType = undefined;
            eventData = '';
          }
        }

        // 处理流结束前剩余的事件数据
        if (eventData) {
          const event = this.parseSseEvent(eventType, eventData);
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
   * 解析单个 SSE 事件
   */
  private parseSseEvent(
    type: string | undefined,
    data: string
  ): AcpSseEvent | null {
    if (!data) {
      return null;
    }

    try {
      const parsed = JSON.parse(data);
      const eventType = (type ?? parsed.type) as AcpSseEvent['type'];

      if (!eventType) {
        logger.warn({ data }, 'SSE event missing type');
        return null;
      }

      switch (eventType) {
        case 'run.created':
        case 'run.in-progress':
        case 'run.awaiting':
        case 'run.completed':
        case 'run.cancelled':
        case 'run.failed':
          return { type: eventType, data: parsed as AcpRunEventData };

        case 'message.created':
        case 'message.completed':
          return { type: eventType, data: parsed as AcpMessageEventData };

        case 'message.part':
          return { type: eventType, data: parsed as AcpMessagePartEventData };

        case 'error':
          return { type: eventType, data: parsed as AcpErrorEventData };

        default:
          logger.warn({ eventType }, 'Unknown SSE event type');
          return { type: eventType, data: parsed };
      }
    } catch (error) {
      logger.warn({ data, error }, 'Failed to parse SSE event data');
      return null;
    }
  }
}

// ============================================================================
// 错误类型
// ============================================================================

/** ACP 传输层错误 */
export class AcpTransportError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'AcpTransportError';
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 从 AcpClientConfig 创建传输层实例
 */
export function createTransport(config: AcpClientConfig): IAcpTransport {
  return new AcpHttpTransport({
    baseUrl: config.baseUrl,
    timeout: config.timeout,
    headers: config.headers,
    retries: config.retries,
    retryDelay: config.retryDelay,
  });
}
