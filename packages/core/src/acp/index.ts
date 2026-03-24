/**
 * ACP (Agent Client Protocol) 模块
 *
 * 提供基于 ACP 协议的 Agent 抽象层。
 * ACP 是由 Zed Industries 推出的开放标准协议，
 * 用于 AI Agent 与编辑器/客户端之间的标准化通信。
 *
 * ## 目录结构
 *
 * ```
 * packages/core/src/acp/
 * ├── index.ts          # 本文件 - 公开导出
 * ├── types.ts          # ACP 协议类型定义和扩展
 * └── interface.ts      # IAcpAgent 接口定义
 * ```
 *
 * ## 与现有 SDK 模块的关系
 *
 * ```
 * 现有架构（IAgentSDKProvider）          新架构（IAcpAgent）
 * ┌──────────────────────────┐         ┌──────────────────────────┐
 * │ IAgentSDKProvider        │         │ IAcpAgent                │
 * │   ├── queryOnce()        │         │   ├── initialize()       │
 * │   ├── queryStream()      │         │   ├── newSession()       │
 * │   ├── createInlineTool() │         │   ├── prompt()           │
 * │   └── createMcpServer()  │         │   ├── loadSession()      │
 * │                          │         │   ├── forkSession()      │
 * │ ClaudeSDKProvider        │         │   └── resumeSession()    │
 * └──────────────────────────┘         └──────────────────────────┘
 * ```
 *
 * ## 使用示例
 *
 * ```typescript
 * import { getAcpAgent, type IAcpAgent } from '@disclaude/core';
 *
 * // 获取 ACP Agent
 * const agent = getAcpAgent('claude-acp');
 *
 * // 初始化
 * const result = await agent.initialize({
 *   protocolVersion: '2025-04-08',
 *   clientInfo: { name: 'disclaude', version: '1.0.0' },
 * });
 *
 * // 创建会话并发送提示
 * const session = await agent.newSession({
 *   sessionId: crypto.randomUUID(),
 * });
 *
 * const promptResult = await agent.prompt({
 *   sessionId: session.sessionId,
 *   messages: [{ role: 'user', content: 'Hello!' }],
 * });
 * ```
 *
 * @module acp
 * @see https://agentclientprotocol.com/
 * @see Issue #1435 - 用 ACP 协议替代现有 SDK Provider 抽象
 */

// ============================================================================
// ACP 协议类型导出
// ============================================================================

export type {
  // 协议基础
  ProtocolVersion,
  Implementation,
  ErrorCode,
  Error as AcpError,
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
} from './types.js';

// disclaude 特有的 ACP 扩展类型
export type {
  AcpAgentInfo,
  AcpProviderType,
  AcpSessionConfig,
  AcpConnectionConfig,
  AcpStreamEvent,
} from './types.js';

// ============================================================================
// 接口导出
// ============================================================================

export type {
  IAcpAgent,
  AcpAgentFactory,
  AcpAgentConstructor,
} from './interface.js';
