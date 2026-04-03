/**
 * ACP 连接管理器
 *
 * 管理 ACP 协议的连接生命周期，包括：
 * - Agent 子进程启动和管理
 * - 初始化握手和能力协商
 * - 会话创建和管理
 * - 请求/响应路由和超时处理
 * - 连接状态管理
 *
 * @see https://agentclientprotocol.com
 * @see Issue #1333 - 支持OpenAI Agent
 */

import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type {
  AcpConnectionConfig,
  AcpConnectionState,
  AcpContentBlock,
  AgentCapabilities,
  AgentInfo,
  AuthMethod,
  ClientInfo,
  JsonRpcMessage,
  SessionNewParams,
  SessionNewResult,
  SessionLoadParams,
  SessionLoadResult,
  SessionPromptResult,
  SessionUpdateNotification,
  AuthenticateParams,
  AuthenticateResult,
  InitializeResult,
  RequestPermissionParams,
} from './types.js';
import {
  createRequest,
  createNotification,
  isValidJsonRpcMessage,
  isSuccessResponse,
  isErrorResponse,
  JsonRpcError,
} from './json-rpc.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('AcpConnection');

/** 等待响应的请求条目 */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * ACP 连接管理器
 *
 * 管理 Client 与 Agent 之间的 ACP 协议连接。
 * 实现 JSON-RPC 2.0 over stdio 传输层。
 *
 * Events:
 * - 'state_change' (state: AcpConnectionState)
 * - 'session_update' (notification: SessionUpdateNotification)
 * - 'request_permission' (params: RequestPermissionParams)
 * - 'error' (error: Error)
 * - 'close' ()
 */
export class AcpConnection extends EventEmitter {
  private config: AcpConnectionConfig;
  private process: ChildProcess | null = null;
  private state: AcpConnectionState = 'disconnected';
  private pendingRequests = new Map<number, PendingRequest>();
  private requestTimeout: number;
  private initTimeout: number;
  private buffer = '';

  /** Agent 信息（初始化后可用） */
  private agentInfo: AgentInfo | null = null;
  /** Agent 能力（初始化后可用） */
  private agentCapabilities: AgentCapabilities | null = null;
  /** 认证方法（初始化后可用） */
  private authMethods: AuthMethod[] = [];
  /** 协议版本 */
  private protocolVersion = 1;
  /** 当前会话 ID */
  private sessionId: string | null = null;

  constructor(config: AcpConnectionConfig) {
    super();
    this.config = config;
    this.requestTimeout = config.requestTimeout ?? 30000;
    this.initTimeout = config.initTimeout ?? 10000;
  }

  // ==========================================================================
  // 状态访问器
  // ==========================================================================

  /** 获取当前连接状态 */
  getState(): AcpConnectionState {
    return this.state;
  }

  /** 获取 Agent 信息 */
  getAgentInfo(): AgentInfo | null {
    return this.agentInfo;
  }

  /** 获取 Agent 能力 */
  getAgentCapabilities(): AgentCapabilities | null {
    return this.agentCapabilities;
  }

  /** 获取协议版本 */
  getProtocolVersion(): number {
    return this.protocolVersion;
  }

  /** 获取当前会话 ID */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /** 获取客户端信息 */
  getClientInfo(): ClientInfo {
    return this.config.clientInfo;
  }

  // ==========================================================================
  // 连接生命周期
  // ==========================================================================

  /**
   * 启动 Agent 子进程并完成初始化握手
   *
   * 完整的初始化流程：
   * 1. 启动 Agent 子进程
   * 2. 发送 initialize 请求
   * 3. 接收 Agent 能力声明
   * 4. 如果需要认证，发送 authenticate 请求
   */
  async connect(): Promise<void> {
    if (this.state !== 'disconnected') {
      throw new JsonRpcError(
        -32001,
        `Cannot connect in state: ${this.state}`
      );
    }

    this.setState('connecting');

    try {
      // 启动 Agent 子进程
      this.startAgentProcess();
      this.setState('initializing');

      // 初始化握手
      const initResult = await this.initialize();
      this.agentInfo = initResult.agentInfo;
      this.agentCapabilities = initResult.agentCapabilities ?? null;
      this.authMethods = initResult.authMethods ?? [];
      this.protocolVersion = initResult.protocolVersion;

      // 认证（如果 Agent 要求）
      if (this.authMethods.length > 0) {
        this.setState('authenticating');
        await this.authenticate();
      }

      this.setState('ready');
      logger.info(
        { agent: this.agentInfo, protocolVersion: this.protocolVersion },
        'ACP connection established'
      );
    } catch (error) {
      this.setState('error');
      this.cleanup();
      throw error;
    }
  }

