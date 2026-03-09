/**
 * @disclaude/primary-node
 *
 * Primary Node process for disclaude.
 *
 * This package contains:
 * - Channels (Feishu, REST, Ruliu)
 * - PrimaryNode implementation
 * - Platform adapters
 * - IPC server
 * - WebSocket server
 *
 * @see Issue #1040 - Separate Primary Node code to @disclaude/primary-node
 */

// Re-export types from @disclaude/core
export type {
  // Node types
  NodeType,
  NodeCapabilities,
  BaseNodeConfig,
  PrimaryNodeConfig,
  PrimaryNodeExecInfo,
  RestChannelConfig,
  FileStorageConfig,

  // Channel types
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

  // IPC types
  IpcRequestType,
  IpcRequestPayloads,
  IpcResponsePayloads,
  IpcRequest,
  IpcResponse,
  IpcConfig,

  // WebSocket message types
  PromptMessage,
  CommandMessage,
  RegisterMessage,
  FeedbackMessage,
  CardActionMessage,
  CardContextMessage,
  ExecNodeInfo,
} from '@disclaude/core';

// Re-export constants and utilities from @disclaude/core
export {
  getNodeCapabilities,
  DEFAULT_CHANNEL_CAPABILITIES,
  DEFAULT_IPC_CONFIG,
  createLogger,
} from '@disclaude/core';

// Channel base class
export { BaseChannel } from './channels/base-channel.js';

// IPC module
export {
  // Types re-exported above
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  getIpcClient,
  resetIpcClient,
  createInteractiveMessageHandler,
  type IpcRequestHandler,
  type InteractiveMessageHandlers,
  type FeishuApiHandlers,
  type FeishuHandlersContainer,
  type IpcAvailabilityStatus,
  type IpcUnavailableReason,
} from './ipc/index.js';

// Version
export const PRIMARY_NODE_VERSION = '0.0.1';
