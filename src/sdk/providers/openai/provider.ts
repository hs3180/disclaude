/**
 * OpenAI SDK Provider 实现
 *
 * 实现 IAgentSDKProvider 接口，封装 OpenAI API 的功能。
 */

import OpenAI from 'openai';
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
import {
  adaptStreamChunk,
  adaptOptionsWithMessages,
  type OpenAIToolDefinition,
} from './message-adapter.js';

/**
 * OpenAI SDK Provider
 *
 * 封装 OpenAI API 的功能，提供与 IAgentSDKProvider 接口一致的 API。
 */
export class OpenAISDKProvider implements IAgentSDKProvider {
  readonly name = 'openai';
  readonly version = '1.0.0';

  private client: OpenAI | null = null;
  private disposed = false;

  /**
   * 获取或创建 OpenAI 客户端
   */
  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    }
    return this.client;
  }

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

    const client = this.getClient();
    const openaiOptions = adaptOptionsWithMessages(input, options);

    // 使用流式 API
    const stream = await client.chat.completions.create({
      model: openaiOptions.model,
      messages: openaiOptions.messages,
      stream: true,
    });

    // 工具调用累积器
    const toolCallAccumulator = new Map<
      number,
      { id: string; name: string; args: string }
    >();

    for await (const chunk of stream) {
      const messages = adaptStreamChunk(chunk, toolCallAccumulator);
      for (const message of messages) {
        yield message;
      }
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
    let streamIterator: AsyncIterator<AgentMessage> | null = null;

    // 创建消息迭代器
    async function* createIterator(
      provider: OpenAISDKProvider
    ): AsyncGenerator<AgentMessage> {
      const client = provider.getClient();
      const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];

      // 收集初始消息
      const initialMessages: UserInput[] = [];
      for await (const userInput of input) {
        if (cancelled) return;
        initialMessages.push(userInput);
      }

      // 转换消息格式
      for (const msg of initialMessages) {
        if (typeof msg.content === 'string') {
          messages.push({ role: 'user', content: msg.content });
        } else {
          // 对于多模态内容，提取文本
          const textContent = msg.content
            .filter((b) => b.type === 'text')
            .map((b) => (b as { type: 'text'; text: string }).text)
            .join('\n');
          if (textContent) {
            messages.push({ role: 'user', content: textContent });
          }
        }
      }

      if (cancelled || messages.length === 0) return;

      // 获取模型名称
      const model = options.model || 'gpt-4o';

      // 调用 OpenAI API
      const stream = await client.chat.completions.create({
        model,
        messages,
        stream: true,
      });

      // 工具调用累积器
      const toolCallAccumulator = new Map<
        number,
        { id: string; name: string; args: string }
      >();

      for await (const chunk of stream) {
        if (cancelled) return;
        const msgs = adaptStreamChunk(chunk, toolCallAccumulator);
        for (const message of msgs) {
          yield message;
        }
      }
    }

    const iterator = createIterator(this);
    streamIterator = iterator;

    return {
      handle: {
        close: () => {
          cancelled = true;
        },
        cancel: () => {
          cancelled = true;
        },
        sessionId: undefined,
      },
      iterator,
    };
  }

  createInlineTool(definition: InlineToolDefinition): OpenAIToolDefinition {
    // 将 Zod schema 转换为 JSON Schema
    const parameters = definition.parameters
      ? this.zodToJsonSchema(definition.parameters)
      : {};

    return {
      type: 'function',
      function: {
        name: definition.name,
        description: definition.description,
        parameters,
      },
    };
  }

  createMcpServer(_config: McpServerConfig): unknown {
    // OpenAI 不支持 MCP 服务器的概念
    // 工具需要通过 tools 参数直接传递
    throw new Error(
      'MCP servers are not supported by OpenAISDKProvider. Use createInlineTool instead.'
    );
  }

  validateConfig(): boolean {
    return !!process.env.OPENAI_API_KEY;
  }

  dispose(): void {
    this.disposed = true;
    this.client = null;
  }

  /**
   * 将 Zod schema 转换为 JSON Schema
   */
  private zodToJsonSchema(schema: unknown): Record<string, unknown> {
    // 简单实现：尝试调用 schema 的 parse 方法来推断类型
    // 实际实现中应该使用 zod-to-json-schema 库
    try {
      // 检查是否有 _def 属性（Zod schema 的特征）
      if (schema && typeof schema === 'object' && '_def' in schema) {
        const def = (schema as { _def: { typeName?: string } })._def;
        switch (def.typeName) {
          case 'ZodString':
            return { type: 'string' };
          case 'ZodNumber':
            return { type: 'number' };
          case 'ZodBoolean':
            return { type: 'boolean' };
          case 'ZodArray':
            return { type: 'array', items: {} };
          case 'ZodObject':
            return { type: 'object', properties: {} };
          default:
            return { type: 'object' };
        }
      }
    } catch {
      // 忽略错误，返回空对象
    }
    return {};
  }
}
