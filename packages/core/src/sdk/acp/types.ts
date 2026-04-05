/**
 * ACP (Agent Communication Protocol) 类型定义
 *
 * 定义 ACP 协议的方法、参数和返回值类型。
 * ACP 基于 JSON-RPC 2.0，提供 Agent 与客户端之间的标准化通信接口。
 *
 * @see https://agentclientprotocol.com/
 * @module acp/types
 */

import type { JsonRpcNotification, JsonRpcRequest } from './json-rpc.js';

// ============================================================================
// ACP 能力声明
// ============================================================================

/** 客户端能力声明 */
export interface AcpClientCapabilities {
  /** 支持的 ACP 版本列表 */
  protocolVersion?: string[];
  /** 是否支持流式输出 */
  streaming?: boolean;
  /** 是否支持后台任务 */
  backgroundTasks?: boolean;
  /** 是否支持 Prompt 队列 */
  promptQueue?: boolean;
}

/** 服务端能力声明 */
export interface AcpServerCapabilities {
  /** 支持的 ACP 版本列表 */
  protocolVersion?: string[];
  /** 支持的会话功能 */
  sessions?: {
    /** 是否支持加载历史会话 */
    loadSession?: boolean;
    /** 是否支持分叉会话 */
    forkSession?: boolean;
    /** 是否支持恢复会话 */
    resumeSession?: boolean;
  };
  /** 支持的工具类型 */
  toolCallContentTypes?: string[];
}

// ============================================================================
// ACP 初始化
// ============================================================================

/** initialize 方法参数 */
export interface AcpInitializeParams {
  /** 客户端信息 */
  clientInfo: {
    name: string;
    version: string;
  };
  /** 客户端能力 */
  capabilities: AcpClientCapabilities;
}

/** initialize 方法返回值 */
export interface AcpInitializeResult {
  /** 服务端信息 */
  serverInfo: {
    name: string;
    version: string;
  };
  /** 服务端能力 */
  capabilities: AcpServerCapabilities;
}

// ============================================================================
// ACP 会话管理
// ============================================================================

/** newSession 方法参数 */
export interface AcpNewSessionParams {
  /** 可选的会话元数据 */
  metadata?: Record<string, unknown>;
}

/** newSession 方法返回值 */
export interface AcpNewSessionResult {
  /** 会话 ID */
  sessionId: string;
}

/** listSessions 方法参数 */
export interface AcpListSessionsParams {
  /** 可选的过滤条件 */
  filter?: {
    /** 限制返回数量 */
    limit?: number;
  };
}

/** listSessions 方法返回值 */
export interface AcpListSessionsResult {
  /** 会话列表 */
  sessions: Array<{
    sessionId: string;
    createdAt?: string;
    metadata?: Record<string, unknown>;
  }>;
}

/** loadSession 方法参数 */
export interface AcpLoadSessionParams {
  /** 要加载的会话 ID */
  sessionId: string;
}

/** loadSession 方法返回值 */
export interface AcpLoadSessionResult {
  /** 会话 ID */
  sessionId: string;
  /** 会话消息数量 */
  messageCount: number;
}

/** closeSession 方法参数 */
export interface AcpCloseSessionParams {
  /** 要关闭的会话 ID */
  sessionId: string;
}

/** closeSession 方法返回值 */
export interface AcpCloseSessionResult {
  /** 是否成功关闭 */
  closed: boolean;
}

// ============================================================================
// ACP Prompt（核心交互）
// ============================================================================

/** ACP 内容块类型 */
export type AcpContentBlockType = 'text' | 'image' | 'tool_use' | 'tool_result' | 'diff' | 'terminal';

/** ACP 文本内容块 */
export interface AcpTextContent {
  type: 'text';
  text: string;
}

/** ACP 工具调用内容块 */
export interface AcpToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input?: unknown;
}

/** ACP 工具结果内容块 */
export interface AcpToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/** ACP 内容块联合类型 */
export type AcpContentBlock = AcpTextContent | AcpToolUseContent | AcpToolResultContent;

/** ACP 用户消息 */
export interface AcpUserMessage {
  role: 'user';
  content: string | AcpContentBlock[];
}

/** ACP 助手消息 */
export interface AcpAssistantMessage {
  role: 'assistant';
  content: AcpContentBlock[];
}

/** prompt 方法参数 */
export interface AcpPromptParams {
  /** 会话 ID */
  sessionId: string;
  /** 用户消息 */
  message: AcpUserMessage;
  /** 是否启用流式输出 */
  stream?: boolean;
}

/** prompt 停止原因 */
export type AcpStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'cancelled';

/** prompt 使用统计 */
export interface AcpUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalCost?: number;
}

/** prompt 方法返回值（非流式） */
export interface AcpPromptResult {
  /** 停止原因 */
  stopReason: AcpStopReason;
  /** 使用统计 */
  usage: AcpUsage;
}

// ============================================================================
// ACP 通知（服务端 → 客户端）
// ============================================================================

/** sessionUpdate 通知参数 */
export interface AcpSessionUpdateParams {
  /** 会话 ID */
  sessionId: string;
  /** 更新类型 */
  update: AcpContentBlock | AcpUsage | {
    type: 'stop';
    stopReason: AcpStopReason;
    usage: AcpUsage;
  };
}

// ============================================================================
// ACP 方法名常量
// ============================================================================

/** ACP 协议方法名 */
export const AcpMethod = {
  Initialize: 'initialize',
  NewSession: 'newSession',
  ListSessions: 'listSessions',
  LoadSession: 'loadSession',
  CloseSession: 'closeSession',
  Prompt: 'prompt',
  /** 通知方法 */
  SessionUpdate: 'sessionUpdate',
} as const;

/** ACP 方法名类型 */
export type AcpMethodName = (typeof AcpMethod)[keyof typeof AcpMethod];

// ============================================================================
// ACP 类型守卫
// ============================================================================

/** 检查消息是否为 ACP 初始化请求 */
export function isAcpInitializeRequest(
  msg: JsonRpcRequest
): msg is JsonRpcRequest & { params: AcpInitializeParams } {
  return msg.method === AcpMethod.Initialize;
}

/** 检查通知是否为 sessionUpdate */
export function isAcpSessionUpdateNotification(
  msg: JsonRpcNotification
): msg is JsonRpcNotification & { params: AcpSessionUpdateParams } {
  return msg.method === AcpMethod.SessionUpdate;
}