  /**
   * 关闭连接并终止 Agent 子进程
   */
  disconnect(): void {
    if (this.state === 'disconnected' || this.state === 'closed') {
      return;
    }

    this.setState('closed');
    this.cleanup();
    this.emit('close');
  }

  // ==========================================================================
  // ACP 协议方法
  // ==========================================================================

  /**
   * 创建新会话
   *
   * @param params - 会话创建参数
   * @returns 会话 ID
   */
  async newSession(params?: SessionNewParams): Promise<SessionNewResult> {
    this.ensureReady();
    const result = await this.sendRequest<SessionNewResult>('session/new', params);
    this.sessionId = result.sessionId;
    return result;
  }

  /**
   * 加载已有会话
   *
   * @param params - 会话加载参数
   * @returns 会话 ID
   */
  async loadSession(params: SessionLoadParams): Promise<SessionLoadResult> {
    this.ensureReady();
    const result = await this.sendRequest<SessionLoadResult>('session/load', params);
    this.sessionId = result.sessionId;
    return result;
  }

  /**
   * 发送提示到 Agent
   *
   * Agent 会通过 session/update 通知流式返回内容。
   *
   * @param prompt - 提示内容
   * @param sessionId - 会话 ID（可选，默认使用当前会话）
   * @returns 提示结果（包含停止原因）
   */
  async prompt(
    prompt: AcpContentBlock[],
    sessionId?: string
  ): Promise<SessionPromptResult> {
    this.ensureReady();

    const sid = sessionId ?? this.sessionId;
    if (!sid) {
      throw new JsonRpcError(-32001, 'No active session. Call newSession() first.');
    }

    return this.sendRequest<SessionPromptResult>('session/prompt', {
      sessionId: sid,
      prompt,
    });
  }

  /**
   * 取消当前提示处理
   *
   * @param sessionId - 会话 ID（可选，默认使用当前会话）
   */
  cancel(sessionId?: string): void {
    const sid = sessionId ?? this.sessionId;
    if (!sid) {
      return;
    }

    this.sendNotification('session/cancel', { sessionId: sid });
  }

  // ==========================================================================
  // 内部实现
  // ==========================================================================

