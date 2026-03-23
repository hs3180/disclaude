/**
 * OpenAI SDK 选项适配器
 *
 * 将统一的 AgentQueryOptions 转换为 OpenAI Agents SDK 特定的选项格式。
 */

import type { AgentQueryOptions, UserInput } from '../../types.js';

/**
 * OpenAI SDK 运行选项
 */
export interface OpenAIRunOptions {
  model?: string;
  maxTurns?: number;
}

/**
 * 适配统一选项为 OpenAI SDK 选项
 *
 * @param options - 统一的查询选项
 * @returns OpenAI SDK 运行选项
 */
export function adaptOptions(options: AgentQueryOptions): OpenAIRunOptions {
  const sdkOptions: OpenAIRunOptions = {};

  if (options.model) {
    sdkOptions.model = options.model;
  }

  // 权限模式映射：bypassPermissions → 更多轮次（允许更多工具调用）
  if (options.permissionMode === 'bypassPermissions') {
    sdkOptions.maxTurns = 100;
  }

  return sdkOptions;
}

/**
 * 适配输入为 OpenAI SDK 格式
 *
 * OpenAI Agents SDK 接受字符串或消息数组作为输入。
 *
 * @param input - 统一输入（字符串或 UserInput 数组）
 * @returns OpenAI SDK 格式的输入（字符串）
 */
export function adaptInput(input: string | UserInput[]): string {
  if (typeof input === 'string') {
    return input;
  }

  // 将 UserInput 数组拼接为单个字符串
  return input
    .map(u => typeof u.content === 'string' ? u.content : JSON.stringify(u.content))
    .join('\n');
}
