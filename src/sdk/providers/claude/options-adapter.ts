/**
 * Claude SDK 选项适配器
 *
 * 将统一的 AgentQueryOptions 转换为 Claude SDK 特定的选项格式。
 */

import type { AgentQueryOptions, InlineMcpServerConfig, McpServerConfig } from '../../types.js';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

/**
 * 适配统一选项为 Claude SDK 选项
 *
 * @param options - 统一的查询选项
 * @returns Claude SDK 选项对象
 */
export function adaptOptions(options: AgentQueryOptions): Record<string, unknown> {
  const sdkOptions: Record<string, unknown> = {};

  // 基本选项
  if (options.cwd) {
    sdkOptions.cwd = options.cwd;
  }

  if (options.model) {
    sdkOptions.model = options.model;
  }

  // 权限模式（直接传递，无需转换）
  if (options.permissionMode) {
    sdkOptions.permissionMode = options.permissionMode;
  }

  // 设置来源
  if (options.settingSources) {
    sdkOptions.settingSources = options.settingSources;
  }

  // 工具配置
  if (options.allowedTools) {
    sdkOptions.allowedTools = options.allowedTools;
  }

  if (options.disallowedTools) {
    sdkOptions.disallowedTools = options.disallowedTools;
  }

  // MCP 服务器
  if (options.mcpServers) {
    sdkOptions.mcpServers = adaptMcpServers(options.mcpServers);
  }

  // 环境变量
  if (options.env) {
    sdkOptions.env = options.env;
  }

  return sdkOptions;
}

/**
 * 适配 MCP 服务器配置
 *
 * @param mcpServers - 统一的 MCP 服务器配置
 * @returns Claude SDK MCP 服务器配置
 */
function adaptMcpServers(
  mcpServers: Record<string, McpServerConfig>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [name, config] of Object.entries(mcpServers)) {
    if (config.type === 'inline') {
      result[name] = adaptInlineMcpServer(config);
    } else {
      // stdio 模式直接传递
      result[name] = {
        command: config.command,
        args: config.args,
        env: config.env,
      };
    }
  }

  return result;
}

/**
 * 适配内联 MCP 服务器
 *
 * @param config - 内联 MCP 服务器配置
 * @returns Claude SDK MCP 服务器实例
 */
function adaptInlineMcpServer(config: InlineMcpServerConfig): unknown {
  if (!config.tools || config.tools.length === 0) {
    return createSdkMcpServer({
      name: config.name,
      version: config.version,
      tools: [],
    });
  }

  // 将统一工具定义转换为 SDK 工具
  // 使用双重类型断言来处理 Zod schema 类型兼容性
  const sdkTools = config.tools.map(t =>
    tool(t.name, t.description, t.parameters as unknown as Parameters<typeof tool>[2], t.handler)
  );

  return createSdkMcpServer({
    name: config.name,
    version: config.version,
    tools: sdkTools,
  });
}

/**
 * 适配输入为 Claude SDK 格式
 *
 * @param input - 统一输入（字符串或 UserInput 数组）
 * @returns Claude SDK 格式的输入
 */
export function adaptInput(input: string | import('../../types.js').UserInput[]): unknown {
  if (typeof input === 'string') {
    return input;
  }

  // 转换 UserInput 数组为 SDK 格式
  return input.map(userInput => ({
    type: 'user',
    message: {
      role: 'user',
      content: userInput.content,
    },
    parent_tool_use_id: null,
    session_id: '',
  }));
}