  /**
   * 启动 Agent 子进程
   */
  private startAgentProcess(): void {
    const { agentCommand, agentArgs, agentEnv } = this.config;

    logger.info({ command: agentCommand, args: agentArgs }, 'Starting agent process');

    this.process = spawn(agentCommand, agentArgs ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...agentEnv },
    });

    this.process.on('error', (error) => {
      logger.error({ err: error }, 'Agent process error');
      this.setState('error');
      this.rejectAllPending(new Error(`Agent process error: ${error.message}`));
    });

    this.process.on('exit', (code, signal) => {
      logger.info({ code, signal }, 'Agent process exited');
      if (this.state !== 'closed') {
        this.setState('disconnected');
        this.rejectAllPending(new Error(`Agent process exited with code ${code}`));
        this.emit('close');
      }
    });

    // 处理 stdout 数据
    this.process.stdout?.on('data', (data: Buffer) => {
      this.handleData(data.toString());
    });

    // 捕获 stderr 日志
    this.process.stderr?.on('data', (data: Buffer) => {
      logger.debug({ stderr: data.toString() }, 'Agent stderr');
    });
  }

  /**
   * 处理从 Agent 接收的数据
   */
  private handleData(data: string): void {
    // 追加到缓冲区并尝试解析完整消息
    this.buffer += data;
    const lines = this.buffer.split('\n');
    // 最后一个元素可能是不完整的行，保留在缓冲区
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      try {
        const message = JSON.parse(trimmed) as JsonRpcMessage;
        if (!isValidJsonRpcMessage(message)) {
          logger.warn({ message }, 'Invalid JSON-RPC message received');
          continue;
        }
        this.handleMessage(message);
      } catch (error) {
        logger.warn({ err: error, line: trimmed }, 'Failed to parse message');
      }
    }
  }

  /**
   * 路由接收到的 JSON-RPC 消息
   */
  private handleMessage(message: JsonRpcMessage): void {
    if (isSuccessResponse(message)) {
      this.handleResponse(message.id, message.result);
    } else if (isErrorResponse(message)) {
      const errMsg = message;
      if (errMsg.id !== null) {
        this.handleResponse(errMsg.id, new JsonRpcError(
          errMsg.error.code,
          errMsg.error.message,
          errMsg.error.data
        ));
      } else {
        logger.error(
          { code: errMsg.error.code, message: errMsg.error.message },
          'Received error response with null id'
        );
      }
    } else if ('method' in message && 'params' in message) {
      const req = message as { method: string; params?: unknown };
      this.handleIncomingMethod(req.method, req.params);
    }
  }

  /**
   * 处理响应（成功或错误）
   */
  private handleResponse(id: number, result: unknown): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      logger.warn({ id }, 'Received response for unknown request');
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(id);

    if (result instanceof Error) {
      pending.reject(result);
    } else {
      pending.resolve(result);
    }
  }

  /**
   * 处理来自 Agent 的方法调用和通知
   */
  private handleIncomingMethod(method: string, params: unknown): void {
    switch (method) {
      case 'session/update':
        this.emit('session_update', params as SessionUpdateNotification);
        break;

      case 'session/request_permission':
        this.emit('request_permission', params as RequestPermissionParams);
        break;

      default:
        logger.debug({ method, params }, 'Unhandled incoming method');
        break;
    }
  }

  /**
   * 发送 JSON-RPC 请求并等待响应
   */
  private sendRequest<TResult = unknown>(
    method: string,
    params?: unknown,
    timeout?: number
  ): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      const request = createRequest(method, params);
      const timer = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new Error(`Request timeout: ${method} (${timeout ?? this.requestTimeout}ms)`));
      }, timeout ?? this.requestTimeout);

      this.pendingRequests.set(request.id, { resolve: resolve as (r: unknown) => void, reject, timer });
      this.writeMessage(request);
    });
  }

  /**
   * 发送 JSON-RPC 通知（不等待响应）
   */
  private sendNotification(method: string, params?: unknown): void {
    const notification = createNotification(method, params);
    this.writeMessage(notification);
  }

  /**
   * 写入消息到 Agent 进程的 stdin
   */
  private writeMessage(message: JsonRpcMessage): void {
    if (!this.process?.stdin?.writable) {
      throw new JsonRpcError(-32001, 'Agent process stdin is not available');
    }

    const data = JSON.stringify(message) + '\n';
    this.process.stdin.write(data);
  }

  /**
   * 初始化握手
   */
  private async initialize(): Promise<InitializeResult> {
    const params = {
      protocolVersion: 1,
      clientCapabilities: this.config.clientCapabilities,
      clientInfo: this.config.clientInfo,
    };

    const result = await this.sendRequest<InitializeResult>(
      'initialize',
      params,
      this.initTimeout
    );

    // 验证协议版本
    if (result.protocolVersion > 1) {
      logger.warn(
        { requested: 1, received: result.protocolVersion },
        'Agent requested newer protocol version'
      );
    }

    return result;
  }

  /**
   * 认证
   */
  private async authenticate(): Promise<void> {
    const method = this.authMethods[0]?.id;
    if (!method) {
      return;
    }

    const token = this.config.agentEnv?.['ACP_AUTH_TOKEN'];
    if (!token) {
      logger.warn('Agent requires authentication but no ACP_AUTH_TOKEN provided');
      return;
    }

    const params: AuthenticateParams = { method, token };
    const result = await this.sendRequest<AuthenticateResult>(
      'authenticate',
      params,
      this.initTimeout
    );

    if (!result.success) {
      throw new JsonRpcError(-32000, 'Authentication failed');
    }
  }

  /**
   * 更新连接状态
   */
  private setState(state: AcpConnectionState): void {
    const oldState = this.state;
    this.state = state;
    if (oldState !== state) {
      logger.debug({ from: oldState, to: state }, 'Connection state changed');
      this.emit('state_change', state);
    }
  }

  /**
   * 确保连接处于就绪状态
   */
  private ensureReady(): void {
    if (this.state !== 'ready') {
      throw new JsonRpcError(-32001, `Connection not ready: ${this.state}`);
    }
  }

  /**
   * 拒绝所有等待中的请求
   */
  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  /**
   * 清理资源
   */
  private cleanup(): void {
    this.rejectAllPending(new Error('Connection closed'));

    if (this.process) {
      // 关闭 stdin 以通知 Agent
      this.process.stdin?.end();

      // 给 Agent 一点时间优雅退出
      const proc = this.process;
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGTERM');
        }
      }, 1000);

      this.process = null;
    }

    this.agentInfo = null;
    this.agentCapabilities = null;
    this.authMethods = [];
    this.sessionId = null;
    this.buffer = '';
  }
}
