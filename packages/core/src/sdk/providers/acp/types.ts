/**
 * ACP (Agentic Communication Protocol) 类型定义
 *
 * 基于 JSON-RPC 2.0 协议，定义了 ACP 客户端与服务端之间的通信类型。
 * ACP 协议支持 stdio 和 SSE 两种传输层。
 *
 * @see Issue #1333 - 支持OpenAI Agent
 * @see https://github.com/openai/agentic-communication-protocol
 */

// ============================================================================
// JSON-RPC 2.0 基础类型
// ============================================================================

/** JSON-RPC 2.0 请求 */
export interface JsonRpcRequest<TParams = unknown> {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly method: string;
  readonly params?: TParams;
}

/** JSON-RPC 2.0 响应 */
export interface JsonRpcResponse<TResult = unknown> {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly result?: TResult;
  readonly error?: JsonRpcError;
}

/** JSON-RPC 2.0 通知（无 id，不需要响应） */
export interface JsonRpcNotification<TParams = unknown> {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: TParams;
}

/** JSON-RPC 2.0 错误 */
export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** JSON-RPC 2.0 标准错误码 */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** ACP 专用：任务不存在 */
  TaskNotFound: -32001,
  /** ACP 专用：任务已取消 */
  TaskCancelled: -32002,
  /** ACP 专用：服务端不可用 */
  ServerUnavailable: -32003,
} as const;

// ============================================================================
// ACP 协议方法名
// ============================================================================

/** ACP 协议方法名常量 */
export const AcpMethod = {
  /** 初始化握手，交换能力声明 */
  Initialize: 'initialize',
  /** 发送任务（用户消息）给 Agent */
  TaskSend: 'tasks/send',
  /** 取消正在执行的任务 */
  TaskCancel: 'tasks/cancel',
  /** 服务端推送任务状态通知 */
  TaskNotification: 'notifications/task',
} as const;

/** ACP 协议版本 */
export const ACP_PROTOCOL_VERSION = '2025-03-26';

// ============================================================================
// ACP 能力协商
// ============================================================================

/** ACP 客户端能力声明 */
export interface AcpClientCapabilities {
  /** 支持流式输出 */
  streaming?: boolean;
  /** 支持推送通知 */
  pushNotifications?: boolean;
}

/** ACP 服务端能力声明 */
export interface AcpServerCapabilities {
  /** 支持工具调用 */
  tools?: boolean;
  /** 支持 MCP 服务器 */
  mcpServers?: boolean;
  /** 支持流式输出 */
  streaming?: boolean;
  /** 支持会话管理 */
  sessions?: boolean;
}

/** ACP 参与者信息 */
export interface AcpParticipantInfo {
  readonly name: string;
  readonly version: string;
}

/** ACP 初始化参数（客户端 → 服务端） */
export interface AcpInitializeParams {
  readonly protocolVersion: string;
  readonly clientInfo: AcpParticipantInfo;
  readonly capabilities: AcpClientCapabilities;
}

/** ACP 初始化结果（服务端 → 客户端） */
export interface AcpInitializeResult {
  readonly protocolVersion: string;
  readonly serverInfo: AcpParticipantInfo;
  readonly capabilities: AcpServerCapabilities;
}

// ============================================================================
// ACP 消息格式
// ============================================================================

/** ACP 文本内容块 */
export interface AcpTextBlock {
  readonly type: 'text';
  readonly text: string;
}

/** ACP 图像内容块 */
export interface AcpImageBlock {
  readonly type: 'image';
  readonly data: string;
  readonly mimeType: string;
}

/** ACP 工具调用块 */
export interface AcpToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** ACP 工具结果块 */
export interface AcpToolResultBlock {
  readonly type: 'tool_result';
  readonly toolUseId: string;
  readonly content: string;
  readonly isError?: boolean;
}

/** ACP 内容块联合类型 */
export type AcpContentBlock =
  | AcpTextBlock
  | AcpImageBlock
  | AcpToolUseBlock
  | AcpToolResultBlock;

/** ACP 消息角色 */
export type AcpRole = 'user' | 'assistant' | 'system';

/** ACP 消息 */
export interface AcpMessage {
  readonly role: AcpRole;
  readonly content: string | AcpContentBlock[];
}

// ============================================================================
// ACP 任务相关类型
// ============================================================================

/** ACP 工具定义 */
export interface AcpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters?: Record<string, unknown>;
}

