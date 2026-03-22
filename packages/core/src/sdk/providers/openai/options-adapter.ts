/**
 * OpenAI Agents SDK 选项适配器
 *
 * 将统一的 AgentQueryOptions 转换为 OpenAI Agents SDK 特定的选项格式。
 *
 * 注意：此模块不直接依赖 @openai/agents，保持为纯转换层。
 * MCP 服务器和工具的 SDK 实例化在 provider.ts 中处理。
 */

import type { AgentQueryOptions, UserInput } from '../../types.js';

// ============================================================================
// 适配后的选项类型
// ============================================================================

/** 适配后的 OpenAI 选项 */
export interface OpenAIAdaptedOptions {
  /** 模型名称 */
  model?: string;
  /** API 密钥 */
  apiKey?: string;
  /** API 基础 URL */
  apiBaseUrl?: string;
  /** 工作目录 */
  cwd?: string;
}

// ============================================================================
// 选项适配
// ============================================================================

/**
 * 适配统一选项为 OpenAI SDK 选项
 *
 * @param options - 统一的查询选项
 * @returns 适配后的 OpenAI 选项
 */
export function adaptOptions(options: AgentQueryOptions): OpenAIAdaptedOptions {
  const result: OpenAIAdaptedOptions = {};

  // 模型
  if (options.model) {
    result.model = options.model;
  }

  // 工作目录（传递给 MCP 服务器环境变量）
  if (options.cwd) {
    result.cwd = options.cwd;
  }

  // 环境变量
  if (options.env) {
    if (options.env.OPENAI_API_KEY) {
      result.apiKey = options.env.OPENAI_API_KEY;
    }
    if (options.env.OPENAI_BASE_URL) {
      result.apiBaseUrl = options.env.OPENAI_BASE_URL;
    }
  }

  // 以下选项 OpenAI SDK 不直接支持，被忽略：
  // - settingSources
  // - permissionMode
  // - allowedTools / disallowedTools

  return result;
}

// ============================================================================
// 输入适配
// ============================================================================

/**
 * 适配输入为 OpenAI Message 格式
 *
 * @param input - 统一输入（字符串或 UserInput 数组）
 * @returns OpenAI 格式的输入（字符串或 Message 数组）
 */
export function adaptInput(input: string | UserInput[]): string | unknown[] {
  if (typeof input === 'string') {
    return input;
  }

  // 转换 UserInput 数组为 OpenAI Message 格式
  return input.map(userInput => ({
    role: 'user',
    content: userInput.content,
  }));
}
