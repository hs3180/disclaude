/**
 * @disclaude/core
 *
 * Shared core utilities, types, and interfaces for disclaude.
 *
 * This package contains:
 * - Type definitions (platform, websocket, file)
 * - Constants (deduplication, dialogue, api config)
 * - Utility functions (logger, error-handler, retry)
 * - IPC Protocol (shared between Primary Node and MCP Server)
 * - Agent SDK abstraction layer
 */

// Types (extended types for application-level use)
export * from './types/index.js';

// Constants
export * from './constants/index.js';

// Utils
export * from './utils/index.js';

// IPC Protocol (shared between Primary Node and MCP Server)
export * from './ipc/index.js';

// Config (exports McpServerConfig for config)
export * from './config/index.js';

// Agent SDK - ACP Client (Issue #2312: removed old Provider abstraction)
export {
  AcpClient,
  AcpStdioTransport,
} from './sdk/index.js';

// Export SDK types with Sdk prefix to avoid conflicts with extended types
export type {
  // Content types
  ContentBlock as SdkContentBlock,
  TextContentBlock as SdkTextContentBlock,
  ImageContentBlock as SdkImageContentBlock,
  // Message types
  UserInput as SdkUserInput,
  StreamingUserMessage as SdkStreamingUserMessage,
  StreamingMessageContent as SdkStreamingMessageContent,
  AgentMessage as SdkAgentMessage,
  AgentMessageType as SdkAgentMessageType,
  MessageRole as SdkMessageRole,
  AgentMessageMetadata as SdkAgentMessageMetadata,
  // Tool types
  ToolUseBlock as SdkToolUseBlock,
  ToolResultBlock as SdkToolResultBlock,
  // MCP types
  StdioMcpServerConfig,
  McpServerConfig as SdkMcpServerConfig,
  // Query types
  AgentQueryOptions,
  PermissionMode,
  QueryHandle,
  // Stats types
  QueryUsageStats,
} from './sdk/index.js';

// Agent Infrastructure (Issue #1040, Issue #1501: Simplified to ChatAgent-only)
// Types and interfaces
export {
  // Core agent types
  type Disposable,
  type UserInput as AgentUserInput,
  type ChatAgent,
  type AgentProvider,
  type BaseAgentConfig,
  type ChatAgentConfig,
  type AgentConfig,
  type AgentFactoryInterface,
  // Type guards
  isChatAgent,
  isDisposable,
  // Runtime context
  type AgentRuntimeContext,
  setRuntimeContext,
  getRuntimeContext,
  hasRuntimeContext,
  clearRuntimeContext,
} from './agents/types.js';

// Message channel
export { MessageChannel } from './agents/message-channel.js';

// Session management
export {
  type PilotSession,
  type ChatAgentSession,
  type SessionManagerConfig,
  SessionManager,
} from './agents/session-manager.js';

// Conversation context
export {
  type MessageContext,
  type ConversationContextConfig,
  ConversationContext,
} from './agents/conversation-context.js';

// Restart manager
export {
  type RestartManagerConfig,
  type RestartDecision,
  RestartManager,
} from './agents/restart-manager.js';

// Agent pool
export {
  type ChatAgentFactory,
  type AgentPoolConfig,
  AgentPool,
} from './agents/agent-pool.js';

// Base Agent
export {
  type SdkOptionsExtra,
  type IteratorYieldResult,
  type QueryStreamResult,
  BaseAgent,
} from './agents/base-agent.js';

// Message Builder (Issue #1492: extracted from worker-node to core)
export {
  MessageBuilder,
  buildChatHistorySection,
  buildPersistedHistorySection,
  buildNextStepGuidance,
  buildOutputFormatGuidance,
  buildLocationAwarenessGuidance,
  type MessageData,
  type MessageBuilderContext,
  type MessageBuilderOptions,
} from './agents/message-builder/index.js';

// Skills module (Issue #430)
export {
  type DiscoveredSkill,
  type SkillSearchPath,
  getDefaultSearchPaths,
  findSkill,
  listSkills,
  skillExists,
  readSkillContent,
} from './skills/index.js';

