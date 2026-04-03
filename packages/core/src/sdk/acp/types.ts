/**
 * ACP (Agent Client Protocol) 类型定义
 *
 * 基于 Agent Client Protocol 规范实现的类型系统。
 * ACP 标准化了 Client（代码编辑器等）与 Agent（AI 编码助手等）之间的通信。
 *
 * @see https://github.com/agentclientprotocol/agent-client-protocol
 * @see Issue #1333 - 支持OpenAI Agent
 */

// ============================================================================
// JSON-RPC 2.0 基础类型
// ============================================================================

/** JSON-RPC 2.0 请求消息 */
export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: TParams;
}

/** JSON-RPC 2.0 通知消息（无 id，不期望响应） */
export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: TParams;
}

/** JSON-RPC 2.0 成功响应 */
export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: '2.0';
  id: number;
  result: TResult;
}

/** JSON-RPC 2.0 错误响应 */
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: number | null;
  error: JsonRpcError;
}

/** JSON-RPC 2.0 错误对象 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** JSON-RPC 消息联合类型 */
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

// ============================================================================
// JSON-RPC 2.0 预定义错误码
// ============================================================================

export const JsonRpcErrorCode = {
  /** 解析错误 - 收到无效的 JSON */
  PARSE_ERROR: -32700,
  /** 无效请求 - 请求对象不是有效的 Request */
  INVALID_REQUEST: -32600,
  /** 方法未找到 */
  METHOD_NOT_FOUND: -32601,
  /** 无效参数 */
  INVALID_PARAMS: -32602,
  /** 内部错误 */
  INTERNAL_ERROR: -32603,
} as const;

/** ACP 扩展错误码 */
export const AcpErrorCode = {
  /** 需要认证 */
  AUTH_REQUIRED: -32000,
  /** 资源未找到 */
  RESOURCE_NOT_FOUND: -32002,
} as const;

// ============================================================================
// ACP 能力协商类型
// ============================================================================

/** 客户端文件系统能力 */
export interface ClientFsCapabilities {
  readTextFile?: boolean;
  writeTextFile?: boolean;
}

/** 客户端能力声明 */
export interface ClientCapabilities {
  fs?: ClientFsCapabilities;
  terminal?: boolean;
}

/** 客户端信息 */
export interface ClientInfo {
  name: string;
  title?: string;
  version: string;
}

/** Agent 提示能力 */
export interface PromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

/** Agent MCP 能力 */
export interface McpCapabilities {
  http?: boolean;
  sse?: boolean;
}

/** Agent 会话能力 */
export interface SessionCapabilities {
  list?: boolean;
  fork?: boolean;
  resume?: boolean;
  close?: boolean;
}

/** Agent 能力声明 */
export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: PromptCapabilities;
  mcpCapabilities?: McpCapabilities;
  sessionCapabilities?: SessionCapabilities;
}

/** Agent 信息 */
export interface AgentInfo {
  name: string;
  title?: string;
  version: string;
}

/** 认证方法描述 */
export interface AuthMethod {
  id: string;
  name: string;
}

// ============================================================================
// ACP 初始化类型
// ============================================================================

/** initialize 请求参数 */
export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities?: ClientCapabilities;
  clientInfo: ClientInfo;
}

/** initialize 响应结果 */
export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  agentInfo: AgentInfo;
  authMethods?: AuthMethod[];
}

/** authenticate 请求参数 */
export interface AuthenticateParams {
  method: string;
  token?: string;
}

/** authenticate 响应结果 */
export interface AuthenticateResult {
  success: boolean;
}

// ============================================================================
// ACP 会话类型
// ============================================================================

/** 会话提示停止原因 */
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

/** MCP 服务器配置（ACP 格式） */
export interface AcpMcpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
}

/** session/new 请求参数 */
export interface SessionNewParams {
  cwd?: string;
  mcpServers?: AcpMcpServerConfig[];
}

/** session/new 响应结果 */
export interface SessionNewResult {
  sessionId: string;
}

/** session/load 请求参数 */
export interface SessionLoadParams {
  sessionId: string;
}

/** session/load 响应结果 */
export interface SessionLoadResult {
  sessionId: string;
}

/** session/prompt 请求参数 */
export interface SessionPromptParams {
  sessionId: string;
  prompt: AcpContentBlock[];
}

/** session/prompt 响应结果 */
export interface SessionPromptResult {
  sessionId: string;
  stopReason: StopReason;
}

// ============================================================================
// ACP 内容块类型
// ============================================================================