/** ACP MCP 服务器配置 */
export interface AcpMcpServerConfig {
  readonly type: 'stdio' | 'sse';
  readonly command?: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
  readonly url?: string;
}

/** ACP 任务发送选项 */
export interface AcpTaskOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: AcpToolDefinition[];
  mcpServers?: Record<string, AcpMcpServerConfig>;
  allowedTools?: string[];
  disallowedTools?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/** ACP 任务发送参数 */
export interface AcpTaskSendParams {
  readonly messages: AcpMessage[];
  readonly options?: AcpTaskOptions;
}

/** ACP 任务发送结果 */
export interface AcpTaskSendResult {
  readonly taskId: string;
}

/** ACP 任务取消参数 */
export interface AcpTaskCancelParams {
  readonly taskId: string;
}

/** ACP 任务取消结果 */
export interface AcpTaskCancelResult {
  readonly cancelled: boolean;
}

// ============================================================================
// ACP 任务通知类型
// ============================================================================

/** ACP 通知类型 */
export type AcpNotificationType =
  | 'text'
  | 'tool_use'
  | 'tool_progress'
  | 'tool_result'
  | 'error'
  | 'complete';

/** ACP 任务文本通知数据 */
export interface AcpTextNotificationData {
  readonly text: string;
}

/** ACP 任务工具调用通知数据 */
export interface AcpToolUseNotificationData {
  readonly toolUseId: string;
  readonly name: string;
  readonly input: unknown;
}

/** ACP 任务工具进度通知数据 */
export interface AcpToolProgressNotificationData {
  readonly toolName: string;
  readonly elapsedMs: number;
}

/** ACP 任务工具结果通知数据 */
export interface AcpToolResultNotificationData {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError?: boolean;
}

/** ACP 任务完成通知数据 */
export interface AcpCompleteNotificationData {
  readonly stopReason?: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly costUsd?: number;
  };
}

/** ACP 任务错误通知数据 */
export interface AcpErrorNotificationData {
  readonly code: number;
  readonly message: string;
}

/** ACP 任务通知参数 */
export interface AcpTaskNotificationParams {
  readonly taskId: string;
  readonly type: AcpNotificationType;
  readonly data:
    | AcpTextNotificationData
    | AcpToolUseNotificationData
    | AcpToolProgressNotificationData
    | AcpToolResultNotificationData
    | AcpCompleteNotificationData
    | AcpErrorNotificationData;
}

// ============================================================================
// ACP 传输层类型
// ============================================================================

/** ACP 传输层配置 */
export interface AcpTransportConfig {
  /** 传输类型 */
  readonly type: 'stdio';
  /** ACP 服务端启动命令 */
  readonly command: string;
  /** ACP 服务端启动参数 */
  readonly args?: string[];
  /** ACP 服务端环境变量 */
  readonly env?: Record<string, string | undefined>;
  /** 连接超时（毫秒） */
  readonly connectionTimeout?: number;
}

/** ACP 连接状态 */
export type AcpConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

// ============================================================================
// 类型守卫
// ============================================================================

/** 判断是否为 JSON-RPC 请求 */
export function isJsonRpcRequest(obj: unknown): obj is JsonRpcRequest {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as Record<string, unknown>).jsonrpc === '2.0' &&
    typeof (obj as Record<string, unknown>).method === 'string' &&
    'id' in obj
  );
}

/** 判断是否为 JSON-RPC 通知 */
export function isJsonRpcNotification(obj: unknown): obj is JsonRpcNotification {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as Record<string, unknown>).jsonrpc === '2.0' &&
    typeof (obj as Record<string, unknown>).method === 'string' &&
    !('id' in obj)
  );
}

/** 判断是否为 JSON-RPC 响应 */
export function isJsonRpcResponse(obj: unknown): obj is JsonRpcResponse {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as Record<string, unknown>).jsonrpc === '2.0' &&
    'id' in obj &&
    ('result' in obj || 'error' in obj)
  );
}

/** 判断是否为 ACP 任务通知 */
export function isAcpTaskNotification(obj: unknown): obj is JsonRpcNotification<AcpTaskNotificationParams> {
  return (
    isJsonRpcNotification(obj) &&
    obj.method === AcpMethod.TaskNotification &&
    typeof obj.params === 'object' &&
    obj.params !== null &&
    'taskId' in obj.params &&
    'type' in obj.params
  );
}
