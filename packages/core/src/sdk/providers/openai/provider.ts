/**
 * OpenAI Agents SDK Provider 实现
 *
 * 实现 IAgentSDKProvider 接口，封装 OpenAI Agents SDK 的功能。
 */

import { createRequire } from 'node:module';
import type { IAgentSDKProvider } from '../../interface.js';
import type {
  AgentMessage,
  AgentQueryOptions,
  InlineToolDefinition,
  McpServerConfig,
  ProviderInfo,
  QueryHandle,
  StreamQueryResult,
  UserInput,
} from '../../types.js';
import { adaptStreamEvent, adaptRunResult } from './message-adapter.js';
import { adaptInput, extractOpenAIConfig, adaptMcpServers, adaptInlineTools } from './options-adapter.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('OpenAISDKProvider');

// Synchronous require for ESM compatibility
const nativeRequire = createRequire(import.meta.url);

/** Type alias for the OpenAI Agents module */
type AgentModule = typeof import('@openai/agents');

/**
 * OpenAI Agents SDK Provider
 */
export class OpenAISDKProvider implements IAgentSDKProvider {
  readonly name = 'openai';
  readonly version = '0.7.2';

  private disposed = false;

  private loadAgentModuleSync(): AgentModule {
    try {
      return nativeRequire('@openai/agents');
    } catch {
      throw new Error('Failed to load @openai/agents. Install it with: npm install @openai/agents');
    }
  }

  private async loadAgentModuleAsync(): Promise<AgentModule> {
    try {
      return await import('@openai/agents');
    } catch {
      throw new Error('Failed to load @openai/agents. Install it with: npm install @openai/agents');
    }
  }

  private createModel(AgentModule: AgentModule, config: { apiKey?: string; baseUrl?: string; model?: string }): unknown {
    const modelName = config.model || 'gpt-4o';
    // Use the openai package directly to create a client
    const OpenAI = nativeRequire('openai').default;
    const clientConfig: Record<string, unknown> = {};
    if (config.apiKey) {
      clientConfig.apiKey = config.apiKey;
    }
    if (config.baseUrl) {
      clientConfig.baseURL = config.baseUrl;
    }
    const client = new OpenAI(clientConfig);
    return new AgentModule.OpenAIResponsesModel(client, modelName);
  }

  getInfo(): ProviderInfo {
    const available = this.validateConfig();
    return {
      name: this.name,
      version: this.version,
      available,
      unavailableReason: available
        ? undefined
        : 'OPENAI_API_KEY not set or @openai/agents not installed',
    };
  }

