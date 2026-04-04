/**
 * ACP (Agent Communication Protocol) 类型定义
 *
 * 定义了 ACP 协议的核心类型，包括 JSON-RPC 2.0 消息格式、
 * ACP 特定的方法/参数/通知，以及能力协商相关类型。
 *
 * ACP 基于 JSON-RPC 2.0 规范，通过 stdio 或 SSE 传输。
 *
 * @module acp/types
 * @see Issue #1333 - 支持OpenAI Agent via ACP
 */

// ============================================================================
// JSON-RPC 2.0 基础类型
// ============================================================================

/** JSON-RPC 2.0 请求 ID 类型 */
export type JsonRpcId = string | number | null;

/** JSON-RPC 2.0 请求 */
export interface JsonRpcRequest<T = unknown> {
  /** JSON-RPC 版本，固定为 "2.0" */
  jsonrpc: '2.0';
  /** 请求方法名 */
  method: string;
  /** 请求参数 */
  params?: T;
  /** 请求 ID（通知时省略） */
  id?: JsonRpcId;
}

/** JSON-RPC 2.0 成功响应 */
export interface JsonRpcSuccessResponse<T = unknown> {
  /** JSON-RPC 版本 */
  jsonrpc: '2.0';
  /** 对应请求的 ID */
  id: JsonRpcId;
  /** 结果数据 */
  result: T;
}

/** JSON-RPC 2.0 错误对象 */
export interface JsonRpcErrorObject {
  /** 错误码 */
  code: number;
  /** 错误消息 */
  message: string;
  /** 附加数据 */
  data?: unknown;
}

/** JSON-RPC 2.0 错误响应 */
export interface JsonRpcErrorResponse {
  /** JSON-RPC 版本 */
  jsonrpc: '2.0';
  /** 对应请求的 ID */
  id: JsonRpcId;
  /** 错误对象 */
  error: JsonRpcErrorObject;
}

/** JSON-RPC 2.0 响应（成功或错误） */
export type JsonRpcResponse<T = unknown> =
  | JsonRpcSuccessResponse<T>
  | JsonRpcErrorResponse;

/** JSON-RPC 2.0 消息（请求或响应） */
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponse;

// ============================================================================
// JSON-RPC 2.0 预定义错误码
// ============================================================================

/** JSON-RPC 标准错误码 */
export const JsonRpcErrorCode = {
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
} as const;

// ============================================================================
// ACP 协议方法名
// ============================================================================

/** ACP 协议方法名常量 */
export const AcpMethod = {
  /** 初始化 - 能力协商 */
  INITIALIZE: 'initialize',
  /** 创建任务 */
  TASK_CREATE: 'tasks/create',
  /** 发送任务消息 */
  TASK_SEND: 'tasks/send',
  /** 取消任务 */
  TASK_CANCEL: 'tasks/cancel',
  /** 列出任务 */
  TASK_LIST: 'tasks/list',
  /** 获取任务状态 */
  TASK_GET: 'tasks/get',
  /** 关闭任务 */
  TASK_CLOSE: 'tasks/close',
  /** 分叉任务 */
  TASK_FORK: 'tasks/fork',
} as const;

// ============================================================================
// ACP 协议通知名
// ============================================================================

/** ACP 协议通知名常量 */
export const AcpNotification = {
  /** 任务状态更新 */
  TASK_STATUS: 'notifications/task/status',
  /** 任务消息 */
  TASK_MESSAGE: 'notifications/task/message',
  /** 任务 artefact 产出 */
  TASK_ARTEFACT: 'notifications/task/artefact',
} as const;

// ============================================================================
// ACP 能力声明
// ============================================================================

/** Agent 能力声明 */
export interface AcpAgentCapabilities {
  /** 支持的流式输出 */
  streaming?: boolean;
  /** 支持的工具调用 */
  toolUse?: boolean;
  /** 支持的任务取消 */
  taskCancellation?: boolean;
  /** 支持的任务分叉 */
  taskForking?: boolean;
  /** 支持的状态推送 */
  pushNotifications?: boolean;
}

/** Client 能力声明 */
export interface AcpClientCapabilities {
  /** 支持接收推送通知 */
  subscriptions?: boolean;
  /** 支持的任务取消 */
  taskCancellation?: boolean;
}

// ============================================================================
// ACP 初始化
// ============================================================================

/** 初始化请求参数 (Client -> Agent) */
export interface AcpInitializeParams {
  /** Client 名称 */
  clientName: string;
  /** Client 版本 */
  clientVersion: string;
  /** Client 能力 */
  capabilities: AcpClientCapabilities;
}

/** 初始化响应结果 (Agent -> Client) */
export interface AcpInitializeResult {
  /** Agent 名称 */
  agentName: string;
  /** Agent 版本 */
  agentVersion: string;
  /** Agent 能力 */
  capabilities: AcpAgentCapabilities;
  /** Agent 支持的 ACP 协议版本 */
  protocolVersion: string;
}

// ============================================================================
// ACP 任务 (Task)
// ============================================================================