// Conversation module (Issue #1041)
export {
  MessageQueue,
  ConversationSessionManager,
  ConversationOrchestrator,
  SessionTimeoutManager,
  type ConversationOrchestratorConfig,
  type ConversationSessionManagerConfig,
  type QueuedMessage,
  type SessionState,
  type SessionCallbacks,
  type CreateSessionOptions,
  type ProcessMessageResult,
  type SessionStats,
  type ConversationMessageContext,
  type SessionTimeoutCallbacks,
  type TimeoutCheckResult,
  type ResolvedTimeoutConfig,
} from './conversation/index.js';

// Scheduling module (Issue #1041, Issue #1382)
export {
  CooldownManager,
  type CooldownManagerOptions,
  // Issue #1703: Temp chat lifecycle management
  ChatStore,
  type ChatStoreOptions,
  type TempChatRecord,
  type TempChatResponse,
  type RegisterTempChatOptions,
  // Issue #1041: Full schedule module migrated from worker-node
  ScheduleFileScanner,
  ScheduleFileWatcher,
  ScheduleManager,
  Scheduler,
  type ScheduledTask,
  type ScheduleFileTask,
  type ScheduleFileScannerOptions,
  type ScheduleFileWatcherOptions,
  type ScheduleManagerOptions,
  type SchedulerCallbacks,
  type TaskExecutor,
  type SchedulerOptions,
  type OnFileAdded,
  type OnFileChanged,
  type OnFileRemoved,
  // Issue #1382: Unified schedule executor
  createScheduleExecutor,
  type ScheduleAgent,
  type ScheduleAgentFactory,
  type ScheduleExecutorOptions,
} from './scheduling/index.js';

// Task module (Issue #1041 - migrated from worker-node)
export type {
  TaskDefinitionDetails,
} from './task/index.js';

export {
  DialogueMessageTracker,
  TaskTracker,
  TaskFileManager,
  type TaskFileManagerConfig,
} from './task/index.js';

// Queue module (Issue #1041)
export {
  TaskQueue,
  type Task,
  type BaseTaskOptions,
  type TaskStatus,
  type TaskPriority,
  type TaskDependency,
  type TaskResult,
} from './queue/index.js';

// Messaging module (Issue #515 Phase 2 - migrated from primary-node)
export type {
  TextContent,
  MarkdownContent,
  CardContent,
  FileContent,
  DoneContent,
  CardSection,
  CardAction,
  CardSectionType,
  CardActionType,
  MessageContent,
  UniversalMessage,
  UniversalMessageMetadata,
  SendResult,
} from './messaging/index.js';

export {
  isTextContent,
  isMarkdownContent,
  isCardContent,
  isFileContent,
  isDoneContent,
  createTextMessage,
  createMarkdownMessage,
  createCardMessage,
  createDoneMessage,
} from './messaging/index.js';

// Channels module (Issue #1041 - migrated from primary-node)
export { BaseChannel } from './channels/index.js';

// Channel Registry (Issue #1553)
export {
  ChannelRegistry,
  ChannelRegistryError,
} from './channels/index.js';

// Dynamic channel registration (Issue #1422)
export {
  ChannelLoader,
  addChannel,
  removeChannel,
  setChannelEnabled,
  getChannel as getDynamicChannel,
  listChannels as listDynamicChannels,
  resolveChannelsDir,
  resolveChannelDir,
  resolveChannelConfigPath,
  validateChannelId,
  parseChannelConfig,
  serializeChannelConfig,
} from './channels/index.js';

// File module (Issue #1041 - migrated from worker-node)
export { AttachmentManager, attachmentManager } from './file/index.js';

// Control module - unified control command handling
export {
  createControlHandler,
  commandRegistry,
  getHandler,
  type ControlHandlerContext,
  type CommandHandler,
  type CommandDefinition,
  type ExecNodeInfo,
  type DebugGroup,
} from './control/index.js';

// Polling module (Issue #2191: lightweight poll/survey functionality)
export {
  PollManager,
} from './polling/index.js';

export type {
  Poll,
  PollOption,
  PollVote,
  PollOptionResult,
  PollResults,
  CreatePollOptions,
  RecordVoteOptions,
  PollValidationError,
} from './polling/index.js';
