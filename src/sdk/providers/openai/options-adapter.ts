/**
 * OpenAI 选项适配器
 *
 * 将统一的 AgentQueryOptions 转换为 OpenAI API 的选项格式。
 */

import type { AgentQueryOptions, UserInput } from '../../types';
import type { OpenAIMessage, OpenAIToolDefinition } from './message-adapter';
import { adaptUserInput } from './message-adapter';

/**
 * OpenAI API 选项
 */
export interface OpenAIAPIOptions {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAIToolDefinition[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

/**
 * 默认模型
 */
const DEFAULT_MODEL = 'gpt-4o';

/**
 * 模型名称映射
 */
const MODEL_MAP: Record<string, string> = {
  'gpt-4': 'gpt-4-turbo',
  'gpt-4-turbo': 'gpt-4-turbo',
  'gpt-4o': 'gpt-4o',
  'gpt-4o-mini': 'gpt-4o-mini',
  'gpt-3.5-turbo': 'gpt-3.5-turbo',
  'o1': 'o1',
  'o1-mini': 'o1-mini',
  'o1-preview': 'o1-preview',
};

/**
 * 获取 OpenAI 模型名称
 */
function getModelName(model?: string): string {
  if (!model) {
    return DEFAULT_MODEL;
  }

  // 检查是否是已知的模型映射
  const mappedModel = MODEL_MAP[model.toLowerCase()];
  if (mappedModel) {
    return mappedModel;
  }

  // 如果以 gpt- 或 o1- 开头，直接使用
  if (model.startsWith('gpt-') || model.startsWith('o1')) {
    return model;
  }

  // 默认使用 gpt-4o
  return DEFAULT_MODEL;
}

/**
 * 将统一的查询选项转换为 OpenAI API 选项
 */
export function adaptOptions(options: AgentQueryOptions): Omit<OpenAIAPIOptions, 'messages'> {
  const openaiOptions: Omit<OpenAIAPIOptions, 'messages'> = {
    model: getModelName(options.model),
    stream: true,
  };

  // 注意：OpenAI 的 Agent SDK 与 Claude 不同，工具通过 MCP 服务器定义
  // 这里我们暂不处理 allowedTools 和 disallowedTools
  // 如果需要支持工具调用，需要通过 tools 参数传递

  return openaiOptions;
}

/**
 * 将输入转换为 OpenAI 消息格式
 */
export function adaptInput(input: string | UserInput[]): OpenAIMessage[] {
  if (typeof input === 'string') {
    return [
      {
        role: 'user',
        content: input,
      },
    ];
  }

  return input.map(adaptUserInput);
}

/**
 * 将 OpenAI 选项转换为带消息的完整选项
 */
export function adaptOptionsWithMessages(
  input: string | UserInput[],
  options: AgentQueryOptions
): OpenAIAPIOptions {
  const baseOptions = adaptOptions(options);
  const messages = adaptInput(input);

  return {
    ...baseOptions,
    messages,
  };
}

/**
 * 创建系统消息
 */
export function createSystemMessage(systemPrompt: string): OpenAIMessage {
  return {
    role: 'system',
    content: systemPrompt,
  };
}