  async *queryOnce(
    input: string | UserInput[],
    options: AgentQueryOptions
  ): AsyncGenerator<AgentMessage> {
    if (this.disposed) {
      throw new Error('Provider has been disposed');
    }

    const AgentModule = await this.loadAgentModuleAsync();
    const config = extractOpenAIConfig(options);

    if (config.apiKey) {
      AgentModule.setDefaultOpenAIKey(config.apiKey);
    }

    const model = this.createModel(AgentModule, config);
    const inlineTools = await adaptInlineTools(options.mcpServers, AgentModule);
    const mcpServers = options.mcpServers
      ? await adaptMcpServers(options.mcpServers, AgentModule)
      : [];

    const agentConfig: Record<string, unknown> = {
      name: 'disclaude-openai',
      instructions: 'You are a helpful coding assistant. Use tools to accomplish tasks.',
      model,
      tools: [...inlineTools],
    };

    if (mcpServers.length > 0) {
      agentConfig.mcpServers = mcpServers;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agent = new AgentModule.Agent(agentConfig as any);

    const prompt = adaptInput(input);

    logger.info(
      { promptLength: prompt.length, toolCount: inlineTools.length, mcpCount: mcpServers.length },
      'Starting OpenAI queryOnce'
    );

    try {
      const result = await AgentModule.run(agent, prompt, { stream: true });

      // StreamedRunResult is AsyncIterable<RunStreamEvent>
      for await (const event of result) {
        if (this.disposed) { break; }
        const message = adaptStreamEvent(event);
        if (message) {
          yield message;
        }
      }

      await result.completed;

      if (!this.disposed) {
        yield adaptRunResult(result);
      }
    } catch (error) {
      logger.error({ err: error }, 'OpenAI queryOnce failed');
      yield {
        type: 'error',
        content: `❌ OpenAI Error: ${error instanceof Error ? error.message : String(error)}`,
        role: 'assistant',
        metadata: {},
        raw: error,
      };
    }
  }

  queryStream(
    input: AsyncGenerator<UserInput>,
    options: AgentQueryOptions
  ): StreamQueryResult {
    if (this.disposed) {
      throw new Error('Provider has been disposed');
    }

    let cancelled = false;

    const handle: QueryHandle = {
      close: () => {
        this.disposed = true;
        cancelled = true;
      },
      cancel: () => {
        cancelled = true;
      },
      sessionId: undefined,
    };

    const self = this;

    async function* iterator(): AsyncGenerator<AgentMessage> {
      const AgentModule = await self.loadAgentModuleAsync();
      const config = extractOpenAIConfig(options);

      if (config.apiKey) {
        AgentModule.setDefaultOpenAIKey(config.apiKey);
      }

      const model = self.createModel(AgentModule, config);
      const inlineTools = await adaptInlineTools(options.mcpServers, AgentModule);
      const mcpServers = options.mcpServers
        ? await adaptMcpServers(options.mcpServers, AgentModule)
        : [];

      const session = new AgentModule.MemorySession();

      const agentConfig: Record<string, unknown> = {
        name: 'disclaude-openai',
        instructions: 'You are a helpful coding assistant. Use tools to accomplish tasks.',
        model,
        tools: [...inlineTools],
        session,
      };

      if (mcpServers.length > 0) {
        agentConfig.mcpServers = mcpServers;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = new AgentModule.Agent(agentConfig as any);

      logger.info(
        { toolCount: inlineTools.length, mcpCount: mcpServers.length },
        'Starting OpenAI queryStream'
      );

      let inputCount = 0;

      for await (const userInput of input) {
        if (cancelled || self.disposed) {
          logger.info('OpenAI queryStream cancelled');
          break;
        }

        inputCount++;
        const prompt = typeof userInput.content === 'string'
          ? userInput.content
          : JSON.stringify(userInput.content);

        logger.info({ inputCount, promptLength: prompt.length }, 'OpenAI queryStream input received');

        try {
          const result = await AgentModule.run(agent, prompt, { stream: true });

          for await (const event of result) {
            if (cancelled || self.disposed) { break; }
            const message = adaptStreamEvent(event);
            if (message) {
              yield message;
            }
          }

          await result.completed;

          if (!cancelled && !self.disposed) {
            yield adaptRunResult(result);
          }
        } catch (error) {
          logger.error({ err: error, inputCount }, 'OpenAI queryStream turn failed');
          yield {
            type: 'error',
            content: `❌ OpenAI Error: ${error instanceof Error ? error.message : String(error)}`,
            role: 'assistant',
            metadata: {},
            raw: error,
          };
        }
      }

      logger.info({ inputCount }, 'OpenAI queryStream completed');
    }

    return {
      handle,
      iterator: iterator(),
    };
  }

  /**
   * 创建内联工具（同步）
   *
   * OpenAI SDK tool() 接受 { name, description, parameters, execute }
   */
  createInlineTool(definition: InlineToolDefinition): unknown {
    const AgentModule = this.loadAgentModuleSync();

    return AgentModule.tool({
      name: definition.name,
      description: definition.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parameters: definition.parameters as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: definition.handler as any,
    });
  }

  /**
   * 创建 MCP 服务器（同步）
   */
  createMcpServer(config: McpServerConfig): unknown {
    const AgentModule = this.loadAgentModuleSync();

    if (config.type === 'stdio') {
      return new AgentModule.MCPServerStdio({
        name: config.name,
        command: config.command,
        args: config.args,
        env: config.env,
      });
    }

    if (config.type === 'inline') {
      throw new Error(
        'Inline MCP servers are not supported by OpenAISDKProvider.createMcpServer. ' +
        'Pass inline tools via AgentQueryOptions.mcpServers with type "inline" instead.'
      );
    }

    // TypeScript narrowing: at this point, all known types are handled
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    throw new Error(`Unsupported MCP server type: ${(config as any).type}`);
  }

  validateConfig(): boolean {
    if (!process.env.OPENAI_API_KEY) {
      return false;
    }
    try {
      nativeRequire.resolve('@openai/agents');
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.disposed = true;
    logger.debug('OpenAI provider disposed');
  }
}
