/**
 * OpenAI SDK Provider 实现
 *
 * 实现 IAgentSDKProvider 接口，封装 OpenAI Agents SDK 的功能。
 */

import {
  Agent,
  run,
  tool,
  MCPServerStdio,
} from '@openai/agents';
import type { RunStreamEvent } from '@openai/agents';
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
import { adaptStreamEvent, adaptStreamResult } from './message-adapter.js';
import { adaptOptions, adaptInput } from './options-adapter.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('OpenAIProvider');

/**
 * OpenAI SDK Provider
 *
 * 封装 @openai/agents SDK 的功能，
 * 提供与 IAgentSDKProvider 接口一致的 API。
 */
export class OpenAIProvider implements IAgentSDKProvider {
  readonly name = 'openai';
  readonly version = '0.1.0';

  private disposed = false;

  getInfo(): ProviderInfo {
    const available = this.validateConfig();
    return {
      name: this.name,
      version: this.version,
      available,
      unavailableReason: available ? undefined : 'OPENAI_API_KEY not set',
    };
  }

  async *queryOnce(
    input: string | UserInput[],
    options: AgentQueryOptions
  ): AsyncGenerator<AgentMessage> {
    if (this.disposed) {
      throw new Error('Provider has been disposed');
    }

    const sdkOptions = adaptOptions(options);
    const adaptedInput = adaptInput(input);

    // 创建 Agent 实例
    const agent = this.createAgent(options);

    // 流式运行（run() 返回 Promise<StreamedRunResult>）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const streamResult = await run(agent as any, adaptedInput, {
      stream: true,
      ...sdkOptions,
    } as any);

    // 迭代流事件并适配消息
    yield* this.processStream(streamResult);
  }

  queryStream(
    input: AsyncGenerator<UserInput>,
    options: AgentQueryOptions
  ): StreamQueryResult {
    if (this.disposed) {
      throw new Error('Provider has been disposed');
    }

    const sdkOptions = adaptOptions(options);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agent = this.createAgent(options) as any;

    // 使用 AbortController 进行取消控制
    const abortController = new AbortController();
    let closed = false;

    // 创建消息适配迭代器
    let messageCount = 0;
    async function* adaptIterator(): AsyncGenerator<AgentMessage> {
      const inputIter = input[Symbol.asyncIterator]();

      // 读取第一条用户输入
      const { value: firstValue, done: firstDone } = await inputIter.next();
      if (firstDone || closed || abortController.signal.aborted) return;

      // 使用 state 进行多轮对话
      let runState: unknown;
      const firstInput = typeof firstValue.content === 'string'
        ? firstValue.content
        : JSON.stringify(firstValue.content);

      while (!closed && !abortController.signal.aborted) {
        try {
          // 运行 Agent（首次使用字符串输入，后续使用 state）
          const runInput = runState ?? firstInput;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const streamResult: any = await run(agent, runInput as any, {
            stream: true,
            signal: abortController.signal,
            ...sdkOptions,
          } as any);

          // 迭代流事件
          for await (const event of streamResult as unknown as AsyncIterable<RunStreamEvent>) {
            if (closed || abortController.signal.aborted) break;

            const message = adaptStreamEvent(event);
            if (message) {
              messageCount++;
              logger.info(
                { messageCount, messageType: message.type },
                'SDK message received'
              );
              yield message;
            }
          }

          // 获取最终结果（包含使用统计）
          if (!closed && !abortController.signal.aborted) {
            yield adaptStreamResult(streamResult);
          }

          // 保存 state 用于下一轮对话
          runState = (streamResult as any).state;
        } catch (error) {
          if (abortController.signal.aborted) break;
          logger.error({ err: error, messageCount }, 'adaptIterator error');
          if (!closed) {
            yield {
              type: 'error',
              content: `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
              role: 'assistant',
              raw: error,
            };
          }
        }

        // 读取下一条用户输入
        const { done } = await inputIter.next();
        if (done || closed || abortController.signal.aborted) break;

        // 重置 runState
        // OpenAI SDK 的 RunState 可以在后续 run() 中继续对话
        // 但新输入需要通过 Session 机制追加
        // 当前实现：每次新输入重置 state，使用完整对话历史
        runState = undefined;
      }
    }

    return {
      handle: {
        close: () => {
          closed = true;
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

  createInlineTool(definition: InlineToolDefinition): unknown {
    return tool({
      name: definition.name,
      description: definition.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parameters: definition.parameters as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: definition.handler as any,
    });
  }

  createMcpServer(config: McpServerConfig): unknown {
    if (config.type === 'stdio') {
      if (config.args && config.args.length > 0) {
        return new MCPServerStdio({
          command: config.command,
          args: config.args,
          env: config.env,
        });
      }
      return new MCPServerStdio({
        command: config.command,
        env: config.env,
      });
    }

    if (config.type === 'inline') {
      throw new Error(
        'Inline MCP servers are not supported by OpenAIProvider.createMcpServer. ' +
        'Use createInlineTool() for each tool instead.'
      );
    }

    // TypeScript 需要此 unreachable 分支来处理联合类型的穷尽检查
    const _exhaustive: never = config;
    throw new Error(`Unsupported MCP server config type: ${_exhaustive}`);
  }

  validateConfig(): boolean {
    return !!process.env.OPENAI_API_KEY;
  }

  dispose(): void {
    this.disposed = true;
  }

  /**
   * 创建 OpenAI Agent 实例
   *
   * @param options - 查询选项
   * @returns Agent 实例
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private createAgent(options: AgentQueryOptions): Agent<any, any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agentConfig: any = {
      name: 'disclaude-assistant',
      instructions: 'You are a helpful assistant with access to various tools.',
    };

    // 设置模型
    if (options.model) {
      agentConfig.model = options.model;
    }

    // 收集内联工具
    const inlineTools: unknown[] = [];
    // 收集 MCP 服务器
    const mcpServers: unknown[] = [];

    if (options.mcpServers) {
      for (const config of Object.values(options.mcpServers)) {
        if (config.type === 'inline' && config.tools) {
          for (const toolDef of config.tools) {
            inlineTools.push(this.createInlineTool(toolDef));
          }
        } else if (config.type === 'stdio') {
          try {
            mcpServers.push(this.createMcpServer(config));
          } catch (err) {
            logger.warn({ err }, 'Failed to create MCP server');
          }
        }
      }
    }

    if (inlineTools.length > 0) {
      agentConfig.tools = inlineTools;
    }

    if (mcpServers.length > 0) {
      agentConfig.mcpServers = mcpServers;
    }

    return new Agent(agentConfig);
  }

  /**
   * 处理流事件并生成 AgentMessage
   *
   * @param streamResult - 流式运行结果
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async *processStream(streamResult: any): AsyncGenerator<AgentMessage> {
    for await (const event of streamResult as AsyncIterable<RunStreamEvent>) {
      const message = adaptStreamEvent(event);
      if (message) {
        yield message;
      }
    }

    // 流结束后，生成结果消息
    yield adaptStreamResult(streamResult);
  }
}
