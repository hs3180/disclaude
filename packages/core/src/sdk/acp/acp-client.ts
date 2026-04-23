/**
 * ACP Client - Agent Client Protocol 客户端实现
 *
 * 通过 JSON-RPC 2.0 over Transport 与 ACP Agent 通信。
 * 提供连接握手、会话管理、prompt 流式处理等完整生命周期管理。
 *
 * 设计模式参考 claude/provider.ts，但使用 ACP 协议替代 Claude SDK。
 *
 * 生命周期：
 * 1. connect() — initialize 握手
 * 2. createSession() — session/new 创建会话
 * 3. sendPrompt() → AsyncGenerator<AgentMessage> — 流式获取 Agent 响应
 * 4. cancelPrompt() — 取消正在执行的 prompt
 * 5. disconnect() — 清理资源
 *
 * @module sdk/acp/acp-client
 */

import { createLogger } from '../../utils/logger.js';
import type { AgentMessage } from '../types.js';
import type {
  JsonRpcMessage,
  JsonRpcResponse,
  JsonRpcErrorResponse,
  JsonRpcNotification,
  AcpInitializeParams,
  AcpSessionNewParams,
  AcpSessionNewResult,
  AcpSessionPromptParams,
  AcpPromptResult,
  AcpPermissionRequestParams,
  AcpPermissionResult,
  AcpSessionUpdateParams,
} from './types.js';
import {
  AcpError,
  createRequest,
  createNotification,
  isResponse,
  isNotification,
  type IAcpTransport,
} from './transport.js';
import { adaptSessionUpdate, adaptPromptResult } from './message-adapter.js';

const logger = createLogger('AcpClient');

// ============================================================================
// 配置和类型
// ============================================================================

/** ACP Client 连接状态 */
export type AcpClientState = 'disconnected' | 'connecting' | 'connected';

/** 权限请求回调类型 */
export type PermissionRequestCallback = (
  params: AcpPermissionRequestParams,
) => Promise<AcpPermissionResult>;

/** ACP Client 配置 */
export interface AcpClientConfig {
  /** Transport 实例（stdio 或自定义） */
  transport: IAcpTransport;
  /** 请求超时（毫秒），默认 30000 */
  timeout?: number;
  /** 权限请求回调，不设置则自动批准 */
  onPermissionRequest?: PermissionRequestCallback;
  /**
   * 文本块聚合的 debounce 时间（毫秒），默认 200。
   * 连续 agent_message_chunk 在此时间窗口内合并为一条消息，
   * 超时后自动 flush。设为 0 则禁用 debounce（仅在遇到非 text 事件时 flush）。
   */
  textAggregationDebounceMs?: number;
}

/** ACP initialize 响应中的服务端能力（简化） */
export interface AcpServerCapabilities {
  protocolVersion?: number;
  [key: string]: unknown;
}

// ============================================================================
// Pending request 类型
// ============================================================================

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Active prompt stream state for routing session/update notifications */
interface ActivePrompt {
  /** Push an AgentMessage to the consumer */
  push: (message: AgentMessage) => void;
  /** Signal that the prompt has completed */
  complete: () => void;
  /** Signal an error */
  error: (err: Error) => void;
}

// ============================================================================
// TextChunkBuffer — 连续 agent_message_chunk 的缓冲聚合
// ============================================================================

/**
 * 缓冲连续的 `agent_message_chunk` 文本，合并为一条完整的 AgentMessage。
 *
 * 聚合边界：
 * 1. 遇到非 text 类型事件（tool_use, tool_result, plan 等）→ flush
 * 2. debounce 超时（默认 200ms）→ flush
 * 3. prompt 完成（sendPrompt 的 result）→ flush
 * 4. disconnect / transport close → flush
 *
 * @see {@link https://github.com/hs3180/disclaude/issues/2532 | Issue #2532}
 */
class TextChunkBuffer {
  private text = '';
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param sessionId - 关联的 session ID（用于日志）
   * @param flushCallback - flush 时调用的回调，接收聚合后的 AgentMessage
   * @param debounceMs - debounce 时间（毫秒），0 表示禁用自动 flush
   */
  constructor(
    private readonly sessionId: string,
    private readonly flushCallback: (msg: AgentMessage) => void,
    private readonly debounceMs: number = 200,
  ) {}

