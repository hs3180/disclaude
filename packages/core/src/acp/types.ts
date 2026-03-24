/**
 * ACP (Agent Client Protocol) 类型定义
 *
 * 基于 ACP 协议规范（https://agentclientprotocol.com/），
 * 提供与 ACP 协议相关的类型定义。
 *
 * 此模块重新导出 @agentclientprotocol/sdk 中的核心类型，
 * 并定义 disclaude 特有的 ACP 扩展类型。
 *
 * @module acp/types
 * @see https://agentclientprotocol.com/
 */

// ============================================================================
// 从 ACP SDK 导入本地使用的类型
// ============================================================================

import type {
  McpServer,
  SessionId,
  SessionNotification,
} from '@agentclientprotocol/sdk';

// ============================================================================
// 从 ACP SDK 重新导出核心协议类型
// ============================================================================

export type {
  // 协议基础
  ProtocolVersion,
  Implementation,
  ErrorCode,
  Error,
  RequestId,

  // 初始化
  InitializeRequest,
  InitializeResponse,
  ClientCapabilities,
  AgentCapabilities,
  PromptCapabilities,
  McpCapabilities,
  McpServer,
  McpServerStdio,
  McpServerHttp,
  McpServerSse,
  FileSystemCapabilities,
  AuthCapabilities,
  AuthMethod,
  AuthMethodAgent,
  AuthMethodEnvVar,
  AuthMethodTerminal,
  AuthEnvVar,
  AuthenticateRequest,
  AuthenticateResponse,

  // 会话
  SessionId,
  NewSessionRequest,
  NewSessionResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  SessionInfo,
  SessionCapabilities,
  SessionListCapabilities,
  SessionForkCapabilities,
  SessionResumeCapabilities,
  SessionCloseCapabilities,
  ForkSessionRequest,
  ForkSessionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  CloseSessionRequest,
  CloseSessionResponse,

  // 模式和配置
  SessionMode,
  SessionModeId,
  SessionModeState,
  CurrentModeUpdate,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SessionConfigOption,
  SessionConfigOptionCategory,
  SessionConfigBoolean,
  SessionConfigSelect,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  SessionConfigSelectOptions,
  SessionConfigGroupId,
  SessionConfigId,
  SessionConfigValueId,
  ConfigOptionUpdate,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  ModelId,
  ModelInfo,
  SessionModelState,
  SetSessionModelRequest,
  SetSessionModelResponse,

  // Prompt 和内容
  PromptRequest,
  PromptResponse,
  StopReason,
  Content,
  ContentBlock,
  TextContent,
  ImageContent,
  AudioContent,
  Diff,
  EmbeddedResource,
  ResourceLink,
  Role,
  Annotations,

  // 工具调用
  ToolCall,
  ToolCallId,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
  PermissionOption,
  PermissionOptionId,
  PermissionOptionKind,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SelectedPermissionOutcome,

  // 计划
  Plan,
  PlanEntry,
  PlanEntryPriority,
  PlanEntryStatus,

  // 会话更新和通知
  SessionUpdate,
  SessionNotification,
  SessionInfoUpdate,
  ContentChunk,
  AvailableCommandsUpdate,
  AvailableCommand,
  AvailableCommandInput,
  UnstructuredCommandInput,
  UsageUpdate,
  Usage,
  Cost,

  // 终端
  Terminal,
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalExitStatus,

  // 文件系统
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  TextResourceContents,
  BlobResourceContents,

  // 取消
  CancelNotification,
  CancelRequestNotification,

  // 扩展
  ExtRequest,
  ExtResponse,
  ExtNotification,
} from '@agentclientprotocol/sdk';

// ============================================================================
// disclaude 特有的 ACP 扩展类型
// ============================================================================

/**
 * ACP Agent 信息
 *
 * 扩展了 ACP 协议中的 Implementation 类型，
 * 添加 disclaude 特有的可用性检查。
 */
export interface AcpAgentInfo {
  /** Agent 名称 */
  name: string;
  /** Agent 版本 */
  version: string;
  /** 是否可用 */
  available: boolean;
  /** 不可用原因 */
  unavailableReason?: string;
}

/**
 * ACP Provider 类型标识
 */
export type AcpProviderType = 'claude-acp' | string;

/**
 * ACP 会话配置
 *
 * disclaude 特有的会话创建配置，
 * 封装 ACP NewSessionRequest 的常用参数。
 */
export interface AcpSessionConfig {
  /** 工作目录 */
  cwd?: string;
  /** 环境变量 */
  env?: Record<string, string | undefined>;
  /** MCP 服务器配置 */
  mcpServers?: Record<string, McpServer>;
  /** 权限模式 */
  permissionMode?: string;
  /** 设置来源（Claude Code 设置文件路径） */
  settingSources?: string[];
  /** 模型 */
  model?: string;
}

/**
 * ACP 连接配置
 *
 * 配置如何建立 ACP 连接（stdio、SSE 等）。
 */
export interface AcpConnectionConfig {
  /** 连接类型 */
  type: 'stdio' | 'sse' | 'inline';
  /** Agent 命令（stdio 模式） */
  command?: string;
  /** Agent 参数（stdio 模式） */
  args?: string[];
  /** Agent 环境变量（stdio 模式） */
  env?: Record<string, string>;
  /** Agent URL（SSE 模式） */
  url?: string;
}

/**
 * ACP 流式消息
 *
 * 将 ACP SessionNotification 转换为 disclaude 内部使用的消息格式。
 * 用于在 ACP 协议层和上层业务之间传递消息。
 */
export interface AcpStreamEvent {
  /** 事件类型 */
  type: 'content' | 'tool_call' | 'tool_update' | 'plan' | 'usage' | 'session_info' | 'mode_update' | 'config_update' | 'error';
  /** 会话 ID */
  sessionId: SessionId;
  /** 原始 ACP 通知 */
  raw: SessionNotification;
}
