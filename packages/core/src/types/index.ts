/**
 * Core type definitions for disclaude.
 */

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
  FeishuApiAction,
  FeishuApiRequestMessage,
  FeishuApiResponseMessage,
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
} from './channel.js';

export { DEFAULT_CHANNEL_CAPABILITIES } from './channel.js';

// IPC types (Issue #1040)
export type {
  IpcRequestType,
  IpcRequestPayloads,
  IpcResponsePayloads,
  IpcRequest,
  IpcResponse,
  IpcConfig,
} from './ipc.js';

export { DEFAULT_IPC_CONFIG } from './ipc.js';

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

// Worker Node types (Issue #1041)
export type { WorkerNodeConfig } from './worker-node.js';

export { getWorkerNodeCapabilities } from './worker-node.js';
