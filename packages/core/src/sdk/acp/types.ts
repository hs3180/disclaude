/**
 * ACP (Agent Communication Protocol) 类型定义
 *
 * 基于 OpenAI ACP 规范的 JSON-RPC 2.0 消息类型。
 * ACP 通过标准化接口解耦 Agent 运行时和模型提供者。
 *
 * @see https://github.com/openai/agentic-communication-protocol
 * @see Issue #1333
 */

// ============================================================================
// JSON-RPC 2.0 基础类型
// ============================================================================

/** JSON-RPC 2.0 请求 */
export interface JsonRpcRequest<TParams = Record<string, unknown>> {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly method: string;
  readonly params?: TParams;
}

/** JSON-RPC 2.0 响应（成功） */
export interface JsonRpcSuccessResponse<TResult = unknown> {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly result: TResult;
}

/** JSON-RPC 2.0 响应（错误） */
export interface JsonRpcErrorResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly error: JsonRpcError;
}

/** JSON-RPC 2.0 错误 */
export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** JSON-RPC 2.0 通知（无 id，不期望响应） */
export interface JsonRpcNotification<TParams = Record<string, unknown>> {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: TParams;
}

/** JSON-RPC 消息联合类型 */
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse
  | JsonRpcNotification;

// ============================================================================
// ACP 能力协商 (initialize)
// ============================================================================

/** ACP Client 能力声明 */
export interface AcpClientCapabilities {
  /** 支持的 ACP 协议版本列表 */
  readonly protocolVersions?: string[];
}

/** ACP Server 能力声明 */
export interface AcpServerCapabilities {
  /** 支持的 ACP 协议版本列表 */
  readonly protocolVersions?: string[];
  /** 是否支持流式输出 */
  readonly streaming?: boolean;
  /** 是否支持工具调用 */
  readonly tools?: boolean;
  /** 是否支持任务取消 */
  readonly taskCancellation?: boolean;
}

/** initialize 请求参数 */
export interface AcpInitializeParams {
  /** 客户端能力 */
  readonly capabilities: AcpClientCapabilities;
  /** 客户端信息 */
  readonly clientInfo: AcpClientInfo;
}

/** initialize 响应结果 */
export interface AcpInitializeResult {
  /** 协议版本 */
  readonly protocolVersion: string;
  /** 服务器能力 */
  readonly capabilities: AcpServerCapabilities;
  /** 服务器信息 */
  readonly serverInfo: AcpServerInfo;
}

/** 客户端信息 */
export interface AcpClientInfo {
  readonly name: string;
  readonly version: string;
}

/** 服务器信息 */
export interface AcpServerInfo {
  readonly name: string;
  readonly version: string;
}

// ============================================================================
// ACP 任务管理 (tasks/send, tasks/cancel)
// ============================================================================

/** 任务状态 */
export type AcpTaskState =
  | 'submitted'     // 已提交，等待处理
  | 'working'       // 正在处理
  | 'input_required' // 需要用户输入
  | 'completed'     // 已完成
  | 'failed'        // 失败
  | 'cancelled';    // 已取消

/** 任务优先级 */
export type AcpTaskPriority = 'low' | 'normal' | 'high';

/** 任务消息角色 */
export type AcpTaskRole = 'user' | 'assistant' | 'system';

/** 任务内容块 */
export interface AcpTaskContent {
  readonly type: 'text' | 'image' | 'tool_use' | 'tool_result';
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly isError?: boolean;
}

/** 任务消息 */
export interface AcpTaskMessage {
  readonly role: AcpTaskRole;
  readonly content: string | AcpTaskContent[];
}

/** tasks/send 请求参数 */
export interface AcpTaskSendParams {
  /** 用户消息 */
  readonly message: AcpTaskMessage;
  /** 任务元数据 */
  readonly metadata?: AcpTaskMetadata;
}

/** 任务元数据 */
export interface AcpTaskMetadata {
  readonly taskId?: string;
  readonly priority?: AcpTaskPriority;
  /** 自定义键值对 */
  readonly [key: string]: unknown;
}

/** tasks/send 响应结果 */
export interface AcpTaskSendResult {
  /** 任务 ID */
  readonly taskId: string;
  /** 当前任务状态 */
  readonly state: AcpTaskState;
}

/** tasks/cancel 请求参数 */
export interface AcpTaskCancelParams {
  readonly taskId: string;
}

/** tasks/cancel 响应结果 */
export interface AcpTaskCancelResult {
  readonly taskId: string;
  readonly state: AcpTaskState;
}

// ============================================================================
// ACP 通知 (notifications)
// ============================================================================

/** 任务状态变更通知 */
export interface AcpTaskStatusNotification {
  readonly taskId: string;
  readonly state: AcpTaskState;
  readonly message?: AcpTaskMessage;
  readonly error?: string;
}

/** 任务进度通知 */
export interface AcpTaskProgressNotification {
  readonly taskId: string;
  readonly progress?: number;
  readonly message?: string;
}

// ============================================================================
// ACP 传输层配置
// ============================================================================

/** stdio 传输配置 */
export interface AcpStdioTransportConfig {
  /** 命令 */
  readonly command: string;
  /** 命令参数 */
  readonly args?: string[];
  /** 环境变量 */
  readonly env?: Record<string, string | undefined>;
  /** 工作目录 */
  readonly cwd?: string;
  /** 启动超时（毫秒） */
  readonly startupTimeoutMs?: number;
}

/** ACP Client 配置 */
export interface AcpClientConfig {
  /** 传输层配置 */
  readonly transport: AcpStdioTransportConfig;
  /** 客户端信息 */
  readonly clientInfo?: AcpClientInfo;
  /** 请求超时（毫秒） */
  readonly requestTimeoutMs?: number;
}

// ============================================================================
// ACP 事件
// ============================================================================

/** ACP Client 事件类型 */
export type AcpEventType =
  | 'connected'
  | 'disconnected'
  | 'task_status'
  | 'task_progress'
  | 'error';

/** ACP 事件 */
export interface AcpEvent {
  readonly type: AcpEventType;
  readonly data: unknown;
}

/** 任务状态事件 */
export interface AcpTaskStatusEvent extends AcpEvent {
  readonly type: 'task_status';
  readonly data: AcpTaskStatusNotification;
}

/** 任务进度事件 */
export interface AcpTaskProgressEvent extends AcpEvent {
  readonly type: 'task_progress';
  readonly data: AcpTaskProgressNotification;
}

/** 错误事件 */
export interface AcpErrorEvent extends AcpEvent {
  readonly type: 'error';
  readonly data: { code: number; message: string; data?: unknown };
}