  /** 追加文本到缓冲区，重置 debounce timer */
  append(text: string): void {
    this.text += text;
    this.resetTimer();
  }

  /** 手动 flush 缓冲区，返回聚合后的 AgentMessage（如果有内容） */
  flush(): void {
    this.clearTimer();
    if (this.text) {
      const aggregated: AgentMessage = {
        type: 'text',
        content: this.text,
        role: 'assistant',
      };
      logger.debug(
        { sessionId: this.sessionId, length: this.text.length },
        'TextChunkBuffer flushed aggregated text',
      );
      this.text = '';
      this.flushCallback(aggregated);
    }
  }

  /** 清空缓冲区（不触发回调），用于清理 */
  clear(): void {
    this.clearTimer();
    this.text = '';
  }

  /** 是否有待 flush 的内容 */
  get hasContent(): boolean {
    return this.text.length > 0;
  }

  private resetTimer(): void {
    this.clearTimer();
    if (this.debounceMs > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.debounceMs);
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

// ============================================================================
// AcpClient 实现
// ============================================================================

/**
 * AcpClient - ACP 协议客户端
 *
 * 通过 Transport 层与 ACP Agent 通信，管理连接、会话和 prompt 流。
 *
 * @example
 * ```typescript
 * const transport = new AcpStdioTransport({ command: 'claude-agent-acp' });
 * const client = new AcpClient({ transport });
 *
 * await client.connect();
 * const { sessionId } = await client.createSession('/workspace');
 *
 * for await (const msg of client.sendPrompt(sessionId, [{ type: 'text', text: 'Hello' }])) {
 *   console.log(msg.type, msg.content);
 * }
 *
 * await client.disconnect();
 * ```
 */
export class AcpClient {
  private readonly transport: IAcpTransport;
  private readonly timeout: number;
  private readonly onPermissionRequest?: PermissionRequestCallback;
  private readonly textAggregationDebounceMs: number;

  /** 客户端状态 */
  private _state: AcpClientState = 'disconnected';

  /** 自增请求 ID */
  private nextId = 0;

  /** 等待响应的 pending requests */
  private readonly pendingRequests = new Map<number | string, PendingRequest>();

  /** 当前活跃的 prompt streams，key 为 sessionId */
  private readonly activePrompts = new Map<string, ActivePrompt>();

  /**
   * 每个 session 的文本块缓冲区，用于聚合连续的 agent_message_chunk。
   * @see {@link https://github.com/hs3180/disclaude/issues/2532 | Issue #2532}
   */
  private readonly textBuffers = new Map<string, TextChunkBuffer>();

  constructor(config: AcpClientConfig) {
    this.transport = config.transport;
    this.timeout = config.timeout ?? 30000;
    this.onPermissionRequest = config.onPermissionRequest;
    this.textAggregationDebounceMs = config.textAggregationDebounceMs ?? 200;
  }

  /** 当前连接状态 */
  get state(): AcpClientState {
    return this._state;
  }

  // ==========================================================================
  // 生命周期方法
  // ==========================================================================

  /**
   * 连接到 Agent 进程。
   * 执行 Transport 连接 + ACP initialize 握手。
   *
   * @returns 服务端能力信息
   */
  async connect(): Promise<AcpServerCapabilities> {
    if (this._state === 'connected') {
      throw new AcpError('Already connected', -1);
    }
    if (this._state === 'connecting') {
      throw new AcpError('Connection already in progress', -1);
    }

    this._state = 'connecting';

    // 注册消息路由
    this.transport.onMessage((msg) => this.handleMessage(msg));
    this.transport.onError((err) => this.handleError(err));
    this.transport.onClose(() => this.handleClose());

    try {
      // 连接 Transport
      await this.transport.connect();

      // ACP initialize 握手
      const params: AcpInitializeParams = {
        protocolVersion: 1,
        clientCapabilities: {
          auth: { terminal: true },
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      };

      const result = await this.sendRequest<AcpServerCapabilities>('initialize', params);
      this._state = 'connected';

      logger.info({ capabilities: result }, 'ACP client connected');
      return result;
    } catch (err) {
      this._state = 'disconnected';
      throw err;
    }
  }

  /**
   * 创建新的 ACP 会话。
   *
   * Note (Issue #2463, #2451): MCP servers are NO longer passed via
   * session/new. ACP v0.23.1+ only supports http/sse MCP transports.
   * Stdio MCP servers are written to {workspace}/.mcp.json by ChatAgent
   * so that Claude Code loads them natively. The mcpServers field is
   * always an empty array in the session/new request.
   *
   * @param cwd - 工作目录
   * @param options - 可选的会话配置（permissionMode 等）
   * @returns 会话 ID 和模型信息
   */
  async createSession(
    cwd: string,
    options?: {
      permissionMode?: string;
      model?: string;
      allowedTools?: string[];
      disallowedTools?: string[];
      env?: Record<string, string>;
      settingSources?: string[];
    },
  ): Promise<AcpSessionNewResult> {
    this.assertConnected();

    const params: AcpSessionNewParams = {
      cwd,
      // Issue #2463/#2451: mcpServers is always empty. Stdio MCP servers
      // are loaded via .mcp.json by Claude Code, not through session/new.
      mcpServers: [],
    };

    // Build _meta.claudeCode.options if any option is present
    const claudeOptions: NonNullable<NonNullable<AcpSessionNewParams['_meta']>['claudeCode']>['options'] = {};
    if (options?.permissionMode) { claudeOptions.permissionMode = options.permissionMode; }
    if (options?.model) { claudeOptions.model = options.model; }
    if (options?.allowedTools) { claudeOptions.allowedTools = options.allowedTools; }
    if (options?.disallowedTools) { claudeOptions.disallowedTools = options.disallowedTools; }
    if (options?.env) { claudeOptions.env = options.env; }
    if (options?.settingSources) { claudeOptions.settingSources = options.settingSources; }

    if (Object.keys(claudeOptions).length > 0) {
      params._meta = {
        claudeCode: {
          options: claudeOptions,
        },
      };
    }

    const result = await this.sendRequest<AcpSessionNewResult>('session/new', params);
    logger.info({ sessionId: result.sessionId, cwd }, 'ACP session created');
    return result;
  }

  /**
   * 发送 prompt 并流式获取 Agent 响应。
   *
   * 返回 AsyncGenerator，每次 Agent 产生一条 AgentMessage 时 yield。
   * Generator 在收到 prompt result（完成）或发生错误时结束。
   *
   * @param sessionId - 会话 ID
   * @param prompt - prompt 内容块数组
   * @returns AgentMessage 的异步迭代器
   */
  async *sendPrompt(
    sessionId: string,
    prompt: { type: 'text'; text: string }[],
  ): AsyncGenerator<AgentMessage> {
    this.assertConnected();

    // Reject concurrent prompts for the same session
    if (this.activePrompts.has(sessionId)) {
      throw new AcpError(`A prompt is already active for session ${sessionId}`, -1);
    }

    const params: AcpSessionPromptParams = {
      sessionId,
      prompt,
    };

    // 创建消息队列（push/pull 模式）
    const messageQueue: AgentMessage[] = [];
    let resolveWait: (() => void) | null = null;
    let completed = false;
    let errorOccurred: Error | null = null;

    const activePrompt: ActivePrompt = {
      push: (msg: AgentMessage) => {
        messageQueue.push(msg);
        if (resolveWait) {
          resolveWait();
          resolveWait = null;
        }
      },
      complete: () => {
        completed = true;
        if (resolveWait) {
          resolveWait();
          resolveWait = null;
        }
      },
      error: (err: Error) => {
        errorOccurred = err;
        if (resolveWait) {
          resolveWait();
          resolveWait = null;
        }
      },
    };

    this.activePrompts.set(sessionId, activePrompt);

    try {
      // 发送 session/prompt 请求（异步等待 result 响应）
      const promptPromise = this.sendRequest<AcpPromptResult>('session/prompt', params);

      // 在后台处理 result 响应
      void promptPromise
        .then((result) => {
          // Issue #2532: prompt 完成前 flush 残余的 text buffer
          this.flushTextBuffer(sessionId, activePrompt);
          this.textBuffers.delete(sessionId);

          // 将 result 转为 AgentMessage 并推入队列
          const msg = adaptPromptResult(result);
          activePrompt.push(msg);
          activePrompt.complete();
        })
        .catch((err) => {
          // 出错时也清理 text buffer
          this.textBuffers.delete(sessionId);
          activePrompt.error(
            err instanceof Error ? err : new Error(String(err)),
          );
        });

      // 流式 yield AgentMessage
      while (true) {
        // 如果队列中有消息，立即 yield
        while (messageQueue.length > 0) {
          const msg = messageQueue.shift();
          if (msg) {
            yield msg;
          }
        }

        // 如果已完成且队列为空，退出
        if (completed) {
          break;
        }

        // 如果有错误，抛出
        if (errorOccurred) {
          throw errorOccurred;
        }

        // 等待新消息
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
        });
      }
    } finally {
      this.activePrompts.delete(sessionId);
      this.textBuffers.delete(sessionId);
    }
  }

  /**
   * 取消正在执行的 prompt。
   *
   * @param sessionId - 要取消的会话 ID
   */
  async cancelPrompt(sessionId: string): Promise<void> {
    this.assertConnected();

    try {
      await this.sendRequest('session/cancel', { sessionId });
      logger.info({ sessionId }, 'Prompt cancelled');
    } catch (err) {
      logger.warn({ err, sessionId }, 'Failed to cancel prompt');
      throw err;
    }
  }

  /**
   * 断开连接，清理所有资源。
   */
  async disconnect(): Promise<void> {
    if (this._state === 'disconnected') {
      return;
    }

    // 拒绝所有 pending requests
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new AcpError('Client disconnecting', -1));
    }
    this.pendingRequests.clear();

