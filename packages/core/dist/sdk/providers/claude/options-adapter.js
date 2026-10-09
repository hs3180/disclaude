import { assertToolOptions } from '../../tools.js';
import { browserAgentEnv } from '../../../utils/browser-env.js';
import { createClaudeToolServer, claudeToolNames, CLAUDE_HOST_SERVER } from './tool-adapter.js';
import * as path from 'node:path';
import { Config } from '../../../config/index.js';
/**
 * 适配统一选项为 Claude SDK 选项
 *
 * @param options - 统一的查询选项
 * @returns Claude SDK 选项对象
 */
export function adaptOptions(options, permissions = {}) {
    assertToolOptions(options);
    const sdkOptions = {};
    // Claude launches its own subprocess; this is its final environment boundary.
    sdkOptions.env = browserAgentEnv(options.env);
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
    // System prompt 配置 (Issue #2890)
    if (options.systemPrompt) {
        sdkOptions.systemPrompt = options.systemPrompt;
    }
    // Issue #4224: load builtin skills + agents in place as a local plugin,
    // replacing the copy-on-start materialization. The plugin loads at
    // subprocess init (before any query()), so the first-message race is gone.
    // Path MUST be absolute (relative resolves against SDK cwd = workspace).
    sdkOptions.plugins = [{ type: 'local', path: path.resolve(Config.getBuiltinsDir()) }];
    if (options.includePartialMessages !== undefined) {
        sdkOptions.includePartialMessages = options.includePartialMessages;
    }
    // 设置来源（必填）
    sdkOptions.settingSources = options.settingSources;
    // Claude's built-in tool defaults are a Harness detail.
    sdkOptions.tools = { type: 'preset', preset: 'claude_code' };
    if (permissions.allowedTools) {
        sdkOptions.allowedTools = claudeToolNames(permissions.allowedTools, options.tools);
    }
    if (permissions.disallowedTools) {
        sdkOptions.disallowedTools = claudeToolNames(permissions.disallowedTools, options.tools);
    }
    if (options.tools?.length) {
        sdkOptions.mcpServers = {
            [CLAUDE_HOST_SERVER]: createClaudeToolServer(options.tools, permissions),
        };
    }
    // 环境变量
    if (options.env) {
        // CRITICAL: Extract API key and base URL from env and pass as direct options
        // The SDK requires these as direct options, not just env vars
        if (options.env.ANTHROPIC_API_KEY) {
            sdkOptions.apiKey = options.env.ANTHROPIC_API_KEY;
        }
        if (options.env.ANTHROPIC_BASE_URL) {
            sdkOptions.apiBaseUrl = options.env.ANTHROPIC_BASE_URL;
        }
    }
    // stderr 回调（Issue #2920: 捕获 Claude Code 进程的 stderr 输出）
    if (options.stderr) {
        sdkOptions.stderr = options.stderr;
    }
    // Agent Teams mode (SDK 0.3.177+): pass teammateMode via SDK settings
    if (options.teammateMode) {
        sdkOptions.settings = { ...sdkOptions.settings, teammateMode: options.teammateMode };
    }
    if (typeof options.autoCompactWindow === 'number') {
        sdkOptions.settings = {
            ...sdkOptions.settings,
            autoCompactEnabled: options.autoCompactWindow > 0,
            ...(options.autoCompactWindow > 0 ? { autoCompactWindow: options.autoCompactWindow } : {}),
        };
    }
    return sdkOptions;
}
/**
 * 适配输入为 Claude SDK 格式
 *
 * @param input - 统一输入（字符串或 UserInput 数组）
 * @returns Claude SDK 格式的输入
 */
export function adaptInput(input) {
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
