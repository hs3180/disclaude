/**
 * ACP 协议客户端
 *
 * 封装 ACP 协议的高层操作，包括初始化握手、
 * 任务发送、任务取消、状态查询等。
 *
 * 此模块是 ACP 基础设施的核心，提供协议级别的方法
 * 和类型安全的消息构造。
 */

import { randomUUID } from 'node:crypto';
import {
  createRequest,
  type JsonRpcNotification,
} from './json-rpc.js';
import { AcpConnection } from './connection.js';
import type {
  AcpTransportConfig,
  AcpConnectionState,
  AcpConnectionEvent,
  AcpClientCapabilities,
  AcpServerCapabilities,
  AcpInitializeResult,
  AcpTaskId,
  AcpTaskMessage,
  AcpTaskSendParams,
  AcpTaskSendResult,
  AcpTaskCancelResult,
  AcpTaskStatusResult,
  AcpTaskMessageNotification,
  AcpTaskStatusNotification,
} from './types.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('AcpProtocol');

/** ACP 协议版本 */
export const ACP_PROTOCOL_VERSION = '2025-06-01';

/**
 * ACP 协议方法名常量
 */
export const AcpMethod = {
  /** 初始化握手 */
  INITIALIZE: 'initialize',
  /** 发送任务 */
  TASK_SEND: 'tasks/send',
  /** 取消任务 */
  TASK_CANCEL: 'tasks/cancel',
  /** 查询任务状态 */
  TASK_STATUS: 'tasks/status',
} as const;

/**
 * ACP 通知方法名常量
 */
export const AcpNotification = {
  /** 任务消息流 */
  TASK_MESSAGE: 'notifications/task/message',
  /** 任务状态变更 */
  TASK_STATUS: 'notifications/task/status',
} as const;

/**
 * ACP 协议客户端
 *
 * 提供类型安全的 ACP 协议操作接口。
 * 使用前必须先调用 `connect()` 完成连接和初始化握手。
 */
export class AcpClient {
  private connection: AcpConnection;
  private serverCapabilities: AcpServerCapabilities | null = null;
  private clientCapabilities: AcpClientCapabilities;
  private disposed = false;

  /** 流式任务消息监听器 */
  private taskMessageListeners = new Map<AcpTaskId, Set<(notification: AcpTaskMessageNotification) => void>>();

  /** 任务状态变更监听器 */
  private taskStatusListeners = new Map<AcpTaskId, Set<(notification: AcpTaskStatusNotification) => void>>();

  constructor(clientCapabilities?: Partial<AcpClientCapabilities>) {
    this.clientCapabilities = {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientName: clientCapabilities?.clientName ?? 'disclaude-acp-client',
      clientVersion: clientCapabilities?.clientVersion ?? '0.1.0',
      ...clientCapabilities,
    };

    this.connection = new AcpConnection();

    // 设置通知路由
    this.connection.onNotification((notification) => {
      this.routeNotification(notification);
    });
  }

  /**
   * 获取服务端能力（初始化后可用）
   */
  getServerCapabilities(): AcpServerCapabilities | null {
    return this.serverCapabilities;
  }

  /**
   * 获取连接状态
   */
  getConnectionState(): AcpConnectionState {
    return this.connection.getState();
  }

  /**
   * 连接到 ACP Server 并完成初始化握手
   */
  async connect(config: AcpTransportConfig): Promise<AcpInitializeResult> {
    if (this.disposed) {
      throw new Error('Client has been disposed');
    }

    // 建立传输层连接
    if (config.type === 'stdio') {
      await this.connection.connectStdio(config);
    } else {
      throw new Error(`SSE transport is not yet supported (type="${config.type}")`);
    }

    // 执行初始化握手
    const result = await this.initialize();
    return result;
  }

  /**
   * 监听连接事件
   */
  onConnectionEvent(listener: (event: AcpConnectionEvent) => void): void {
    this.connection.on('connected', listener);
    this.connection.on('disconnected', listener);
    this.connection.on('error', listener);
  }

  /**
   * 发送任务到 ACP Server
   *
   * @param messages - 对话消息列表
   * @param options - 任务选项
   * @returns 任务发送结果（包含 taskId 和状态）
   */
  async sendTask(
    messages: AcpTaskMessage[],
    options?: {
      model?: string;
      systemPrompt?: string;
      temperature?: number;
      maxTokens?: number;
      allowedTools?: string[];
      stream?: boolean;
      taskId?: AcpTaskId;
    }
  ): Promise<AcpTaskSendResult> {
    const taskId = options?.taskId ?? randomUUID();

    const params: AcpTaskSendParams = {
      taskId,
      messages,
      options: options ? {
        model: options.model,
        systemPrompt: options.systemPrompt,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        allowedTools: options.allowedTools,
        stream: options.stream,
      } : undefined,
    };

    const response = await this.connection.sendRequest(
      createRequest(AcpMethod.TASK_SEND, params as unknown as Record<string, unknown>, taskId)
    );

    if ('error' in response) {
      throw new Error(`Task send failed: ${response.error.message}`);
    }

    return response.result as AcpTaskSendResult;
  }

