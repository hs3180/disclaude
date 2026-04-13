/**
 * ACP (Agent Client Protocol) 类型定义
 *
 * 基于 Zed ACP 协议（JSON-RPC 2.0 over stdio）。
 * 协议参考：test-acp.mjs 中的完整交互序列。
 *
 * 设计约束（PR #2185 教训）：
 * - 不使用 readonly 属性（避免 TS2540 赋值错误）
 * - 不使用 Required<T>（避免 TS2322 类型不匹配）
 * - 使用具体 params 接口（避免 Record<string, unknown> 的 TS2345）
 */

// ============================================================================
// JSON-RPC 2.0 基础类型
// ============================================================================

/** JSON-RPC 2.0 请求 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 成功响应 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result: unknown;
}

/** JSON-RPC 2.0 错误详情 */
export interface JsonRpcErrorDetail {
  code: number;
  message: string;
  data?: unknown;
}

/** JSON-RPC 2.0 错误响应 */
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  error: JsonRpcErrorDetail;
}

/** JSON-RPC 2.0 通知（无 id，不需要响应） */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/** 从 Agent 接收的所有可能 JSON-RPC 消息 */
export type JsonRpcMessage = JsonRpcResponse | JsonRpcErrorResponse | JsonRpcNotification;

// ============================================================================
// ACP 内容块类型
// ============================================================================

/** ACP 文本内容块 */
export interface AcpTextBlock {
  type: 'text';
  text: string;
}

/** ACP 图像内容块 */
export interface AcpImageBlock {
  type: 'image';
  data: string;
  mimeType: string;
}

/** ACP 内容块联合类型 */
export type AcpContentBlock = AcpTextBlock | AcpImageBlock;

// ============================================================================
// 客户端/服务端能力类型
// ============================================================================

/** 客户端认证能力 */
export interface AcpAuthCapabilities {
  terminal: boolean;
}

/** 客户端文件系统能力 */
export interface AcpFsCapabilities {
  readTextFile: boolean;
  writeTextFile: boolean;
}

/** 客户端能力（initialize 时发送） */
export interface AcpClientCapabilities {
  auth: AcpAuthCapabilities;
  fs: AcpFsCapabilities;
  terminal: boolean;
}

/** 模型描述符（session/new 返回） */
export interface AcpModelDescriptor {
  modelId: string;
}

/** 模型信息（session/new 返回） */
export interface AcpModelsInfo {
  availableModels: AcpModelDescriptor[];
  currentModelId: string;
}

// ============================================================================
// ACP 方法参数和结果类型
// ============================================================================

/** initialize 方法参数 */
export interface AcpInitializeParams {
  protocolVersion: number;
  clientCapabilities: AcpClientCapabilities;
}

/** session/new 方法参数 */
export interface AcpSessionNewParams {
  cwd: string;
  mcpServers: unknown[];
  _meta?: {
    claudeCode?: {
      options?: {
        permissionMode?: string;
      };
    };
  };
}

/** session/new 结果 */
export interface AcpSessionNewResult {
  sessionId: string;
  models: AcpModelsInfo;
}

/** session/prompt 方法参数 */
export interface AcpSessionPromptParams {
  sessionId: string;
  prompt: AcpContentBlock[];
}

/** prompt 完成结果 */
export interface AcpPromptResult {
  stopReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/** 权限请求参数（Agent 发起） */
export interface AcpPermissionRequestParams {
  capability: string;
  path?: string;
}

/** 权限选择结果 */
export interface AcpPermissionOutcome {
  outcome: 'selected';
  optionId: string;
}

/** 权限响应结果 */
export interface AcpPermissionResult {
  outcome: AcpPermissionOutcome;
}

/** session/cancel 方法参数 */
export interface AcpSessionCancelParams {
  sessionId: string;
}

// ============================================================================
// Session Update 通知类型
// ============================================================================

/** Agent 消息块更新 */
export interface AcpAgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  content: AcpContentBlock;
}

/** 工具调用更新 */
export interface AcpToolCallUpdate {
  sessionUpdate: 'tool_call' | 'tool_call_update';
  toolCallId?: string;
  toolName?: string;
  content?: AcpContentBlock;
  state?: string;
}

/** Plan 更新 */
export interface AcpPlanUpdate {
  sessionUpdate: 'plan';
  planId?: string;
  title?: string;
  content?: AcpContentBlock;
}

/** 所有 session update 类型联合 */
export type AcpSessionUpdate =
  | AcpAgentMessageChunkUpdate
  | AcpToolCallUpdate
  | AcpPlanUpdate;

/** session/update 通知参数 */
export interface AcpSessionUpdateParams {
  update: AcpSessionUpdate;
}

// ============================================================================
// ACP 方法名类型
// ============================================================================

/** ACP 方法名字符串字面量 */
export type AcpMethod =
  | 'initialize'
  | 'session/new'
  | 'session/prompt'
  | 'session/cancel'
  | 'session/request_permission';
