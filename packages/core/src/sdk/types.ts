/**
 * Agent SDK 抽象层 - 统一类型定义
 *
 * 这些类型与任何特定的 Agent SDK（Claude、OpenAI 等）无关，
 * 提供统一的接口供上层业务代码使用。
 */

import type { ZodSchema } from 'zod';

// ============================================================================
// 内容块类型
// ============================================================================

/** 文本内容块 */
export interface TextContentBlock {
  type: 'text';
  text: string;
}

/** 图像内容块 */
export interface ImageContentBlock {
  type: 'image';
  data: string;
  mimeType: string;
}

/** 内容块联合类型 */
export type ContentBlock = TextContentBlock | ImageContentBlock;

// ============================================================================
// 用户输入类型
// ============================================================================

/** 用户输入消息 */
export interface UserInput {
  role: 'user';
  content: string | ContentBlock[];
}

/** API 消息格式（用于流式输入） */
export interface StreamingMessageContent {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

/**
 * 流式用户消息（用于 MessageChannel 和 ChatAgent）
 *
 * 这是 SDKUserMessage 的统一抽象，与具体 SDK 无关。
 */
export interface StreamingUserMessage {
  type: 'user';
  message: StreamingMessageContent;
  parent_tool_use_id: string | null;
  session_id: string;
}

// ============================================================================
// Agent 消息类型（统一的 SDK 消息抽象）
// ============================================================================

/** 消息角色 */
export type MessageRole = 'user' | 'assistant' | 'system';

/** Agent 消息元数据 */
export interface AgentMessageMetadata {
  /** 工具名称 */
  toolName?: string;
  /** 工具输入参数 */
  toolInput?: unknown;
  /** 工具输出结果 */
  toolOutput?: unknown;
  /** 已执行时间（毫秒） */
  elapsedMs?: number;
  /** 费用（美元） */
  costUsd?: number;
  /** 输入 token 数 */
  inputTokens?: number;
  /** 输出 token 数 */
  outputTokens?: number;
  /** 消息 ID */
  messageId?: string;
  /** 停止原因 */
  stopReason?: string;
  /** 会话 ID */
  sessionId?: string;
}

/** Agent 消息类型 */
export type AgentMessageType =
  | 'text'           // 文本内容
  | 'tool_use'       // 工具调用开始
  | 'tool_progress'  // 工具执行中
  | 'tool_result'    // 工具执行完成
  | 'result'         // 查询完成
  | 'error'          // 错误
  | 'status';        // 系统状态

/** 统一的 Agent 消息类型（与特定 SDK 无关） */
export interface AgentMessage {
  /** 消息类型 */
  type: AgentMessageType;
  /** 消息内容 */
  content: string;
  /** 消息角色 */
  role: MessageRole;
  /** 消息元数据 */
  metadata?: AgentMessageMetadata;
  /** 原始消息（用于调试） */
  raw?: unknown;
}

// ============================================================================
// 工具使用信息
// ============================================================================

/** 工具使用块 */
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

/** 工具结果块 */
export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

// ============================================================================
// MCP 服务器配置
// ============================================================================

/** 内联工具定义 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface InlineToolDefinition<TParams = any, TResult = any> {
  /** 工具名称 */
  name: string;
  /** 工具描述 */
  description: string;
  /** 参数 Schema（Zod） */
  parameters: ZodSchema<TParams>;
  /** 处理函数 */
  handler: (params: TParams) => Promise<TResult>;
}

