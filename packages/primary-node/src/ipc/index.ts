/**
 * IPC module for cross-process communication.
 *
 * This module provides Unix Socket based IPC for parameter passing between
 * processes (Feishu API ops, sendInteractive).
 *
 * Issue #1573 (Phase 4): InteractiveMessageHandlers removed — state management
 * now lives in Primary Node's InteractiveContextStore.
 *
 * @module ipc
 *
 * @see Issue #1041 - IPC implementations migrated to @disclaude/core
 */

// Re-export types and constants from @disclaude/core
export {
  DEFAULT_IPC_CONFIG,
  type IpcConfig,
  type IpcRequestType,
  type IpcRequestPayloads,
  type IpcResponsePayloads,
  type IpcRequest,
  type IpcResponse,
} from '@disclaude/core';

// Re-export server and client implementations from @disclaude/core
export {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  getIpcClient,
  resetIpcClient,
  createInteractiveMessageHandler,
  type IpcRequestHandler,
  type FeishuApiHandlers,
  type FeishuHandlersContainer,
  type IpcAvailabilityStatus,
  type IpcUnavailableReason,
} from '@disclaude/core';
