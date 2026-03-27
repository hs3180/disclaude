/**
 * ACP (Agent Communication Protocol) 类型定义
 *
 * 基于 JSON-RPC 2.0 规范的 Agent 通信协议类型。
 * ACP 通过标准化接口解耦 Agent 运行时和模型提供者，
 * 使新模型接入仅需配置连接参数而非编写适配代码。
 *
 * @see https://github.com/openai/agentic-communication-protocol
 * @module sdk/providers/acp/types
 */

// ============================================================================
// JSON-RPC 2.0 基础类型
// ============================================================================

/** JSON-RPC 2.0 请求 */
export interface JsonRpcRequest {
  /** JSON-RPC 版本，固定为 "2.0" */
  readonly jsonrpc: '2.0';
  /** 请求标识符，用于匹配响应 */
  readonly id: string | number;
  /** 调用的方法名 */
  readonly method: string;
  /** 方法参数 */
  readonly params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 成功响应 */
export interface JsonRpcSuccessResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly result: unknown;
}

/** JSON-RPC 2.0 错误响应 */
export interface JsonRpcErrorResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly error: JsonRpcError;
}

/** JSON-RPC 2.0 错误对象 */
export interface JsonRpcError {
  /** 错误码 */
  readonly code: number;
  /** 错误信息 */
  readonly message: string;
  /** 附加数据 */
  readonly data?: unknown;
}

/** JSON-RPC 2.0 通知（无 id，不期望响应） */
export interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** JSON-RPC 消息联合类型 */
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse
  | JsonRpcNotification;

// ============================================================================
// JSON-RPC 标准错误码
// ============================================================================

export const JsonRpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// ============================================================================
// ACP 协议方法
// ============================================================================

/** ACP 方法名常量 */
export const AcpMethod = {
  /** 初始化连接，交换能力声明 */
  INITIALIZE: 'acp/initialize',
  /** 发送任务（用户消息） */
  TASK_SEND: 'acp/task/send',
  /** 取消正在执行的任务 */
  TASK_CANCEL: 'acp/task/cancel',
  /** 获取任务状态 */
  TASK_STATUS: 'acp/task/status',
  /** 通知：Agent 产生的消息（文本、工具调用等） */
  NOTIFICATION_MESSAGE: 'acp/notification/message',
  /** 通知：任务执行进度 */
  NOTIFICATION_PROGRESS: 'acp/notification/progress',
  /** 通知：任务完成 */
  NOTIFICATION_COMPLETE: 'acp/notification/complete',
  /** 通知：任务出错 */
  NOTIFICATION_ERROR: 'acp/notification/error',
} as const;

/** ACP 方法名类型 */
export type AcpMethodName = (typeof AcpMethod)[keyof typeof AcpMethod];

// ============================================================================
// ACP 能力声明 (Capability Negotiation)
// ============================================================================

/** 客户端能力声明 */
export interface AcpClientCapabilities {
  /** 支持的输入格式 */
  inputFormats?: string[];
  /** 支持的工具调用格式 */
  toolFormats?: string[];
  /** 是否支持流式输出 */
  streaming?: boolean;
}

/** 服务端能力声明 */
export interface AcpServerCapabilities {
  /** 支持的模型列表 */
  models?: AcpModelInfo[];
  /** 是否支持工具调用 */
  toolUse?: boolean;
  /** 是否支持流式输出 */
  streaming?: boolean;
  /** 支持的内容类型 */
  contentTypes?: string[];
  /** 服务端名称 */
  serverName?: string;
  /** 服务端版本 */
  serverVersion?: string;
}

/** 模型信息 */
export interface AcpModelInfo {
  /** 模型 ID */
  id: string;
  /** 模型名称 */
  name?: string;
  /** 上下文窗口大小 */
  contextWindow?: number;
  /** 最大输出 token 数 */
  maxOutputTokens?: number;
}

// ============================================================================
// ACP 任务相关类型
// ============================================================================

/** ACP 任务状态 */
export type AcpTaskState = 'pending' | 'running' | 'completed' | 'cancelled' | 'failed';

/** ACP 任务发送参数 */
export interface AcpTaskSendParams {
  /** 任务 ID（由客户端生成） */
  taskId: string;
  /** 用户消息内容 */
  message: AcpMessage;
  /** 任务配置 */
  options?: AcpTaskOptions;
}

