/**
 * OpenAI Agent SDK Provider 实现
 *
 * 实现 IAgentSDKProvider 接口，封装 OpenAI Agents SDK (@openai/agents) 的功能。
 */

import { Agent, run, setDefaultOpenAIKey, tool, MCPServerStdio } from '@openai/agents';
import type { MCPServer } from '@openai/agents';
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
import { adaptStreamEvent, adaptFinalResult, adaptUserInput } from './message-adapter.js';
import type { OpenAIStreamedRunResult } from './message-adapter.js';
import { adaptOptions, adaptInput } from './options-adapter.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('OpenAIProvider');

// ============================================================================
// MCP 辅助函数
// ============================================================================

/**
 * 从 MCP 服务器配置中准备 OpenAI MCP 服务器实例和工具
 *
 * @param mcpServers - 统一的 MCP 服务器配置
 * @param cwd - 工作目录
 * @returns MCP 服务器实例列表和工具列表
 */
function prepareMcpAndTools(
  mcpServers: Record<string, McpServerConfig> | undefined,
  cwd: string | undefined,
): { servers: MCPServer[]; tools: unknown[] } {
  const servers: MCPServer[] = [];
  const openaiTools: unknown[] = [];

  if (!mcpServers) return { servers, tools: openaiTools };

  for (const [name, config] of Object.entries(mcpServers)) {
    if (config.type === 'inline') {
      // 内联工具 → 转换为 OpenAI tool() 实例
      for (const t of config.tools ?? []) {
        openaiTools.push(
          tool({
            name: t.name,
            description: t.description,
            parameters: t.parameters as never,
            execute: t.handler,
          }),
        );
      }
      logger.debug({ name, toolCount: config.tools?.length ?? 0 }, 'Inline tools prepared');
    } else if (config.type === 'stdio') {
      // stdio MCP 服务器 → 创建 MCPServerStdio 实例
      const server = new MCPServerStdio({
        command: config.command,
        args: config.args,
        env: config.env,
        ...(cwd ? { cwd } : {}),
      });
      servers.push(server);
      logger.debug({ name, command: config.command }, 'Stdio MCP server created');
    }
  }

  return { servers, tools: openaiTools };
}

/**
 * 连接所有 MCP 服务器
 */
