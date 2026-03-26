/**
 * ACP (Agent Communication Protocol) 类型定义
 *
 * 定义 ACP 协议的核心类型，包括能力声明、任务管理、
 * 消息传递等。ACP 基于 JSON-RPC 2.0 传输。
 */

// ============================================================================
// 传输层类型
// ============================================================================

/** ACP 支持的传输类型 */
export type AcpTransportType = 'stdio' | 'sse';

/** stdio 传输配置 */
export interface AcpStdioConfig {
  type: 'stdio';
  /** 启动 ACP Server 的命令 */
  command: string;
  /** 命令参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
}

/** SSE 传输配置 */
export interface AcpSseConfig {
  type: 'sse';
  /** ACP Server 的 SSE 端点 URL */
  url: string;
  /** 请求头 */
  headers?: Record<string, string>;
}

/** ACP 传输配置联合类型 */
export type AcpTransportConfig = AcpStdioConfig | AcpSseConfig;

// ============================================================================
// 能力声明 (Capability Negotiation)
// ============================================================================

/** 客户端能力声明 */
export interface AcpClientCapabilities {
  /** 客户端支持的协议版本 */
  protocolVersion: string;
  /** 客户端名称 */
  clientName: string;
  /** 客户端版本 */
  clientVersion: string;
}

/** 服务端能力声明 */
export interface AcpServerCapabilities {
  /** 服务端支持的协议版本 */
  protocolVersion: string;
  /** 服务端名称 */
  serverName: string;
  /** 服务端版本 */
  serverVersion: string;
  /** 支持的任务功能 */
  taskCapabilities?: AcpTaskCapabilities;
  /** 支持的流式传输 */
  streamingSupport?: boolean;
}

/** 任务相关能力 */
export interface AcpTaskCapabilities {
  /** 是否支持任务取消 */
  cancelSupport: boolean;
  /** 是否支持任务状态查询 */
  statusSupport: boolean;
  /** 最大并发任务数 */
  maxConcurrentTasks?: number;
}

// ============================================================================
// 初始化 (initialize)
// ============================================================================

/** initialize 请求参数 */
export interface AcpInitializeParams {
  /** 客户端能力 */
  capabilities: AcpClientCapabilities;
  /** 客户端配置信息 */
  clientInfo?: {
    [key: string]: unknown;
  };
}

/** initialize 响应结果 */
export interface AcpInitializeResult {
  /** 服务端能力 */
  capabilities: AcpServerCapabilities;
  /** 服务端信息 */
  serverInfo?: {
    [key: string]: unknown;
  };
}

// ============================================================================
// 任务管理 (Task Management)
// ============================================================================

/** 任务 ID */
export type AcpTaskId = string;

/** 任务状态 */
export type AcpTaskStatus =
  | 'pending'      // 已创建，等待执行
  | 'running'      // 正在执行
  | 'completed'    // 执行完成
  | 'cancelled'    // 已取消
  | 'failed';      // 执行失败

/** 任务优先级 */
export type AcpTaskPriority = 'low' | 'normal' | 'high';

/** 任务消息角色 */
export type AcpTaskMessageRole = 'user' | 'assistant' | 'system';

/** 任务消息内容块 */
export interface AcpContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  /** 文本内容（type=text 时） */
  text?: string;
  /** 图像数据（type=image 时） */
  data?: string;
  /** MIME 类型（type=image 时） */
  mimeType?: string;
  /** 工具名称（type=tool_use 时） */
  name?: string;
  /** 工具输入（type=tool_use 时） */
  input?: unknown;
  /** 工具结果（type=tool_result 时） */
  output?: string;
  /** 关联的工具调用 ID（type=tool_result 时） */
  toolUseId?: string;
  /** 是否为工具错误（type=tool_result 时） */
  isError?: boolean;
}

/** ACP 任务消息 */
export interface AcpTaskMessage {
  role: AcpTaskMessageRole;
  content: string | AcpContentBlock[];
}

/** tasks/send 请求参数 */
export interface AcpTaskSendParams {
  /** 任务 ID（由客户端生成） */
  taskId: AcpTaskId;
  /** 对话消息列表 */
  messages: AcpTaskMessage[];
  /** 任务配置 */
  options?: AcpTaskOptions;
}

/** 任务选项 */
export interface AcpTaskOptions {
  /** 使用的模型 */
  model?: string;
  /** 温度参数 */
  temperature?: number;
  /** 最大 token 数 */
  maxTokens?: number;
  /** 系统提示词 */
  systemPrompt?: string;
  /** 允许使用的工具列表 */
  allowedTools?: string[];
  /** 停止序列 */
  stopSequences?: string[];
  /** 是否流式返回 */
  stream?: boolean;
}

/** tasks/send 响应结果 */
export interface AcpTaskSendResult {
  /** 任务 ID */
  taskId: AcpTaskId;
  /** 任务状态 */
  status: AcpTaskStatus;
  /** 任务消息（非流式时返回完整结果） */
  message?: AcpTaskMessage;
}

/** tasks/cancel 请求参数 */
export interface AcpTaskCancelParams {
  /** 要取消的任务 ID */
  taskId: AcpTaskId;
}

/** tasks/cancel 响应结果 */
export interface AcpTaskCancelResult {
  /** 任务 ID */
  taskId: AcpTaskId;
  /** 取消后的状态 */
  status: AcpTaskStatus;
}

/** tasks/status 请求参数 */
export interface AcpTaskStatusParams {
  /** 要查询的任务 ID */
  taskId: AcpTaskId;
}

/** tasks/status 响应结果 */
export interface AcpTaskStatusResult {
  /** 任务 ID */
  taskId: AcpTaskId;
  /** 当前状态 */
  status: AcpTaskStatus;
  /** 任务消息历史（可选） */
  messages?: AcpTaskMessage[];
  /** 使用统计（可选） */
  usage?: AcpTaskUsage;
}

/** 任务使用统计 */
export interface AcpTaskUsage {
  /** 输入 token 数 */
  inputTokens: number;
  /** 输出 token 数 */
  outputTokens: number;
  /** 总 token 数 */
  totalTokens: number;
}

// ============================================================================
// 流式通知 (Streaming Notifications)
// ============================================================================

/** notifications/task/message 通知参数 — 任务消息流 */
export interface AcpTaskMessageNotification {
  /** 任务 ID */
  taskId: AcpTaskId;
  /** 消息内容 */
  message: AcpTaskMessage;
}

/** notifications/task/status 通知参数 — 任务状态变更 */
export interface AcpTaskStatusNotification {
  /** 任务 ID */
  taskId: AcpTaskId;
  /** 新状态 */
  status: AcpTaskStatus;
  /** 错误信息（status=failed 时） */
  error?: string;
}

// ============================================================================
// 连接事件
// ============================================================================

/** ACP 连接状态 */
export type AcpConnectionState =
  | 'disconnected'   // 未连接
  | 'connecting'     // 正在连接
  | 'connected'      // 已连接
  | 'ready'          // 已完成初始化握手
  | 'error';         // 连接错误

/** ACP 连接事件 */
export interface AcpConnectionEvent {
  type: AcpConnectionState;
  error?: Error;
}

/** ACP 事件监听器类型 */
export type AcpConnectionListener = (event: AcpConnectionEvent) => void;
