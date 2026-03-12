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

// Agent SDK abstraction layer (Issue #1040)
// Export SDK functions and classes
export {
  // Provider
  ClaudeSDKProvider,
  // Factory functions
  getProvider,
  registerProvider,
  registerProviderClass,
  setDefaultProvider,
  getDefaultProviderType,
  getAvailableProviders,
  clearProviderCache,
  isProviderAvailable,
  type ProviderType,
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
  InlineToolDefinition as SdkInlineToolDefinition,
  // MCP types
  StdioMcpServerConfig,
  InlineMcpServerConfig,
  McpServerConfig as SdkMcpServerConfig,
  // Query types
  AgentQueryOptions,
  PermissionMode,
  QueryHandle,
  StreamQueryResult,
  // Stats types
  QueryUsageStats,
  ProviderInfo,
  // Interfaces
  IAgentSDKProvider,
  ProviderFactory,
  ProviderConstructor,
} from './sdk/index.js';

// Agent Infrastructure (Issue #1040)
// Types and interfaces
export {
  // Core agent types
  type Disposable,
  type UserInput as AgentUserInput,
  type ChatAgent,
  type SkillAgent,
  type Subagent,
  type AgentProvider,
  type BaseAgentConfig,
  type ChatAgentConfig,
  type SkillAgentConfig,
  type SubagentConfig,
  type AgentConfig,
  type AgentFactoryInterface,
  // Type guards
  isChatAgent,
  isSkillAgent,
  isSubagent,
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

// Skill Agent
export {
  type SkillAgentExecuteOptions,
  SkillAgent as SkillAgentBase,
} from './agents/skill-agent.js';
