/**
 * IPC module for cross-process communication.
 *
 * Issue #4168 (Phase 3 residual): REST is the only IPC transport — the
 * Unix-socket server/client, their transport interfaces, and the
 * `getIpcClient` facade are removed from @disclaude/core. What this module
 * re-exports is the surviving surface: the protocol payload types (mirrored
 * by the REST routes) and the channel-handler contracts the REST-facing
 * PrimaryNode methods route through.
 *
 * @module ipc
 *
 * @see Issue #1041 - IPC implementations migrated to @disclaude/core
 */

// Re-export protocol types from @disclaude/core
export {
  type IpcRequestType,
  type IpcRequestPayloads,
  type IpcResponsePayloads,
} from '@disclaude/core';

// Re-export the live channel-handler contracts from @disclaude/core
export {
  type ChannelApiHandlers,
  type ChannelHandlersContainer,
  type FeishuApiHandlers,
  type FeishuHandlersContainer,
} from '@disclaude/core';
