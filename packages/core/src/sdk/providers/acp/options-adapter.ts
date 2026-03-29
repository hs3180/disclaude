/**
 * ACP 选项适配器
 *
 * 将统一的 AgentQueryOptions 转换为 ACP 协议的任务选项格式。
 *
 * @see Issue #1333 - 支持OpenAI Agent
 */

import type { AgentQueryOptions } from '../../types.js';
import type { AcpTaskOptions } from './types.js';

/**
 * 将统一的 AgentQueryOptions 转换为 ACP 任务选项
 *
 * @param options - 统一的查询选项
 * @returns ACP 任务选项
 */
export function adaptOptionsToAcp(options: AgentQueryOptions): AcpTaskOptions | undefined {
  const acpOptions: AcpTaskOptions = {};

  if (options.cwd) {
    acpOptions.cwd = options.cwd;
  }

  if (options.model) {
    acpOptions.model = options.model;
  }

  // 工具配置
  if (options.allowedTools) {
    acpOptions.allowedTools = options.allowedTools;
  }

  if (options.disallowedTools) {
    acpOptions.disallowedTools = options.disallowedTools;
  }

  // MCP 服务器配置
  if (options.mcpServers) {
    acpOptions.mcpServers = adaptMcpServers(options.mcpServers);
  }

  // 环境变量
  if (options.env) {
    acpOptions.env = options.env;
  }

  // 如果没有任何选项，返回 undefined
  if (Object.keys(acpOptions).length === 0) {
    return undefined;
  }

  return acpOptions;
}

/**
 * 适配 MCP 服务器配置为 ACP 格式
 */
function adaptMcpServers(
  mcpServers: Record<string, import('../../types.js').McpServerConfig>
): Record<string, import('./types.js').AcpMcpServerConfig> {
  const result: Record<string, import('./types.js').AcpMcpServerConfig> = {};

  for (const [name, config] of Object.entries(mcpServers)) {
    if (config.type === 'stdio') {
      result[name] = {
        type: 'stdio',
        command: config.command,
        args: config.args,
        env: config.env,
      };
    } else if (config.type === 'inline') {
      // inline MCP 服务器：通过工具定义传递
      result[name] = {
        type: 'stdio',
        // inline 模式在 ACP 中暂不支持，降级为 stdio 占位
        // 实际的 inline 工具通过 AcpTaskOptions.tools 传递
        command: 'echo',
        args: ['inline-mcp-not-supported'],
      };
    }
  }

  return result;
}
