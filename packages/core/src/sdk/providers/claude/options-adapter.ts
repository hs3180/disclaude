/**
 * Claude SDK 选项适配器
 *
 * 将统一的 AgentQueryOptions 转换为 Claude SDK 特定的选项格式。
 */

import type { AgentQueryOptions, InlineMcpServerConfig, McpServerConfig, UserInput } from '../../types.js';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { isNonAnthropicEndpoint, createNonAnthropicToolServer } from './non-anthropic-tools.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('OptionsAdapter');

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

  // 权限模式 - 直接传递，使用原始 SDK 格式
  if (options.permissionMode) {
    sdkOptions.permissionMode = options.permissionMode;
  }

  // 设置来源（必填）
  sdkOptions.settingSources = options.settingSources;

  // 工具配置
  if (options.allowedTools) {
    sdkOptions.allowedTools = options.allowedTools;
  }

  if (options.disallowedTools) {
    sdkOptions.disallowedTools = options.disallowedTools;
  }

  // MCP 服务器
  const existingMcpServers = options.mcpServers
    ? adaptMcpServers(options.mcpServers)
    : {};

  // 环境变量
  if (options.env) {
    sdkOptions.env = options.env;

    // CRITICAL: Extract API key and base URL from env and pass as direct options
    // The SDK requires these as direct options, not just env vars
    if (options.env.ANTHROPIC_API_KEY) {
      sdkOptions.apiKey = options.env.ANTHROPIC_API_KEY;
    }
    if (options.env.ANTHROPIC_BASE_URL) {
      sdkOptions.apiBaseUrl = options.env.ANTHROPIC_BASE_URL;
    }
  }

  // Issue #2948: Non-Anthropic endpoint compatibility
  // When using a non-Anthropic API endpoint (e.g., GLM/ZhiPu), the Claude Agent SDK's
  // built-in tools are embedded in the system prompt (XML format), but non-Anthropic
  // providers only recognize the `tools` API parameter. MCP tools are sent via the
  // `tools` API parameter, so we disable built-in tools and register equivalent
  // MCP inline tools instead.
  const baseUrl = sdkOptions.apiBaseUrl as string | undefined;
  if (baseUrl && isNonAnthropicEndpoint(baseUrl)) {
    logger.info(
      { baseUrl },
      'Non-Anthropic endpoint detected — enabling system tools via MCP for compatibility'
    );

    // Disable built-in tools (which embed in system prompt and won't work)
    sdkOptions.tools = [];

    // Add system tools as MCP inline tools (which go through tools API parameter)
    const cwd = (options.cwd || process.cwd()) as string;
    const systemToolServer = createNonAnthropicToolServer(cwd);
    existingMcpServers['system-tools-compat'] = systemToolServer;
  }

  if (Object.keys(existingMcpServers).length > 0) {
    sdkOptions.mcpServers = existingMcpServers;
  }

  return sdkOptions;
}

/**
 * 检查值是否为 SDK 的 inline MCP 服务器包装对象
 *
 * SDK 的 createSdkMcpServer 返回 { type: 'sdk', name, instance } 格式，
 * 而不是原始的 SDK 实例。我们需要检测这种格式并直接传递。
 *
 * @param value - 要检查的值
 * @returns true 如果是 SDK inline MCP 服务器包装对象
 */
function isSdkInlineMcpServer(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value as Record<string, unknown>).type === 'sdk' &&
    'instance' in value
  );
}

/**
 * 适配 MCP 服务器配置
 *
 * 支持三种格式：
 * 1. SDK inline MCP 服务器包装对象（直接传递）
 * 2. inline 配置对象（转换为 SDK 实例）
 * 3. stdio 配置对象（直接传递配置）
 *
 * @param mcpServers - 统一的 MCP 服务器配置
 * @returns Claude SDK MCP 服务器配置
 */
function adaptMcpServers(
  mcpServers: Record<string, McpServerConfig>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [name, config] of Object.entries(mcpServers)) {
    // 检查是否为 SDK 的 inline MCP 服务器包装对象（已通过 createSdkMcpServer 创建）
    if (isSdkInlineMcpServer(config)) {
      // 直接传递 SDK 包装对象
      result[name] = config;
    } else if (config.type === 'inline') {
      // inline 配置：转换为 SDK 实例
      result[name] = adaptInlineMcpServer(config);
    } else {
      // stdio 模式：传递完整配置，包括 type 字段
      result[name] = {
        type: 'stdio',
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
export function adaptInput(input: string | UserInput[]): unknown {
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
