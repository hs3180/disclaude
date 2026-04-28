/**
 * Core type definitions for disclaude.
 */

// Message level types (Issue #1040, Issue #1041)
export {
  MessageLevel,
  DEFAULT_USER_LEVELS,
  ALL_LEVELS,
  // Routing types
  type RoutedMessage,
  type RoutedMessageMetadata,
  type MessageRouteConfig,
  type IMessageRouter,
  type IMessageSender as IMessageRoutingSender,
  mapAgentMessageTypeToLevel,
} from './messaging.js';

// Agent types (Issue #1040) - Extended types for application-level use
export type {
  ContentBlock,
  ExtendedAgentMessageMetadata,
  AgentMessage,
  AgentOptions,
  AgentInput,
  ExtendedAgentMessageType,
} from './agent.js';

// Backward-compatible type aliases
export type {
  ExtendedAgentMessageMetadata as AgentMessageMetadata,
  ExtendedAgentMessageType as AgentMessageType,
} from './agent.js';

// Re-export SDK types for backward compatibility
export type {
  StreamingUserMessage,
  UserInput,
} from '../sdk/types.js';

// File transfer types
export type {
  FileRef,
  InboundAttachment,
  OutboundFile,
  FileUploadRequest,
  FileUploadResponse,
  FileDownloadResponse,
  StoredFile,
} from './file.js';

export { createFileRef, createInboundAttachment, createOutboundFile } from './file.js';

// Platform types (Feishu-specific)
export type {
  FeishuCard,
  FeishuMessageEvent,
  FeishuEventData,
  FeishuCardActionEvent,
  FeishuCardActionEventData,
  InteractionContext,
  InteractionHandler,
  FeishuChatMemberAddedEvent,
  FeishuChatMemberAddedEventData,
  FeishuP2PChatEnteredEvent,
  FeishuP2PChatEnteredEventData,
} from './platform.js';

// WebSocket message types
export type {
  PromptMessage,
  CommandMessage,
  RegisterMessage,
  ExecNodeInfo,
  FeedbackMessage,
  CardActionMessage,
  CardContextMessage,
} from './websocket-messages.js';

// Channel types (Issue #1040)
export type {
  IncomingMessage,
  OutgoingMessage,
  OutgoingContentType,
  MessageAttachment,
  ControlCommand,
  ControlCommandType,
  ControlResponse,
  ChannelStatus,
  MessageHandler,
  ControlHandler,
  IChannel,
  ChannelConfig,
  ChannelFactory,
  ChannelCapabilities,
  ChannelDescriptor,
} from './channel.js';

export { DEFAULT_CHANNEL_CAPABILITIES } from './channel.js';

// Dynamic Channel Plugin types (Issue #1422)
export type {
  ChannelPluginManifest,
  DynamicChannelEntry,
  ChannelLoaderOptions,
  AddChannelOptions,
  ChannelListResult,
} from './channel-plugin.js';

export {
  SAFE_CHANNEL_ID_PATTERN,
  RESERVED_CHANNEL_IDS,
} from './channel-plugin.js';

// Primary Node types (Issue #1040)
export type {
  NodeType,
  NodeCapabilities,
  BaseNodeConfig,
  RestChannelConfig,
  FileStorageConfig,
  PrimaryNodeConfig,
  ExecNodeInfo as PrimaryNodeExecInfo,
} from './primary-node.js';

export { getNodeCapabilities } from './primary-node.js';

// Adapter types (Issue #1040)
export type {
  FileAttachment,
  FileHandlerResult,
  IMessageSender,
  IFileHandler,
  IAttachmentManager,
  IPlatformAdapter,
} from './adapter.js';
