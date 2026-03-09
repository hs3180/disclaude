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
} from './websocket-messages.js';

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
