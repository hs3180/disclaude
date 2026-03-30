/**
 * ACP (Agent Communication Protocol) 类型定义
 *
 * 基于 JSON-RPC 2.0 的 Agent 通信协议类型。
 * ACP 是 OpenAI 提出的开放协议标准，通过标准化接口解耦 Agent 运行时和模型提供者。
 *
 * @module sdk/acp/types
 * @see Issue #1333
 * @see https://github.com/openai/agentic-communication-protocol
 */

// ============================================================================
// JSON-RPC 2.0 基础类型
// ============================================================================

/** JSON-RPC 2.0 请求 ID（字符串或数字） */
export type JsonRpcId = string | number;

/** JSON-RPC 2.0 请求 */
export interface JsonRpcRequest {
  /** JSON-RPC 版本，必须为 "2.0" */
  jsonrpc: '2.0';
  /** 请求方法名 */
  method: string;
  /** 请求参数 */
  params?: unknown;
  /** 请求 ID（通知时省略） */
  id?: JsonRpcId;
}

/** JSON-RPC 2.0 成功响应 */
export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  result: unknown;
  id: JsonRpcId;
}

/** JSON-RPC 2.0 错误对象 */
export interface JsonRpcError {
  /** 错误码 */
  code: number;
  /** 错误消息 */
  message: string;
  /** 附加数据 */
  data?: unknown;
}

/** JSON-RPC 2.0 错误响应 */
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  error: JsonRpcError;
  id: JsonRpcId | null;
}

/** JSON-RPC 2.0 响应（成功或错误） */
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/** 判断 JSON-RPC 消息是否为响应 */
export function isJsonRpcResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'jsonrpc' in msg && 'jsonrpc' in msg && !('method' in msg);
}

/** JSON-RPC 2.0 消息（请求、响应或通知） */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse;

// ============================================================================
// ACP 标准错误码
// ============================================================================

/** ACP 协议错误码（基于 JSON-RPC 2.0，-32000 到 -32099 为保留范围） */
export const AcpErrorCodes = {
  /** 解析错误 */
  PARSE_ERROR: -32700,
  /** 无效请求 */
  INVALID_REQUEST: -32600,
  /** 方法未找到 */
  METHOD_NOT_FOUND: -32601,
  /** 无效参数 */
  INVALID_PARAMS: -32602,
  /** 内部错误 */
  INTERNAL_ERROR: -32603,
  /** Agent 未就绪 */
  AGENT_NOT_READY: -32001,
  /** 任务不存在 */
  TASK_NOT_FOUND: -32002,
  /** 任务已取消 */
  TASK_CANCELLED: -32003,
  /** 能力不支持 */
  CAPABILITY_NOT_SUPPORTED: -32004,
  /** 连接超时 */
  CONNECTION_TIMEOUT: -32005,
} as const;

// ============================================================================
// ACP 方法名
// ============================================================================

/** ACP 协议方法名 */
export const AcpMethods = {
  /** 初始化连接，交换能力声明 */
  INITIALIZE: 'initialize',
  /** 创建 Agent 任务 */
  TASK_CREATE: 'tasks/create',
  /** 发送消息到任务 */
  TASK_SEND: 'tasks/send',
  /** 取消任务 */
  TASK_CANCEL: 'tasks/cancel',
  /** 获取任务状态 */
  TASK_STATUS: 'tasks/status',
} as const;

/** ACP 方法名类型 */
export type AcpMethod = (typeof AcpMethods)[keyof typeof AcpMethods];

// ============================================================================
// ACP 能力声明
// ============================================================================

/** ACP 能力声明 */
export interface AcpCapabilities {
  /** 支持的 ACP 协议版本 */
  protocolVersion: string;
  /** Client/Server 角色标识 */
  role: 'client' | 'server';
  /** 支持的消息格式 */
  contentTypes?: string[];
  /** 支持的工具调用格式 */
  toolFormats?: string[];
  /** 是否支持流式输出 */
  streaming?: boolean;
  /** 自定义能力 */
  [key: string]: unknown;
}

/** initialize 请求参数 */
export interface AcpInitializeParams {
  /** Client 能力声明 */
  capabilities: AcpCapabilities;
  /** Client 信息 */
  clientInfo: {
    name: string;
    version: string;
  };
}

