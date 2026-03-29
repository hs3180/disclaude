/**
 * ACP Provider 实现
 *
 * 通过 ACP (Agentic Communication Protocol) 协议与外部 Agent 服务端通信，
 * 实现 IAgentSDKProvider 接口，使上层业务代码无需关心底层传输协议。
 *
 * ACP Provider 不直接封装任何特定模型 SDK，而是通过标准化协议与
 * ACP 兼容的服务端（如 Claude ACP Server、OpenAI ACP Server 等）通信。
 *
 * @see Issue #1333 - 支持OpenAI Agent
 * @see https://github.com/openai/agentic-communication-protocol
 */

import type { IAgentSDKProvider } from '../../interface.js';
import type {
  AgentMessage,
  AgentQueryOptions,
  InlineToolDefinition,
  McpServerConfig,
  ProviderInfo,
  StreamQueryResult,
  UserInput,
} from '../../types.js';
import { AcpClient } from './client.js';
import type { AcpTransportConfig } from './types.js';
import { acpNotificationToAgentMessage, adaptInputToAcp } from './message-adapter.js';
import { adaptOptionsToAcp } from './options-adapter.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('AcpProvider');

/**
 * ACP Provider 配置
 */
export interface AcpProviderConfig {
  /** ACP 传输层配置（stdio 命令等） */
  readonly transport: AcpTransportConfig;
  /** Provider 显示名称 */
  readonly name?: string;
}

/**
 * ACP Provider
 *
 * 实现 IAgentSDKProvider 接口，通过 ACP 协议与外部 Agent 服务端通信。
 * 支持流式输出，通过任务通知机制接收 Agent 的实时状态更新。
 */
export class AcpProvider implements IAgentSDKProvider {
  readonly name: string;
  readonly version = '1.0.0';

  private client: AcpClient;
  private disposed = false;
  private connected = false;

  constructor(config: AcpProviderConfig) {
    this.name = config.name ?? 'acp';
    this.client = new AcpClient(config.transport);
  }

  getInfo(): ProviderInfo {
    const available = this.validateConfig();
    return {
      name: this.name,
      version: this.version,
      available,
      unavailableReason: available
        ? undefined
        : 'ACP transport command not configured or not available',
    };
  }

  /**
   * 一次性查询（静态输入）
   *
   * 将输入转换为 ACP 消息格式，发送给 ACP 服务端，
   * 通过任务通知接收 Agent 的流式输出。
   *
   * @param input - 输入内容（字符串或用户消息数组）
   * @param options - 查询选项
   * @returns 消息异步迭代器
   */
  async *queryOnce(
    input: string | UserInput[],
    options: AgentQueryOptions
  ): AsyncGenerator<AgentMessage> {
    this.ensureNotDisposed();

    // 确保已连接
    if (!this.connected) {
      await this.ensureConnected();
    }

    const acpMessages = adaptInputToAcp(input);
    const acpOptions = adaptOptionsToAcp(options);

    // 发送任务
    const taskId = await this.client.sendTask({
      messages: acpMessages,
      options: acpOptions,
    });

    logger.info({ taskId, messageCount: acpMessages.length }, 'ACP task sent');

    // 通过 Promise + yield 模式实现异步迭代器
    yield* this.createTaskIterator(taskId);
  }