/** stdio 模式 MCP 服务器配置 */
export interface StdioMcpServerConfig {
  type: 'stdio';
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** 内联模式 MCP 服务器配置 */
export interface InlineMcpServerConfig {
  type: 'inline';
  name: string;
  version: string;
  tools?: InlineToolDefinition[];
}

/** MCP 服务器配置联合类型 */
export type McpServerConfig = StdioMcpServerConfig | InlineMcpServerConfig;

// ============================================================================
// 查询选项
// ============================================================================

/** 权限模式 */
export type PermissionMode = 'default' | 'bypassPermissions';

/**
 * System prompt 预设配置（Issue #2890）
 *
 * 使用 claude_code preset 确保 vibe coding 合规性。
 * 参考 claude-agent-acp 实现：当 preset 为 'claude_code' 时，
 * SDK 会使用与 Claude Code CLI 完全一致的 system prompt，
 * 这是被识别为 vibe coding 工具的关键。
 */
export type SystemPromptPreset = {
  type: 'preset';
  preset: 'claude_code';
  append?: string;
};

/**
 * Tools 预设配置（Issue #2890）
 *
 * 使用 claude_code preset 加载所有 Claude Code 内置工具。
 * 包括 Bash, Read, Write, Edit, Grep, Glob, Task 等。
 */
export type ToolsPreset = {
  type: 'preset';
  preset: 'claude_code';
};

/** 查询选项（Provider 无关） */
export interface AgentQueryOptions {
  /** 工作目录 */
  cwd?: string;
  /** 使用的模型 */
  model?: string;
  /** 权限模式 */
  permissionMode?: PermissionMode;
  /** 允许使用的工具列表 */
  allowedTools?: string[];
  /** 禁用的工具列表 */
  disallowedTools?: string[];
  /** MCP 服务器配置 */
  mcpServers?: Record<string, McpServerConfig>;
  /** 环境变量 */
  env?: Record<string, string | undefined>;
  /** 设置来源（必填） */
  settingSources: string[];
  /**
   * System prompt 配置（Issue #2890）
   *
   * - `string` — 使用自定义 system prompt
   * - `{ type: 'preset', preset: 'claude_code' }` — 使用 Claude Code 默认 system prompt（推荐，确保 vibe coding 合规）
   * - `{ type: 'preset', preset: 'claude_code', append: '...' }` — 在默认 prompt 后追加自定义指令
   *
   * 默认值为 `{ type: 'preset', preset: 'claude_code' }` 以确保 vibe coding 合规性。
   */
  systemPrompt?: string | SystemPromptPreset;
  /**
   * Tools 配置（Issue #2890）
   *
   * - `string[]` — 指定可用工具列表
   * - `{ type: 'preset', preset: 'claude_code' }` — 使用 Claude Code 全部默认工具
   *
   * 默认值为 `{ type: 'preset', preset: 'claude_code' }` 以确保工具集完整。
   */
  tools?: string[] | ToolsPreset;
  /**
   * stderr 输出回调（Issue #2920）
   *
   * 用于捕获 Claude Code 进程的 stderr 输出，辅助诊断启动失败原因。
   * Provider 层将其传递给 SDK 的 stderr 选项。
   */
  stderr?: (data: string) => void;
}

// ============================================================================
// 查询句柄和结果
// ============================================================================

/** 查询句柄（用于控制查询生命周期） */
export interface QueryHandle {
  /** 关闭查询 */
  close(): void;
  /** 取消查询 */
  cancel(): void;
  /** 会话 ID */
  readonly sessionId?: string;
}

/** 流式查询结果 */
export interface StreamQueryResult {
  /** 查询句柄 */
  handle: QueryHandle;
  /** 消息迭代器 */
  iterator: AsyncGenerator<AgentMessage>;
}

// ============================================================================
// 使用统计
// ============================================================================

/** 查询使用统计 */
export interface QueryUsageStats {
  /** 输入 token 数 */
  inputTokens: number;
  /** 输出 token 数 */
  outputTokens: number;
  /** 总 token 数 */
  totalTokens: number;
  /** 费用（美元） */
  costUsd: number;
  /** 缓存读取 token 数 */
  cacheReadTokens?: number;
  /** 缓存写入 token 数 */
  cacheWriteTokens?: number;
}

// ============================================================================
// Provider 信息
// ============================================================================

/** Provider 信息 */
export interface ProviderInfo {
  /** Provider 名称 */
  name: string;
  /** Provider 版本 */
  version: string;
  /** 是否可用 */
  available: boolean;
  /** 不可用原因 */
  unavailableReason?: string;
}