/** 任务状态 */
export type AcpTaskState =
  | 'created'
  | 'working'
  | 'input_required'
  | 'completed'
  | 'canceled'
  | 'failed';

/** 任务创建请求参数 */
export interface AcpTaskCreateParams {
  /** 任务元数据 */
  metadata?: Record<string, string>;
}

/** 任务信息 */
export interface AcpTaskInfo {
  /** 任务 ID */
  id: string;
  /** 任务状态 */
  status: AcpTaskState;
  /** 任务元数据 */
  metadata?: Record<string, string>;
  /** 创建时间 (ISO 8601) */
  createdAt?: string;
  /** 更新时间 (ISO 8601) */
  updatedAt?: string;
}

/** 任务创建结果 */
export type AcpTaskCreateResult = AcpTaskInfo;

/** 任务发送消息参数 */
export interface AcpTaskSendParams {
  /** 任务 ID */
  taskId: string;
  /** 消息内容 */
  message: AcpMessage;
  /** 上下文消息（用于多轮对话） */
  context?: AcpMessage[];
}

/** 任务取消参数 */
export interface AcpTaskCancelParams {
  /** 任务 ID */
  taskId: string;
}

/** 任务获取参数 */
export interface AcpTaskGetParams {
  /** 任务 ID */
  taskId: string;
}

/** 任务关闭参数 */
export interface AcpTaskCloseParams {
  /** 任务 ID */
  taskId: string;
}

/** 任务分叉参数 */
export interface AcpTaskForkParams {
  /** 源任务 ID */
  taskId: string;
  /** 新任务元数据 */
  metadata?: Record<string, string>;
}

/** 任务分叉结果 */
export type AcpTaskForkResult = AcpTaskInfo;

/** 任务列表结果 */
export interface AcpTaskListResult {
  /** 任务列表 */
  tasks: AcpTaskInfo[];
}

// ============================================================================
// ACP 消息内容
// ============================================================================

/** 文本内容 */
export interface AcpTextContent {
  type: 'text';
  text: string;
}

/** 图像内容 */
export interface AcpImageContent {
  type: 'image';
  /** Base64 编码的图像数据 */
  data: string;
  /** MIME 类型 */
  mimeType: string;
}

/** 工具调用内容 */
export interface AcpToolUseContent {
  type: 'tool_use';
  /** 工具调用 ID */
  id: string;
  /** 工具名称 */
  name: string;
  /** 工具输入参数 */
  input: Record<string, unknown>;
}

/** 工具结果内容 */
export interface AcpToolResultContent {
  type: 'tool_result';
  /** 对应的工具调用 ID */
  toolUseId: string;
  /** 工具输出 */
  content: string;
  /** 是否为错误结果 */
  isError?: boolean;
}

/** ACP 内容块联合类型 */
export type AcpContentBlock =
  | AcpTextContent
  | AcpImageContent
  | AcpToolUseContent
  | AcpToolResultContent;

/** ACP 消息角色 */
export type AcpRole = 'user' | 'assistant' | 'system';

/** ACP 消息 */
export interface AcpMessage {
  /** 消息角色 */
  role: AcpRole;
  /** 消息内容 */
  content: AcpContentBlock | AcpContentBlock[];
}

/** 任务状态通知参数 */
export interface AcpTaskStatusNotification {
  /** 任务 ID */
  taskId: string;
  /** 任务状态 */
  status: AcpTaskState;
  /** 附加信息 */
  message?: string;
}

/** 任务消息通知参数 */
export interface AcpTaskMessageNotification {
  /** 任务 ID */
  taskId: string;
  /** 消息内容 */
  message: AcpMessage;
}

/** 任务产出通知参数 */
export interface AcpTaskArtefactNotification {
  /** 任务 ID */
  taskId: string;
  /** 产出名称 */
  name: string;
  /** 产出类型 */
  kind: string;
  /** 产出内容 */
  content?: string;
  /** 产出 URI */
  uri?: string;
}

// ============================================================================
// ACP 传输层配置
// ============================================================================

/** 传输类型 */
export type AcpTransportType = 'stdio' | 'sse';

/** stdio 传输配置 */
export interface AcpStdioConfig {
  type: 'stdio';
  /** 要启动的命令 */
  command: string;
  /** 命令参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
}

/** SSE 传输配置 */
export interface AcpSseConfig {
  type: 'sse';
  /** SSE 服务端 URL */
  url: string;
  /** 请求头 */
  headers?: Record<string, string>;
}

/** ACP 传输配置联合类型 */
export type AcpTransportConfig = AcpStdioConfig | AcpSseConfig;

// ============================================================================
// ACP 事件类型（用于 EventEmitter）
// ============================================================================

/** ACP 客户端事件类型 */
export interface AcpClientEvents {
  /** 收到任务状态通知 */
  'task:status': [notification: AcpTaskStatusNotification];
  /** 收到任务消息通知 */
  'task:message': [notification: AcpTaskMessageNotification];
  /** 收到任务产出通知 */
  'task:artefact': [notification: AcpTaskArtefactNotification];
  /** 连接已关闭 */
  close: [];
  /** 发生错误 */
  error: [error: Error];
}
