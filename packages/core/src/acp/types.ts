/**
 * ACP (Agent Communication Protocol) - 统一类型定义
 *
 * 这些类型基于 ACP 协议规范 (https://agentclientprotocol.com/)，
 * 提供与 disclaude 内部类型之间的桥接层。
 *
 * @module acp/types
 */

// ============================================================================
// 会话类型
// ============================================================================

/** 会话状态 */
export type AcpSessionState = 'idle' | 'running' | 'cancelled' | 'completed' | 'error';

/** 会话信息 */
export interface AcpSessionInfo {
  /** 唯一会话 ID */
  sessionId: string;
  /** 工作目录 */
  cwd?: string;
  /** 会话标题 */
  title?: string;
  /** 创建时间 (ISO 8601) */
  createdAt: string;
  /** 最后更新时间 (ISO 8601) */
  updatedAt: string;
  /** 当前状态 */
  state: AcpSessionState;
  /** 当前模式 (如 'code', 'ask', 'architect') */
  mode?: string;
}

/** 会话创建参数 */
export interface AcpSessionOptions {
  /** 工作目录 */
  cwd?: string;
  /** 初始模式 */
  mode?: string;
  /** MCP 服务器配置 */
  mcpServers?: Record<string, unknown>;
  /** 模型选择 */
  model?: string;
  /** 权限模式 */
  permissionMode?: 'default' | 'bypassPermissions';
  /** 环境变量 */
  env?: Record<string, string | undefined>;
  /** 设置来源 */
  settingSources?: string[];
}

/** 会话列表查询参数 */
export interface AcpListSessionsOptions {
  /** 按工作目录过滤 */
  cwd?: string;
  /** 分页游标 */
  cursor?: string;
  /** 每页数量限制 */
  limit?: number;
}

/** 会话列表结果 */
export interface AcpListSessionsResult {
  /** 会话列表 */
  sessions: AcpSessionInfo[];
  /** 下一页游标 */
  nextCursor?: string;
}

// ============================================================================
// Prompt 类型
// ============================================================================

/** 停止原因 */
export type AcpStopReason = 'end_turn' | 'tool_use' | 'cancelled' | 'error' | 'max_tokens';

/** Prompt 请求 */
export interface AcpPromptOptions {
  /** 用户消息内容 */
  content: string;
  /** 附件（文件、图片等） */
  attachments?: AcpAttachment[];
  /** 流式回调：接收 session update 通知 */
  onSessionUpdate?: (update: AcpSessionUpdate) => void;
  /** 中止信号 */
  signal?: AbortSignal;
}

/** 附件 */
export interface AcpAttachment {
  /** 附件类型 */
  type: 'file' | 'image';
  /** URI 或路径 */
  uri: string;
  /** MIME 类型 */
  mimeType?: string;
}

/** Prompt 结果 */
export interface AcpPromptResult {
  /** 停止原因 */
  stopReason: AcpStopReason;
  /** 会话 ID */
  sessionId: string;
  /** 累计使用统计 */
  usage?: AcpUsageStats;
  /** 错误信息（如果 stopReason 为 'error'） */
  error?: string;
}

// ============================================================================
// Session Update 类型 (对应 ACP session/update notification)
// ============================================================================

/** Session Update 通知类型 */
export type AcpSessionUpdateType =
  | 'content'           // 语言模型生成的内容块
  | 'tool_call'         // 工具调用开始
  | 'tool_output'       // 工具调用输出
  | 'exec_plan'         // 执行计划
  | 'mode_update'       // 模式变更
  | 'completed';        // prompt turn 完成

/** Session Update 通知 */
export interface AcpSessionUpdate {
  /** 会话 ID */
  sessionId: string;
  /** 更新类型 */
  type: AcpSessionUpdateType;
  /** 内容数据 */
  data: AcpSessionUpdateData;
}

/** Session Update 数据联合类型 */
export type AcpSessionUpdateData =
  | AcpContentData
  | AcpToolCallData
  | AcpToolOutputData
  | AcpExecPlanData
  | AcpModeUpdateData
  | AcpCompletedData;

/** 内容块数据 */
export interface AcpContentData {
  type: 'content';
  /** 内容类型 */
  contentType: 'text' | 'image' | 'diff' | 'terminal';
  /** 内容 */
  content: string;
  /** MIME 类型（图片） */
  mimeType?: string;
}

/** 工具调用数据 */
export interface AcpToolCallData {
  type: 'tool_call';
  /** 工具调用 ID */
  toolCallId: string;
  /** 工具名称 */
  toolName: string;
  /** 工具输入参数 */
  input?: Record<string, unknown>;
}

/** 工具输出数据 */
export interface AcpToolOutputData {
  type: 'tool_output';
  /** 关联的工具调用 ID */
  toolCallId: string;
  /** 输出内容 */
  content: string;
  /** 是否错误 */
  isError?: boolean;
}

/** 执行计划数据 */
export interface AcpExecPlanData {
  type: 'exec_plan';
  /** 计划步骤 */
  steps: AcpExecPlanStep[];
}

/** 执行计划步骤 */
export interface AcpExecPlanStep {
  /** 步骤描述 */
  description: string;
  /** 工具名称 */
  toolName?: string;
}

/** 模式更新数据 */
export interface AcpModeUpdateData {
  type: 'mode_update';
  /** 新模式 */
  mode: string;
}

/** 完成数据 */
export interface AcpCompletedData {
  type: 'completed';
  /** 停止原因 */
  stopReason: AcpStopReason;
}

// ============================================================================
// 使用统计
// ============================================================================

/** ACP 使用统计 */
export interface AcpUsageStats {
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

/** ACP Provider 能力声明 */
export interface AcpCapabilities {
  /** 支持加载已有会话 */
  loadSession?: boolean;
  /** 支持分叉会话 */
  forkSession?: boolean;
  /** 支持列出会话 */
  listSessions?: boolean;
  /** 支持恢复会话 */
  resumeSession?: boolean;
  /** 支持关闭会话 */
  closeSession?: boolean;
  /** 支持文件系统操作 */
  fsAccess?: boolean;
  /** 支持终端操作 */
  terminal?: boolean;
  /** 可用模式列表 */
  availableModes?: string[];
}

/** ACP Provider 信息 */
export interface AcpProviderInfo {
  /** Provider 名称 */
  name: string;
  /** Provider 版本 */
  version: string;
  /** ACP 协议版本 */
  acpVersion: string;
  /** 是否可用 */
  available: boolean;
  /** 不可用原因 */
  unavailableReason?: string;
  /** 能力声明 */
  capabilities: AcpCapabilities;
}
