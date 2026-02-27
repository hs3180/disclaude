/**
 * GLM SDK Provider 实现（智谱 AI）
 *
 * 实现 IAgentSDKProvider 接口，封装智谱 AI GLM 模型的功能。
 * 使用 OpenAI 兼容的 API 格式。
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
} from '../openai/message-adapter.js';

/**
 * GLM API 基础 URL
 */
const GLM_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';

/**
 * 默认 GLM 模型
 */
const DEFAULT_GLM_MODEL = 'glm-4';

/**
 * GLM SDK Provider
 *
 * 封装智谱 AI GLM 模型的功能，提供与 IAgentSDKProvider 接口一致的 API。
 * 使用 OpenAI 兼容的 API 格式。
 */
export class GLMSDKProvider implements IAgentSDKProvider {
  readonly name = 'glm';
  readonly version = '1.0.0';

  private client: OpenAI | null = null;
  private disposed = false;

  /**
   * 获取或创建 GLM 客户端
   */
  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI({
        apiKey: process.env.GLM_API_KEY,
        baseURL: GLM_BASE_URL,
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
      unavailableReason: available ? undefined : 'GLM_API_KEY not set',
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
    // 使用 GLM 模型名称
    const glmOptions = {
      ...options,
      model: this.getGLMModel(options.model),
    };
    const openaiOptions = adaptOptionsWithMessages(input, glmOptions);

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

    // 创建消息迭代器
    async function* createIterator(
      provider: GLMSDKProvider
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

      // 获取 GLM 模型名称
      const model = provider.getGLMModel(options.model);

      // 调用 GLM API
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
    // GLM 不支持 MCP 服务器的概念
    throw new Error(
      'MCP servers are not supported by GLMSDKProvider. Use createInlineTool instead.'
    );
  }

  validateConfig(): boolean {
    return !!process.env.GLM_API_KEY;
  }

  dispose(): void {
    this.disposed = true;
    this.client = null;
  }

  /**
   * 获取 GLM 模型名称
   */
  private getGLMModel(model?: string): string {
    if (!model) {
      return DEFAULT_GLM_MODEL;
    }

    // GLM 模型名称映射
    const modelMap: Record<string, string> = {
      'glm-4': 'glm-4',
      'glm-4-plus': 'glm-4-plus',
      'glm-4-air': 'glm-4-air',
      'glm-4-flash': 'glm-4-flash',
      'glm-4v': 'glm-4v',
      'glm-3-turbo': 'glm-3-turbo',
    };

    return modelMap[model.toLowerCase()] || DEFAULT_GLM_MODEL;
  }

  /**
   * 将 Zod schema 转换为 JSON Schema
   */
  private zodToJsonSchema(schema: unknown): Record<string, unknown> {
    try {
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
      // 忽略错误
    }
    return {};
  }
}