/** initialize 响应结果 */
export interface AcpInitializeResult {
  /** Server 能力声明 */
  capabilities: AcpCapabilities;
  /** Server 信息 */
  serverInfo: {
    name: string;
    version: string;
  };
  /** 协议版本 */
  protocolVersion: string;
}

// ============================================================================
// ACP 任务类型
// ============================================================================

/** ACP 任务状态 */
export type AcpTaskStatus =
  | 'created'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** ACP 任务创建参数 */
export interface AcpTaskCreateParams {
  /** 任务元数据 */
  metadata?: Record<string, unknown>;
  /** 初始配置 */
  config?: Record<string, unknown>;
}

/** ACP 任务创建结果 */
export interface AcpTaskCreateResult {
  /** 任务 ID */
  taskId: string;
  /** 任务状态 */
  status: AcpTaskStatus;
}

/** ACP 消息内容块 */
export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

/** ACP 任务消息发送参数 */
export interface AcpTaskSendParams {
  /** 任务 ID */
  taskId: string;
  /** 消息内容 */
  content: AcpContentBlock[];
  /** 消息角色 */
  role?: 'user' | 'assistant';
}

/** ACP 任务消息发送结果 */
export interface AcpTaskSendResult {
  /** 任务 ID */
  taskId: string;
  /** 是否有更多消息 */
  hasMore: boolean;
}

/** ACP 任务取消参数 */
export interface AcpTaskCancelParams {
  /** 任务 ID */
  taskId: string;
  /** 取消原因 */
  reason?: string;
}

/** ACP 任务取消结果 */
export interface AcpTaskCancelResult {
  /** 任务 ID */
  taskId: string;
  /** 取消后状态 */
  status: 'cancelled';
}

/** ACP 任务状态查询参数 */
export interface AcpTaskStatusParams {
  /** 任务 ID */
  taskId: string;
}

/** ACP 任务状态查询结果 */
export interface AcpTaskStatusResult {
  /** 任务 ID */
  taskId: string;
  /** 当前状态 */
  status: AcpTaskStatus;
  /** 错误信息（如果失败） */
  error?: string;
}

// ============================================================================
// ACP 通知类型（Server → Client 的异步消息）
// ============================================================================

/** ACP 通知方法名 */
export const AcpNotifications = {
  /** 任务状态变更通知 */
  TASK_STATUS_CHANGED: 'notifications/taskStatusChanged',
  /** 任务消息通知（Agent 输出） */
  TASK_MESSAGE: 'notifications/taskMessage',
} as const;

/** ACP 任务状态变更通知参数 */
export interface AcpTaskStatusChangedParams {
  /** 任务 ID */
  taskId: string;
  /** 新状态 */
  status: AcpTaskStatus;
  /** 错误信息 */
  error?: string;
}

/** ACP 任务消息通知参数 */
export interface AcpTaskMessageParams {
  /** 任务 ID */
  taskId: string;
  /** 消息内容块 */
  content: AcpContentBlock[];
  /** 消息角色 */
  role: 'assistant';
}

// ============================================================================
// ACP 传输层配置
// ============================================================================

/** ACP 传输类型 */
export type AcpTransportType = 'stdio' | 'sse';

/** ACP stdio 传输配置 */
export interface AcpStdioTransportConfig {
  type: 'stdio';
  /** 要执行的命令 */
  command: string;
  /** 命令参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** 工作目录 */
  cwd?: string;
}

/** ACP SSE 传输配置 */
export interface AcpSseTransportConfig {
  type: 'sse';
  /** SSE 服务端 URL */
  url: string;
  /** 请求头 */
  headers?: Record<string, string>;
}

/** ACP 传输配置联合类型 */
export type AcpTransportConfig = AcpStdioTransportConfig | AcpSseTransportConfig;

/** ACP 连接配置 */
export interface AcpConnectionConfig {
  /** 传输层配置 */
  transport: AcpTransportConfig;
  /** 初始化超时（毫秒），默认 30000 */
  initTimeout?: number;
  /** 请求超时（毫秒），默认 120000 */
  requestTimeout?: number;
  /** 自定义能力声明（追加到默认能力） */
  capabilities?: Partial<AcpCapabilities>;
}