    // 清理所有 text buffers
    for (const [_sid, buffer] of this.textBuffers) {
      buffer.clear();
    }
    this.textBuffers.clear();

    // 终止所有活跃的 prompt streams
    for (const [_sid, active] of this.activePrompts) {
      active.error(new AcpError('Client disconnecting', -1));
    }
    this.activePrompts.clear();

    // 断开 Transport
    try {
      await this.transport.disconnect();
    } catch (err) {
      logger.warn({ err }, 'Error disconnecting transport');
    }

    this._state = 'disconnected';
    logger.info('ACP client disconnected');
  }

  // ==========================================================================
  // 内部方法
  // ==========================================================================

  /**
   * 发送 JSON-RPC 请求并等待响应。
   *
   * @param method - ACP 方法名
   * @param params - 方法参数
   * @returns 响应的 result 字段
   */
  private sendRequest<T = unknown>(method: string, params: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const req = createRequest(method, params, id);

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new AcpError(`Request timeout: ${method} (id=${id})`, -1));
      }, this.timeout);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        this.transport.send(req);
        logger.debug({ method, id }, 'Request sent');
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  /**
   * 处理从 Transport 收到的 JSON-RPC 消息。
   */
  private handleMessage(msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      this.handleResponse(msg as JsonRpcResponse | JsonRpcErrorResponse);
    } else if (isNotification(msg)) {
      this.handleNotification(msg as JsonRpcNotification);
    }
  }

  /**
   * 处理 JSON-RPC 响应（匹配 pending request）。
   */
  private handleResponse(msg: JsonRpcResponse | JsonRpcErrorResponse): void {
    const {id} = msg;
    if (id === null || id === undefined) {
      logger.debug('Received response with null id, ignoring');
      return;
    }
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      logger.debug({ id }, 'Received response for unknown request');
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(id);

    if ('error' in msg) {
      const errDetail = (msg as JsonRpcErrorResponse).error;
      pending.reject(
        new AcpError(
          errDetail.message,
          errDetail.code,
        ),
      );
    } else {
      pending.resolve((msg as JsonRpcResponse).result);
    }
  }

  /**
   * 处理 JSON-RPC 通知。
   */
  private handleNotification(msg: JsonRpcNotification): void {
    switch (msg.method) {
      case 'session/update': {
        this.handleSessionUpdate(msg.params as AcpSessionUpdateParams);
        break;
      }
      case 'session/request_permission': {
        void this.handlePermissionRequest(msg.params as AcpPermissionRequestParams);
        break;
      }
      default: {
        logger.debug({ method: msg.method }, 'Unhandled notification');
      }
    }
  }

  /**
   * 处理 session/update 通知，转换为 AgentMessage 并推送到对应的 prompt stream。
   *
   * Issue #2532: 对连续的 agent_message_chunk 进行缓冲聚合，避免碎片消息。
   * 非 text 类型事件（tool_use, tool_result, plan 等）触发 flush。
   */
  private handleSessionUpdate(params: AcpSessionUpdateParams): void {
    const {update} = params;
    const {sessionId} = params;
    const active = this.activePrompts.get(sessionId);

    if (!active) {
      return;
    }

    // 对 agent_message_chunk 进行缓冲聚合
    if (update.sessionUpdate === 'agent_message_chunk') {
      const text = (update as { content?: { type: string; text?: string } }).content?.text ?? '';
      if (text) {
        let buffer = this.textBuffers.get(sessionId);
        if (!buffer) {
          buffer = new TextChunkBuffer(
            sessionId,
            (msg) => active.push(msg),
            this.textAggregationDebounceMs,
          );
          this.textBuffers.set(sessionId, buffer);
        }
        buffer.append(text);
      }
      return;
    }

    // 非 text 事件：先 flush 该 session 的 text buffer
    this.flushTextBuffer(sessionId, active);

    // 适配并推送非 text 消息
    const agentMessage = adaptSessionUpdate(update);
    if (!agentMessage) {
      logger.debug({ updateType: update.sessionUpdate }, 'Unhandled session update type');
      return;
    }

    active.push(agentMessage);
  }

  /**
   * Flush 指定 session 的文本缓冲区。
   */
  private flushTextBuffer(sessionId: string, _active: ActivePrompt): void {
    const buffer = this.textBuffers.get(sessionId);
    if (buffer) {
      buffer.flush();
      // flush 后如果 buffer 为空则移除（减少内存占用）
      if (!buffer.hasContent) {
        this.textBuffers.delete(sessionId);
      }
    }
  }

  /**
   * 处理 session/request_permission 通知。
   */
  private async handlePermissionRequest(
    params: AcpPermissionRequestParams,
  ): Promise<void> {
    logger.debug({ capability: params.capability }, 'Permission request received');

    if (this.onPermissionRequest) {
      try {
        const result = await this.onPermissionRequest(params);
        // 发送权限响应通知
        this.transport.send(
          createNotification('session/request_permission_response', result),
        );
      } catch (err) {
        logger.warn({ err, capability: params.capability }, 'Permission callback error');
        // 拒绝权限
        this.transport.send(
          createNotification('session/request_permission_response', {
            outcome: { selected: true, optionId: 'deny' },
          }),
        );
      }
    } else {
      // 自动批准
      this.transport.send(
        createNotification('session/request_permission_response', {
          outcome: { selected: true, optionId: 'allow' },
        }),
      );
    }
  }

  /**
   * 处理 Transport 错误。
   */
  private handleError(err: Error): void {
    logger.error({ error: err.message }, 'Transport error');

    // 拒绝所有 pending requests
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new AcpError(`Transport error: ${err.message}`, -1));
    }
    this.pendingRequests.clear();

    // 清理所有 text buffers
    for (const [_sid, buffer] of this.textBuffers) {
      buffer.clear();
    }
    this.textBuffers.clear();

    // 终止所有活跃的 prompt streams
    for (const [_sid, active] of this.activePrompts) {
      active.error(new AcpError(`Transport error: ${err.message}`, -1));
    }
    this.activePrompts.clear();
  }

  /**
   * 处理 Transport 关闭。
   */
  private handleClose(): void {
    logger.info('Transport closed');
    this._state = 'disconnected';

    // 拒绝所有 pending requests
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new AcpError('Transport closed', -1));
    }
    this.pendingRequests.clear();

    // 清理所有 text buffers
    for (const [_sid, buffer] of this.textBuffers) {
      buffer.clear();
    }
    this.textBuffers.clear();

    // 终止所有活跃的 prompt streams
    for (const [_sid, active] of this.activePrompts) {
      active.error(new AcpError('Transport closed', -1));
    }
    this.activePrompts.clear();
  }

  /**
   * 断言已连接。
   */
  private assertConnected(): void {
    if (this._state !== 'connected') {
      throw new AcpError(
        `Not connected (state: ${this._state})`,
        -1,
      );
    }
  }
}
