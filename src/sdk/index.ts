/**
 * Agent SDK 抽象层 - Re-exported from @disclaude/core
 *
 * @deprecated Import directly from '@disclaude/core' instead.
 */

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
} from '@disclaude/core';

// Export SDK types with legacy aliases (no Sdk prefix)
export type {
  // Content types
  SdkContentBlock as ContentBlock,
  SdkTextContentBlock as TextContentBlock,
  SdkImageContentBlock as ImageContentBlock,
  // Message types
  SdkUserInput as UserInput,
  SdkStreamingUserMessage as StreamingUserMessage,
  SdkStreamingMessageContent as StreamingMessageContent,
  SdkAgentMessage as AgentMessage,
  SdkAgentMessageType as AgentMessageType,
  SdkMessageRole as MessageRole,
  SdkAgentMessageMetadata as AgentMessageMetadata,
  // Tool types
  SdkToolUseBlock as ToolUseBlock,
  SdkToolResultBlock as ToolResultBlock,
  SdkInlineToolDefinition as InlineToolDefinition,
  // MCP types
  StdioMcpServerConfig,
  InlineMcpServerConfig,
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
} from '@disclaude/core';