/** ACP 任务选项 */
export interface AcpTaskOptions {
  /** 指定模型 */
  model?: string;
  /** 工作目录 */
  cwd?: string;
  /** 允许的工具列表 */
  allowedTools?: string[];
  /** 禁用的工具列表 */
  disallowedTools?: string[];
  /** 自定义环境变量 */
  env?: Record<string, string | undefined>;
  /** 系统提示 */
  systemPrompt?: string;
}

/** ACP 消息内容块 */
export interface AcpContentBlock {
  /** 内容类型 */
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  /** 文本内容（type=text 时） */
  text?: string;
  /** 图像数据（type=image 时） */
  data?: string;
  /** MIME 类型（type=image 时） */
  mimeType?: string;
  /** 工具名称（type=tool_use 时） */
  name?: string;
  /** 工具调用 ID（type=tool_use 时） */
  toolUseId?: string;
  /** 工具输入参数（type=tool_use 时） */
  input?: unknown;
  /** 关联工具调用 ID（type=tool_result 时） */
  toolUseIdResult?: string;
  /** 工具输出（type=tool_result 时） */
  output?: string;
  /** 是否为错误输出 */
  isError?: boolean;
}

/** ACP 消息 */
export interface AcpMessage {
  /** 消息角色 */
  role: 'user' | 'assistant' | 'system';
  /** 消息内容 */
  content: string | AcpContentBlock[];
  /** 关联的工具调用 ID（用于工具结果提交） */
  parentToolUseId?: string | null;
  /** 会话 ID */
  sessionId?: string;
}

/** ACP 通知：消息通知参数 */
export interface AcpNotificationMessageParams {
  /** 任务 ID */
  taskId: string;
  /** 消息内容 */
  message: AcpMessage;
}

/** ACP 通知：进度通知参数 */
export interface AcpNotificationProgressParams {
  /** 任务 ID */
  taskId: string;
  /** 工具名称 */
  toolName?: string;
  /** 已执行时间（秒） */
  elapsedSeconds?: number;
  /** 描述 */
  description?: string;
}

/** ACP 通知：完成通知参数 */
export interface AcpNotificationCompleteParams {
  /** 任务 ID */
  taskId: string;
  /** 最终状态 */
  state: 'completed' | 'failed' | 'cancelled';
  /** 使用统计 */
  usage?: AcpUsageStats;
  /** 错误信息（state=failed 时） */
  error?: string;
}

/** ACP 使用统计 */
export interface AcpUsageStats {
  /** 输入 token 数 */
  inputTokens: number;
  /** 输出 token 数 */
  outputTokens: number;
  /** 总 token 数 */
  totalTokens: number;
  /** 费用（美元） */
  costUsd?: number;
}

// ============================================================================
// ACP 初始化参数和结果
// ============================================================================

/** acp/initialize 请求参数 */
export interface AcpInitializeParams {
  /** 客户端名称 */
  clientName: string;
  /** 客户端版本 */
  clientVersion: string;
  /** 客户端能力 */
  capabilities: AcpClientCapabilities;
}

/** acp/initialize 成功响应结果 */
export interface AcpInitializeResult {
  /** 服务端名称 */
  serverName: string;
  /** 服务端版本 */
  serverVersion: string;
  /** 服务端能力 */
  capabilities: AcpServerCapabilities;
  /** 协议版本 */
  protocolVersion: string;
}

// ============================================================================
// ACP 传输层配置
// ============================================================================

/** ACP 传输类型 */
export type AcpTransportType = 'stdio' | 'sse';

/** stdio 传输配置 */
export interface AcpStdioTransportConfig {
  type: 'stdio';
  /** 要启动的命令 */
  command: string;
  /** 命令参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string | undefined>;
  /** 工作目录 */
  cwd?: string;
}

/** SSE 传输配置 */
export interface AcpSseTransportConfig {
  type: 'sse';
  /** SSE 服务端 URL */
  url: string;
  /** 请求头 */
  headers?: Record<string, string>;
  /** 认证 token */
  authToken?: string;
}

/** ACP 连接配置联合类型 */
export type AcpTransportConfig = AcpStdioTransportConfig | AcpSseTransportConfig;
