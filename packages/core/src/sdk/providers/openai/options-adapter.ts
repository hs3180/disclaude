/**
 * OpenAI Agents SDK 选项适配器
 *
 * 将统一的 AgentQueryOptions 转换为 OpenAI Agents SDK 的 Agent 配置。
 */

import type {
  AgentQueryOptions,
  McpServerConfig,
  UserInput,
} from '../../types.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('OpenAIOptionsAdapter');

/**
 * 适配统一输入为 OpenAI SDK 的 prompt 格式
 */
export function adaptInput(input: string | UserInput[]): string {
  if (typeof input === 'string') {
    return input;
  }
  return input
    .map(msg => {
      const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
      return content;
    })
    .join('\n');
}

/**
 * 从 AgentQueryOptions 中提取 OpenAI 相关配置
 */
export function extractOpenAIConfig(options: AgentQueryOptions): {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
} {
  const env = options.env || {};
  return {
    apiKey: env.OPENAI_API_KEY as string | undefined,
    baseUrl: env.OPENAI_BASE_URL as string | undefined,
    model: options.model,
  };
}

/**
 * 适配 MCP 服务器配置为 OpenAI SDK 的 MCPServer 实例数组
 */
export async function adaptMcpServers(
  mcpServers: Record<string, McpServerConfig>,
  AgentModule: typeof import('@openai/agents')
): Promise<unknown[]> {
  const servers: unknown[] = [];
  for (const [name, config] of Object.entries(mcpServers)) {
    try {
      if (config.type === 'stdio') {
        const server = new AgentModule.MCPServerStdio({
          name,
          command: config.command,
          args: config.args,
          env: config.env,
        });
        servers.push(server);
      } else if (config.type === 'inline') {
        logger.debug({ name }, 'Inline MCP server will be converted to tools');
      }
    } catch (error) {
      logger.error({ name, error }, 'Failed to create MCP server');
    }
  }
  return servers;
}

/**
 * 创建内联工具列表
 *
 * OpenAI SDK 的 tool() 接受单个 ToolOptions 对象:
 * { name, description, parameters, execute }
 */
export async function adaptInlineTools(
  mcpServers: Record<string, McpServerConfig> | undefined,
  AgentModule: typeof import('@openai/agents')
): Promise<unknown[]> {
  if (!mcpServers) {
    return [];
  }

  const tools: unknown[] = [];

  for (const [, config] of Object.entries(mcpServers)) {
    if (config.type === 'inline' && config.tools) {
      for (const toolDef of config.tools) {
        try {
          const openaiTool = AgentModule.tool({
            name: toolDef.name,
            description: toolDef.description,
            parameters: toolDef.parameters as any, // eslint-disable-line @typescript-eslint/no-explicit-any
            execute: toolDef.handler as any, // eslint-disable-line @typescript-eslint/no-explicit-any
          });
          tools.push(openaiTool);
        } catch (error) {
          logger.error({ toolName: toolDef.name, error }, 'Failed to create tool');
        }
      }
    }
  }

  return tools;
}