/** 文本内容块 */
export interface AcpTextBlock {
  type: 'text';
  text: string;
}

/** 图像内容块 */
export interface AcpImageBlock {
  type: 'image';
  data: string;
  mimeType: string;
}

/** 资源链接 */
export interface AcpResourceLinkBlock {
  type: 'resource_link';
  uri: string;
  name?: string;
}

/** 内嵌资源 */
export interface AcpResourceBlock {
  type: 'resource';
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

/** 音频内容块 */
export interface AcpAudioBlock {
  type: 'audio';
  data: string;
  mimeType: string;
}

/** ACP 内容块联合类型 */
export type AcpContentBlock =
  | AcpTextBlock
  | AcpImageBlock
  | AcpResourceLinkBlock
  | AcpResourceBlock
  | AcpAudioBlock;

// ============================================================================
// ACP 会话更新类型
// ============================================================================

/** 工具调用状态 */
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** 工具调用种类 */
export type ToolCallKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'other'
  | 'switch_mode';

/** 工具调用位置 */
export interface ToolCallLocation {
  path?: string;
  line?: number;
}

/** 工具调用更新 */
export interface ToolCallUpdate {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  status: ToolCallStatus;
  content?: ToolCallContentItem[];
  rawOutput?: unknown;
}

/** 工具调用内容类型 */
export interface ToolCallContentItem {
  type: 'content' | 'diff' | 'terminal';
  content?: AcpContentBlock;
  path?: string;
  oldText?: string;
  newText?: string;
  terminalId?: string;
}

/** 会话更新联合类型 */
export type SessionUpdate =
  | { sessionUpdate: 'user_message_chunk'; content: AcpContentBlock[] }
  | { sessionUpdate: 'agent_message_chunk'; content: AcpContentBlock[] }
  | { sessionUpdate: 'agent_thought_chunk'; content: AcpContentBlock[] }
  | {
      sessionUpdate: 'tool_call';
      toolCallId: string;
      title: string;
      kind: ToolCallKind;
      status: ToolCallStatus;
      locations?: ToolCallLocation[];
      rawInput?: unknown;
    }
  | ToolCallUpdate
  | { sessionUpdate: 'plan'; content: AcpContentBlock[] }
  | { sessionUpdate: 'available_commands_update'; commands: string[] }
  | { sessionUpdate: 'current_mode_update'; mode: string }
  | { sessionUpdate: 'config_option_update'; options: Record<string, unknown> }
  | { sessionUpdate: 'session_info_update'; info: Record<string, unknown> }
  | { sessionUpdate: 'usage_update'; usage: AcpUsageStats };

/** ACP 使用统计 */
export interface AcpUsageStats {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

/** session/update 通知参数 */
export interface SessionUpdateNotification {
  sessionId: string;
  update: SessionUpdate;
}

/** session/cancel 通知参数 */
export interface SessionCancelNotification {
  sessionId: string;
}

// ============================================================================
// ACP 权限请求类型
// ============================================================================

/** 权限选项类型 */
export type PermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

/** 权限选项 */
export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

/** 权限请求中的工具调用信息 */
export interface PermissionToolCall {
  toolCallId: string;
  title: string;
  kind: ToolCallKind;
  status: ToolCallStatus;
}

/** session/request_permission 请求参数 */
export interface RequestPermissionParams {
  sessionId: string;
  toolCall: PermissionToolCall;
  options: PermissionOption[];
}

/** 权限请求结果 */
export interface PermissionOutcome {
  outcome: 'selected' | 'cancelled';
  optionId?: string;
}

/** session/request_permission 响应结果 */
export interface RequestPermissionResult {
  outcome: PermissionOutcome;
}

// ============================================================================
// ACP 连接状态
// ============================================================================

/** ACP 连接状态 */
export type AcpConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'initializing'
  | 'authenticating'
  | 'ready'
  | 'error'
  | 'closed';

/** ACP 连接配置 */
export interface AcpConnectionConfig {
  /** Agent 可执行文件路径 */
  agentCommand: string;
  /** Agent 启动参数 */
  agentArgs?: string[];
  /** Agent 环境变量 */
  agentEnv?: Record<string, string>;
  /** 客户端信息 */
  clientInfo: ClientInfo;
  /** 客户端能力 */
  clientCapabilities?: ClientCapabilities;
  /** 请求超时时间（毫秒），默认 30000 */
  requestTimeout?: number;
  /** 初始化超时时间（毫秒），默认 10000 */
  initTimeout?: number;
}