  /**
   * 取消正在运行的任务
   */
  async cancelTask(taskId: AcpTaskId): Promise<AcpTaskCancelResult> {
    const response = await this.connection.sendRequest(
      createRequest(AcpMethod.TASK_CANCEL, { taskId }, taskId)
    );

    if ('error' in response) {
      throw new Error(`Task cancel failed: ${response.error.message}`);
    }

    return response.result as AcpTaskCancelResult;
  }

  /**
   * 查询任务状态
   */
  async getTaskStatus(taskId: AcpTaskId): Promise<AcpTaskStatusResult> {
    const response = await this.connection.sendRequest(
      createRequest(AcpMethod.TASK_STATUS, { taskId }, taskId)
    );

    if ('error' in response) {
      throw new Error(`Task status query failed: ${response.error.message}`);
    }

    return response.result as AcpTaskStatusResult;
  }

  /**
   * 注册任务消息监听器（用于接收流式任务消息）
   *
   * @param taskId - 任务 ID
   * @param listener - 消息监听器
   * @returns 取消注册的函数
   */
  onTaskMessage(
    taskId: AcpTaskId,
    listener: (notification: AcpTaskMessageNotification) => void
  ): () => void {
    const listeners = this.getOrCreateListeners(this.taskMessageListeners, taskId);
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.taskMessageListeners.delete(taskId);
      }
    };
  }

  /**
   * 注册任务状态变更监听器
   *
   * @param taskId - 任务 ID
   * @param listener - 状态变更监听器
   * @returns 取消注册的函数
   */
  onTaskStatus(
    taskId: AcpTaskId,
    listener: (notification: AcpTaskStatusNotification) => void
  ): () => void {
    const listeners = this.getOrCreateListeners(this.taskStatusListeners, taskId);
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.taskStatusListeners.delete(taskId);
      }
    };
  }

  /**
   * 获取或创建监听器集合
   */
  private getOrCreateListeners<T>(
    map: Map<string, Set<T>>,
    key: string
  ): Set<T> {
    let listeners = map.get(key);
    if (!listeners) {
      listeners = new Set();
      map.set(key, listeners);
    }
    return listeners;
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    this.connection.disconnect();
    this.serverCapabilities = null;
  }

  /**
   * 释放资源
   */
  dispose(): void {
    this.disposed = true;
    this.taskMessageListeners.clear();
    this.taskStatusListeners.clear();
    this.connection.dispose();
    this.serverCapabilities = null;
  }

  /**
   * 执行初始化握手
   */
  private async initialize(): Promise<AcpInitializeResult> {
    const requestId = randomUUID();

    const response = await this.connection.sendRequest(
      createRequest(AcpMethod.INITIALIZE, {
        capabilities: this.clientCapabilities,
      }, requestId)
    );

    if ('error' in response) {
      throw new Error(`ACP initialization failed: ${response.error.message}`);
    }

    const result = response.result as AcpInitializeResult;
    this.serverCapabilities = result.capabilities;

    logger.info(
      {
        server: result.capabilities.serverName,
        version: result.capabilities.serverVersion,
        protocol: result.capabilities.protocolVersion,
      },
      'ACP server initialized'
    );

    return result;
  }

  /**
   * 路由通知到对应的监听器
   */
  private routeNotification(notification: JsonRpcNotification): void {
    const { method, params } = notification;
    const { taskId } = (params ?? {}) as { taskId?: string };

    if (!taskId) {
      logger.debug({ method }, 'Received notification without taskId, ignoring');
      return;
    }

    if (method === AcpNotification.TASK_MESSAGE) {
      const listeners = this.taskMessageListeners.get(taskId);
      if (listeners) {
        const typedNotification = params as unknown as AcpTaskMessageNotification;
        for (const listener of listeners) {
          try {
            listener(typedNotification);
          } catch (err) {
            logger.error({ taskId, err }, 'Task message listener error');
          }
        }
      }
    } else if (method === AcpNotification.TASK_STATUS) {
      const listeners = this.taskStatusListeners.get(taskId);
      if (listeners) {
        const typedNotification = params as unknown as AcpTaskStatusNotification;
        for (const listener of listeners) {
          try {
            listener(typedNotification);
          } catch (err) {
            logger.error({ taskId, err }, 'Task status listener error');
          }
        }
      }
    } else {
      logger.debug({ method }, 'Received unknown notification type');
    }
  }
}
