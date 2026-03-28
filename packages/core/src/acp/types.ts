/**
 * ACP (Agentic Communication Protocol) - 协议类型定义
 *
 * 定义 ACP 协议的核心类型，包括：
 * - 能力声明（Capabilities）
 * - 任务操作（Task operations）
 * - 内容块（Content blocks）
 * - 工具调用（Tool calls）
 *
 * ACP 使用 JSON-RPC 2.0 作为传输层。
 *
 * @module acp/types
 * @see https://github.com/openai/agentic-communication-protocol
 * Related: Issue #1333
 */

// ============================================================================
// 能力声明 (Capabilities)
// ============================================================================

/** 服务端能力 */
export interface ServerCapabilities {
  /** 支持的 ACP 版本列表 */
  acpVersions: string[];
  /** 是否支持流式输出 */
  streaming?: boolean;
  /** 是否支持工具调用 */
  toolUse?: boolean;
  /** 支持的内容类型 */
  contentTypes?: string[];
  /** 最大上下文长度 */
  maxContextLength?: number;
  /** 自定义能力 */
  [key: string]: unknown;
}

/** 客户端能力 */
export interface ClientCapabilities {
  /** 支持的 ACP 版本列表 */
  acpVersions: string[];
  /** 是否支持流式输入 */
  streaming?: boolean;
  /** 是否支持工具提供 */
  toolProviding?: boolean;
  /** 自定义能力 */
  [key: string]: unknown;
}

// ============================================================================
// 会话 (Session)
// ============================================================================

/** 会话状态 */
export type SessionStatus = 'active' | 'completed' | 'cancelled' | 'failed';

/** 会话信息 */
export interface SessionInfo {
  /** 会话 ID */
  id: string;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
  /** 状态 */
  status: SessionStatus;
  /** 模型名称 */
  model?: string;
}

// ============================================================================
// 内容块 (Content Blocks)
// ============================================================================

/** 文本内容 */
export interface AcpTextContent {
  type: 'text';
  text: string;
}

/** 工具使用 */
export interface AcpToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** 工具结果 */
export interface AcpToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/** ACP 内容块联合类型 */
export type AcpContentBlock =
  | AcpTextContent
  | AcpToolUseContent
  | AcpToolResultContent;

// ============================================================================
// 任务操作 (Task Operations)
// ============================================================================

/** 任务发送参数 */
export interface TaskSendParams {
  /** 任务消息 */
  message: AcpTaskMessage;
  /** 会话 ID（可选，用于继续现有会话） */
  sessionId?: string;
}

/** 任务消息 */
export interface AcpTaskMessage {
  /** 角色 */
  role: 'user' | 'assistant' | 'system';
  /** 内容 */
  content: string | AcpContentBlock[];
}

/** 任务取消参数 */
export interface TaskCancelParams {
  /** 任务 ID */
  taskId: string;
}

/** 任务状态 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'cancelled' | 'failed';

/** 任务结果 */
export interface TaskResult {
  /** 任务 ID */
  taskId: string;
  /** 会话 ID */
  sessionId: string;
  /** 状态 */
  status: TaskStatus;
  /** 内容 */
  content?: AcpContentBlock[];
  /** 使用统计 */
  usage?: AcpUsage;
  /** 错误信息 */
  error?: string;
}

/** 使用统计 */
export interface AcpUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ============================================================================
// 通知 (Notifications)
// ============================================================================

/** 消息通知参数 */
export interface MessageNotificationParams {
  /** 任务 ID */
  taskId: string;
  /** 消息内容 */
  content: AcpContentBlock[];
}

/** 进度通知参数 */
export interface ProgressNotificationParams {
  /** 任务 ID */
  taskId: string;
  /** 进度百分比 (0-100) */
  progress: number;
  /** 描述 */
  description?: string;
}

/** 状态通知参数 */
export interface StatusNotificationParams {
  /** 任务 ID */
  taskId: string;
  /** 状态 */
  status: TaskStatus;
  /** 描述 */
  description?: string;
}

// ============================================================================
// 错误码
// ============================================================================

/** ACP 错误码 */
export enum AcpErrorCode {
  /** 内部错误 */
  InternalError = -32603,
  /** 无效参数 */
  InvalidParams = -32602,
  /** 方法不存在 */
  MethodNotFound = -32601,
  /** 无效请求 */
  InvalidRequest = -32600,
  /** 解析错误 */
  ParseError = -32700,
  /** 任务未找到 */
  TaskNotFound = -32001,
  /** 会话未找到 */
  SessionNotFound = -32002,
  /** 能力不支持 */
  CapabilityNotSupported = -32003,
  /** 认证失败 */
  AuthenticationFailed = -32004,
  /** 超时 */
  Timeout = -32005,
}

// ============================================================================
// 连接配置
// ============================================================================

/** 传输类型 */
export type AcpTransportType = 'stdio' | 'sse';

/** stdio 传输配置 */
export interface AcpStdioConfig {
  type: 'stdio';
  /** 命令 */
  command: string;
  /** 参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
}

/** SSE 传输配置 */
export interface AcpSseConfig {
  type: 'sse';
  /** URL */
  url: string;
  /** 请求头 */
  headers?: Record<string, string>;
}

/** ACP 连接配置 */
export type AcpConnectionConfig = AcpStdioConfig | AcpSseConfig;

/** ACP 协议版本 */
export const ACP_VERSION = '0.1.0';

// ============================================================================
// ACP 方法名常量
// ============================================================================

/** ACP JSON-RPC 方法名 */
export const AcpMethod = {
  /** 初始化握手 */
  INITIALIZE: 'acp.initialize',
  /** 发送任务 */
  TASK_SEND: 'acp.task/send',
  /** 取消任务 */
  TASK_CANCEL: 'acp.task/cancel',
  /** 消息通知 */
  NOTIFICATION_MESSAGE: 'acp.notification/message',
  /** 进度通知 */
  NOTIFICATION_PROGRESS: 'acp.notification/progress',
  /** 状态通知 */
  NOTIFICATION_STATUS: 'acp.notification/status',
} as const;

/** 初始化参数 */
export interface InitializeParams {
  /** 客户端能力 */
  capabilities: ClientCapabilities;
  /** 客户端信息 */
  clientInfo?: {
    name: string;
    version: string;
  };
}

/** 初始化结果 */
export interface InitializeResult {
  /** 服务端能力 */
  capabilities: ServerCapabilities;
  /** 服务端信息 */
  serverInfo?: {
    name: string;
    version: string;
  };
}