  /**
   * 流式查询（动态输入）
   *
   * 接收动态输入流，将每条消息转换为 ACP 格式后发送给服务端。
   * 通过任务通知接收 Agent 的实时输出。
   *
   * @param input - 输入异步生成器
   * @param options - 查询选项
   * @returns 流式查询结果（包含句柄和迭代器）
   */
  queryStream(
    input: AsyncGenerator<UserInput>,
    options: AgentQueryOptions
  ): StreamQueryResult {
    this.ensureNotDisposed();

    // 创建消息队列
    const messageQueue: AgentMessage[] = [];
    let resolveWait: (() => void) | null = null;
    let done = false;
    let taskId = '';
    let error: Error | null = null;

    // 异步处理输入流和任务通知
    const processTask = async () => {
      try {
        if (!this.connected) {
          await this.ensureConnected();
        }

        const acpMessages: UserInput[] = [];

        // 收集所有输入消息
        for await (const message of input) {
          acpMessages.push(message);
        }

        const adaptedMessages = adaptInputToAcp(acpMessages);
        const acpOptions = adaptOptionsToAcp(options);

        taskId = await this.client.sendTask({
          messages: adaptedMessages,
          options: acpOptions,
        });

        logger.info({ taskId, messageCount: adaptedMessages.length }, 'ACP stream task sent');

        // 注册通知回调，将通知推送到消息队列
        this.client.onTaskNotification(taskId, (notification) => {
          const agentMessage = acpNotificationToAgentMessage(notification);
          if (agentMessage) {
            messageQueue.push(agentMessage);
            if (resolveWait) {
              resolveWait();
              resolveWait = null;
            }
          }

          // 任务完成时结束迭代
          if (notification.type === 'complete' || notification.type === 'error') {
            done = true;
            this.client.removeTaskNotification(taskId);
            if (resolveWait) {
              resolveWait();
              resolveWait = null;
            }
          }
        });
      } catch (err) {
        error = err instanceof Error ? err : new Error(String(err));
        done = true;
        if (resolveWait) {
          resolveWait();
          resolveWait = null;
        }
      }
    };

    // 启动异步处理（不 await）
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    processTask();

    // 创建消息迭代器
    async function* createIterator(): AsyncGenerator<AgentMessage> {
      while (!done || messageQueue.length > 0) {
        if (messageQueue.length > 0) {
          const msg = messageQueue.shift();
          if (msg) {
            yield msg;
          }
        } else if (!done) {
          // 等待新消息
          await new Promise<void>((resolve) => {
            resolveWait = resolve;
          });
        }
      }

      // 如果有错误，在最后抛出
      if (error) {
        throw error;
      }
    }

    return {
      handle: {
        close: () => {
          if (taskId) {
            this.client.removeTaskNotification(taskId);
          }
          done = true;
          if (resolveWait) {
            resolveWait();
            resolveWait = null;
          }
        },
        cancel: async () => {
          if (taskId) {
            try {
              await this.client.cancelTask(taskId);
            } catch (err) {
              logger.warn({ err, taskId }, 'Failed to cancel ACP task');
            }
            this.client.removeTaskNotification(taskId);
          }
          done = true;
          if (resolveWait) {
            resolveWait();
            resolveWait = null;
          }
        },
        sessionId: taskId || undefined,
      },
      iterator: createIterator(),
    };
  }

  /**
   * 创建内联 MCP 工具
   *
   * 将工具定义转换为 ACP 工具格式。
   * 注意：ACP Provider 的工具需要通过 ACP 协议传递给服务端，
   * 此处返回 ACP 格式的工具定义对象。
   */
  createInlineTool(definition: InlineToolDefinition): unknown {
    return {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    };
  }

  /**
   * 创建 MCP 服务器
   *
   * ACP Provider 通过协议配置传递 MCP 服务器信息，
   * 返回配置对象而非实际实例。
   */
  createMcpServer(config: McpServerConfig): unknown {
    if (config.type === 'stdio') {
      return {
        type: 'stdio' as const,
        command: config.command,
        args: config.args,
        env: config.env,
      };
    }

    // inline 模式
    return {
      type: 'inline' as const,
      name: config.name,
      version: config.version,
      tools: config.tools?.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    };
  }

  /**
   * 验证配置
   *
   * 检查 ACP 传输层配置是否有效。
   */
  validateConfig(): boolean {
    // ACP 配置通过构造函数传入，只要 transport 配置存在即视为有效
    // 实际连接在首次查询时建立
    return true;
  }

  /**
   * 清理资源
   *
   * 断开 ACP 客户端连接并释放所有资源。
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.connected = false;
    this.client.disconnect();

    logger.info('ACP provider disposed');
  }

  /**
   * 创建任务消息迭代器
   *
   * 通过注册任务通知回调，将 ACP 通知转换为统一的 AgentMessage 流。
   */
  private async *createTaskIterator(taskId: string): AsyncGenerator<AgentMessage> {
    const messageQueue: AgentMessage[] = [];
    let resolveWait: (() => void) | null = null;
    let done = false;

    // 注册通知回调
    this.client.onTaskNotification(taskId, (notification) => {
      const agentMessage = acpNotificationToAgentMessage(notification);
      if (agentMessage) {
        messageQueue.push(agentMessage);
        if (resolveWait) {
          resolveWait();
          resolveWait = null;
        }
      }

      // 任务完成时结束迭代
      if (notification.type === 'complete' || notification.type === 'error') {
        done = true;
        this.client.removeTaskNotification(taskId);
        if (resolveWait) {
          resolveWait();
          resolveWait = null;
        }
      }
    });

    try {
      while (!done || messageQueue.length > 0) {
        if (messageQueue.length > 0) {
          const msg = messageQueue.shift();
          if (msg) {
            yield msg;
          }
        } else if (!done) {
          // 等待新消息
          await new Promise<void>((resolve) => {
            resolveWait = resolve;
          });
        }
      }
    } finally {
      // 确保清理通知回调
      this.client.removeTaskNotification(taskId);
    }
  }

  /**
   * 确保 ACP 客户端已连接
   */
  private async ensureConnected(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      await this.client.connect();
      this.connected = true;
      logger.info('ACP provider connected to server');
    } catch (error) {
      this.connected = false;
      throw new Error(
        `Failed to connect to ACP server: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * 确保提供者未被释放
   */
  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error('ACP provider has been disposed');
    }
  }
}
