/**
 * ACP 连接管理器
 *
 * 管理 ACP Client 与 ACP Server 之间的连接生命周期，
 * 包括健康检查、自动重连、Agent 缓存等。
 *
 * @see Issue #1333 - 支持OpenAI Agent
 * @module sdk/acp/connection
 */

import type { AcpAgentManifest, AcpClientConfig } from './types.js';
import { createTransport, AcpHttpTransport, type IAcpTransport } from './transport.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('AcpConnection');

/** 连接状态 */
export type AcpConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/** 连接状态变化回调 */
export type ConnectionStateCallback = (state: AcpConnectionState) => void;

/** 连接管理器配置 */
export interface AcpConnectionManagerOptions extends AcpClientConfig {
  /** 健康检查间隔（毫秒，默认 30000，设为 0 禁用） */
  healthCheckInterval?: number;
  /** 连接超时（毫秒，默认 5000） */
  connectTimeout?: number;
}

/**
 * ACP 连接管理器
 *
 * 职责：
 * - 管理 ACP Server 连接生命周期
 * - 定期健康检查
 * - Agent Manifest 缓存
 * - 连接状态管理
 */
export class AcpConnectionManager {
  private transport: IAcpTransport;
  private state: AcpConnectionState = 'disconnected';
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private agentCache = new Map<string, AcpAgentManifest>();
  private stateCallbacks: Set<ConnectionStateCallback> = new Set();

  private readonly healthCheckInterval: number;
  private readonly connectTimeout: number;

  constructor(options: AcpConnectionManagerOptions) {
    this.transport = createTransport(options);
    this.healthCheckInterval = options.healthCheckInterval ?? 30000;
    this.connectTimeout = options.connectTimeout ?? 5000;
  }

  // ==========================================================================
  // 连接生命周期
  // ==========================================================================

  /**
   * 连接到 ACP Server
   *
   * 验证服务器可用性并初始化健康检查。
   */
  async connect(): Promise<void> {
    if (this.state === 'connected') {
      return;
    }

    this.setState('connecting');

    try {
      // 带超时的健康检查
      const healthy = await Promise.race([
        this.transport.ping(),
        new Promise<boolean>((_, reject) =>
          setTimeout(() => reject(new Error('Connection timeout')), this.connectTimeout)
        ),
      ]);

      if (!healthy) {
        throw new Error('ACP server health check failed');
      }

      this.setState('connected');
      this.startHealthCheck();
      logger.info({ baseUrl: this.getBaseUrl() }, 'Connected to ACP server');
    } catch (error) {
      this.setState('error');
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to connect to ACP server: ${message}`);
    }
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    this.stopHealthCheck();
    this.transport.dispose();
    this.agentCache.clear();
    this.setState('disconnected');
    logger.info('Disconnected from ACP server');
  }

  // ==========================================================================
  // Agent 发现
  // ==========================================================================

  /**
   * 获取所有可用 Agent 的 Manifest
   *
   * @param useCache - 是否使用缓存（默认 true）
   */
  async listAgents(useCache = true): Promise<AcpAgentManifest[]> {
    this.ensureConnected();

    if (useCache && this.agentCache.size > 0) {
      return [...this.agentCache.values()];
    }

    const agents = await this.transport.listAgents();

    // 更新缓存
    this.agentCache.clear();
    for (const agent of agents) {
      this.agentCache.set(agent.name, agent);
    }

    return agents;
  }

  /**
   * 获取指定 Agent 的 Manifest
   *
   * @param name - Agent 名称
   * @param useCache - 是否使用缓存（默认 true）
   */
  async getAgent(name: string, useCache = true): Promise<AcpAgentManifest> {
    this.ensureConnected();

    if (useCache) {
      const cached = this.agentCache.get(name);
      if (cached) {
        return cached;
      }
    }

    const manifest = await this.transport.getAgent(name);
    this.agentCache.set(name, manifest);
    return manifest;
  }

  // ==========================================================================
  // 传输层访问
  // ==========================================================================

  /**
   * 获取底层传输层（用于发送 Run 请求等操作）
   */
  getTransport(): IAcpTransport {
    this.ensureConnected();
    return this.transport;
  }

  /**
   * 获取连接状态
   */
  getState(): AcpConnectionState {
    return this.state;
  }

  /**
   * 获取 Server 基础 URL
   */
  getBaseUrl(): string {
    if (this.transport instanceof AcpHttpTransport) {
      return this.transport['baseUrl'];
    }
    return 'unknown';
  }

  // ==========================================================================
  // 状态管理
  // ==========================================================================

  /**
   * 注册连接状态变化回调
   */
  onStateChange(callback: ConnectionStateCallback): () => void {
    this.stateCallbacks.add(callback);
    return () => {
      this.stateCallbacks.delete(callback);
    };
  }

  /**
   * 清除 Agent 缓存
   */
  clearAgentCache(): void {
    this.agentCache.clear();
  }

  // ==========================================================================
  // 内部方法
  // ==========================================================================

  private setState(newState: AcpConnectionState): void {
    if (this.state === newState) {
      return;
    }

    const oldState = this.state;
    this.state = newState;
    logger.info({ oldState, newState }, 'Connection state changed');

    for (const callback of this.stateCallbacks) {
      try {
        callback(newState);
      } catch (error) {
        logger.error({ err: error }, 'State change callback error');
      }
    }
  }

  private startHealthCheck(): void {
    if (this.healthCheckInterval <= 0) {
      return;
    }

    this.stopHealthCheck();
    this.healthCheckTimer = setInterval(async () => {
      try {
        const healthy = await this.transport.ping();
        if (!healthy) {
          this.setState('error');
        } else if (this.state === 'error') {
          this.setState('connected');
        }
      } catch {
        if (this.state === 'connected') {
          this.setState('error');
        }
      }
    }, this.healthCheckInterval);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer !== null) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private ensureConnected(): void {
    if (this.state !== 'connected') {
      throw new Error(
        `ACP connection is not connected (current state: ${this.state}). Call connect() first.`
      );
    }
  }
}