async function connectMcpServers(servers: MCPServer[]): Promise<void> {
  for (const server of servers) {
    try {
      await server.connect();
      logger.info({ name: server.name }, 'MCP server connected');
    } catch (error) {
      logger.error({ err: error }, 'Failed to connect MCP server');
      throw new Error(
        `Failed to connect MCP server: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * 关闭所有 MCP 服务器
 */
async function closeMcpServers(servers: MCPServer[]): Promise<void> {
  for (const server of servers) {
    try {
      await server.close();
    } catch {
      // 忽略关闭错误
    }
  }
}

// ============================================================================
// OpenAI Provider
// ============================================================================

/**
 * OpenAI Agent SDK Provider
 *
 * 封装 @openai/agents 的功能，
 * 提供与 IAgentSDKProvider 接口一致的 API。
 */
export class OpenAIProvider implements IAgentSDKProvider {
  readonly name = 'openai';
  readonly version = '0.1.0';

  private disposed = false;

  // ==========================================================================
  // Provider 信息
  // ==========================================================================

  getInfo(): ProviderInfo {
    const available = this.validateConfig();
    return {
      name: this.name,
      version: this.version,
      available,
      unavailableReason: available ? undefined : 'OPENAI_API_KEY not set',
    };
  }

  // ==========================================================================
  // 查询方法
  // ==========================================================================

  async *queryOnce(
    input: string | UserInput[],
    options: AgentQueryOptions,
  ): AsyncGenerator<AgentMessage> {
    if (this.disposed) {
      throw new Error('Provider has been disposed');
    }

    const adaptedOptions = adaptOptions(options);
    const adaptedInput = adaptInput(input);

    // 配置 API 密钥
    if (adaptedOptions.apiKey) {
      setDefaultOpenAIKey(adaptedOptions.apiKey);
    }
    if (adaptedOptions.apiBaseUrl) {
      process.env.OPENAI_BASE_URL = adaptedOptions.apiBaseUrl;
    }

    // 准备 MCP 服务器和工具
    const { servers, tools } = prepareMcpAndTools(options.mcpServers, adaptedOptions.cwd);

    // 连接 MCP 服务器
    if (servers.length > 0) {
      await connectMcpServers(servers);
    }

    try {
      // 创建 Agent
      const agent = createAgent(adaptedOptions.model, tools, servers);

      // 使用流式模式运行（run 返回 Promise<StreamedRunResult>）
      const result = (await run(agent, adaptedInput as string, {
        stream: true,
      })) as unknown as OpenAIStreamedRunResult;

      // 迭代流事件
      for await (const event of result) {
        const message = adaptStreamEvent(event);
        if (message) {
          yield message;
        }
      }

      // 等待完成并生成最终结果
      await result.completed;
      yield adaptFinalResult(result);
    } catch (error) {
      yield {
        type: 'error',
        content: `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        role: 'assistant',
      };
    } finally {
      await closeMcpServers(servers);
    }
  }

  queryStream(
    input: AsyncGenerator<UserInput>,
    options: AgentQueryOptions,
  ): StreamQueryResult {
    if (this.disposed) {
      throw new Error('Provider has been disposed');
    }

    const adaptedOptions = adaptOptions(options);
    const abortController = new AbortController();
    let messageCount = 0;

    async function* adaptIterator(): AsyncGenerator<AgentMessage> {
      // 配置 API 密钥
      if (adaptedOptions.apiKey) {
        setDefaultOpenAIKey(adaptedOptions.apiKey);
      }
      if (adaptedOptions.apiBaseUrl) {
        process.env.OPENAI_BASE_URL = adaptedOptions.apiBaseUrl;
      }

      // 准备 MCP 服务器和工具
      const { servers, tools } = prepareMcpAndTools(options.mcpServers, adaptedOptions.cwd);

      // 连接 MCP 服务器
      if (servers.length > 0) {
        await connectMcpServers(servers);
      }

      try {
        // 创建 Agent
        const agent = createAgent(adaptedOptions.model, tools, servers);

        // 会话历史管理
        const history: unknown[] = [];
        let turnCount = 0;

        // 手动迭代输入流
        const inputIterator = input[Symbol.asyncIterator]();

        while (true) {
          const { value: userInput, done } = await inputIterator.next();
          if (done) {
            logger.info('Input stream ended');
            break;
          }

          turnCount++;
          logger.info({ turnCount, contentLength: userInput.content?.length }, 'Input received');

          // 适配用户消息
          const adaptedMessage = adaptUserInput(userInput);

          // 构建包含历史的输入
          const runInput = [...history, adaptedMessage];

          try {
            // 使用流式模式运行
            const result = (await run(agent, runInput as any, {
              stream: true,
              signal: abortController.signal,
            })) as unknown as OpenAIStreamedRunResult;

            // 迭代流事件
            for await (const event of result) {
              const message = adaptStreamEvent(event);
              if (message) {
                messageCount++;
                logger.info(
                  { messageCount, messageType: message.type },
                  'SDK message received',
                );
                yield message;
              }
            }

            // 更新会话历史（使用 SDK 返回的 history getter）
            if (Array.isArray(result.history) && result.history.length > 0) {
              history.length = 0;
              history.push(...result.history);
              logger.debug({ historyLength: history.length }, 'Conversation history updated');
            }
          } catch (error) {
            if (abortController.signal.aborted) {
              logger.info('Query cancelled');
              return;
            }
            yield {
              type: 'error',
              content: `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
              role: 'assistant',
            };
          }
        }
      } finally {
        await closeMcpServers(servers);
      }
    }

    return {
      handle: {
        close: () => {
          abortController.abort();
        },
        cancel: () => {
          abortController.abort();
        },
        sessionId: undefined,
      },
      iterator: adaptIterator(),
    };
  }

  // ==========================================================================
  // 工具和 MCP 服务器
  // ==========================================================================

  createInlineTool(definition: InlineToolDefinition): unknown {
    return tool({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters as never,
      execute: definition.handler,
    });
  }

  createMcpServer(config: McpServerConfig): unknown {
    if (config.type === 'inline') {
      // 内联 MCP 服务器 → 返回 OpenAI tool() 实例数组
      return config.tools?.map(t =>
        tool({
          name: t.name,
          description: t.description,
          parameters: t.parameters as never,
          execute: t.handler,
        }),
      ) ?? [];
    }

    // stdio MCP 服务器 → 创建 MCPServerStdio 实例（未连接）
    return new MCPServerStdio({
      command: config.command,
      args: config.args,
      env: config.env,
    });
  }

  // ==========================================================================
  // 生命周期
  // ==========================================================================

  validateConfig(): boolean {
    return !!process.env.OPENAI_API_KEY;
  }

  dispose(): void {
    this.disposed = true;
  }
}

// ============================================================================
// 内部辅助函数
// ============================================================================

/**
 * 创建 OpenAI Agent 实例
 */
function createAgent(
  model: string | undefined,
  tools: unknown[],
  servers: MCPServer[],
): Agent {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const options: any = {
    name: 'disclaude-assistant',
    instructions: 'You are a helpful assistant.',
    model: model || 'gpt-4o',
  };

  if (tools.length > 0) {
    options.tools = tools;
  }

  if (servers.length > 0) {
    options.mcpServers = servers;
  }

  return new Agent(options);
}
