/**
 * OpenAI 消息适配器
 *
 * 将 OpenAI API 的消息格式适配到统一的 AgentMessage 格式。
 */

import type {
  AgentMessage,
  AgentMessageMetadata,
  ContentBlock,
  UserInput,
} from '../../types';

/**
 * OpenAI 消息内容块
 */
interface OpenAIContentBlock {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

/**
 * OpenAI 消息格式
 */
interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | OpenAIContentBlock[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

/**
 * OpenAI 工具调用
 */
interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * OpenAI 流式响应块
 */
interface OpenAIStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * 将统一的 UserInput 转换为 OpenAI 消息格式
 */
export function adaptUserInput(userInput: UserInput): OpenAIMessage {
  if (typeof userInput.content === 'string') {
    return {
      role: 'user',
      content: userInput.content,
    };
  }

  // 处理多模态内容
  const content: OpenAIContentBlock[] = userInput.content.map((block) => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text };
    }
    if (block.type === 'image') {
      return {
        type: 'image_url',
        image_url: {
          url: `data:${block.mimeType};base64,${block.data}`,
        },
      };
    }
    return { type: 'text', text: '' };
  });

  return {
    role: 'user',
    content,
  };
}

/**
 * 将 OpenAI 流式块转换为统一的 AgentMessage
 */
export function adaptStreamChunk(
  chunk: OpenAIStreamChunk,
  toolCallAccumulator: Map<number, { id: string; name: string; args: string }>
): AgentMessage[] {
  const messages: AgentMessage[] = [];

  for (const choice of chunk.choices) {
    const delta = choice.delta;

    // 处理文本内容
    if (delta.content) {
      messages.push({
        type: 'text',
        content: delta.content,
        role: 'assistant',
      });
    }

    // 处理工具调用
    if (delta.tool_calls) {
      for (const toolCall of delta.tool_calls) {
        const index = toolCall.index;

        if (toolCall.id) {
          // 新的工具调用开始
          toolCallAccumulator.set(index, {
            id: toolCall.id,
            name: toolCall.function?.name || '',
            args: toolCall.function?.arguments || '',
          });
        } else if (toolCall.function?.arguments) {
          // 继续累积参数
          const existing = toolCallAccumulator.get(index);
          if (existing) {
            existing.args += toolCall.function.arguments;
          }
        }
      }
    }

    // 处理完成
    if (choice.finish_reason === 'stop') {
      messages.push({
        type: 'result',
        content: '',
        role: 'assistant',
        metadata: {
          stopReason: 'stop',
        },
      });
    } else if (choice.finish_reason === 'tool_calls') {
      // 工具调用完成，发出 tool_use 消息
      for (const [, toolCall] of toolCallAccumulator) {
        let parsedArgs: unknown;
        try {
          parsedArgs = JSON.parse(toolCall.args);
        } catch {
          parsedArgs = toolCall.args;
        }

        messages.push({
          type: 'tool_use',
          content: '',
          role: 'assistant',
          metadata: {
            toolName: toolCall.name,
            toolInput: parsedArgs,
          },
        });
      }
      toolCallAccumulator.clear();
    }
  }

  // 处理 usage 信息
  if (chunk.usage) {
    // 发送使用统计作为 status 消息
    messages.push({
      type: 'status',
      content: '',
      role: 'assistant',
      metadata: {
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
      },
    });
  }

  return messages;
}

/**
 * 将 OpenAI 非流式响应转换为统一的 AgentMessage 数组
 */
export function adaptResponse(response: {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}): AgentMessage[] {
  const messages: AgentMessage[] = [];

  for (const choice of response.choices) {
    const msg = choice.message;

    // 文本内容
    if (msg.content) {
      messages.push({
        type: 'text',
        content: msg.content,
        role: 'assistant',
      });
    }

    // 工具调用
    if (msg.tool_calls) {
      for (const toolCall of msg.tool_calls) {
        let parsedArgs: unknown;
        try {
          parsedArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          parsedArgs = toolCall.function.arguments;
        }

        messages.push({
          type: 'tool_use',
          content: '',
          role: 'assistant',
          metadata: {
            toolName: toolCall.function.name,
            toolInput: parsedArgs,
          },
        });
      }
    }

    // 完成原因
    if (choice.finish_reason) {
      messages.push({
        type: 'result',
        content: '',
        role: 'assistant',
        metadata: {
          stopReason: choice.finish_reason,
        },
      });
    }
  }

  // 使用统计
  if (response.usage) {
    messages.push({
      type: 'status',
      content: '',
      role: 'assistant',
      metadata: {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
      },
    });
  }

  return messages;
}

/**
 * 创建工具结果消息
 */
export function createToolResultMessage(
  toolCallId: string,
  result: string,
  isError = false
): OpenAIMessage {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content: result,
    name: isError ? 'error' : undefined,
  };
}

/**
 * OpenAI 工具定义格式
 */
export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type { OpenAIMessage, OpenAIToolCall, OpenAIStreamChunk };
