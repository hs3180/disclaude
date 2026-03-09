/**
 * Unix Socket IPC Client for cross-process communication.
 *
 * Re-exported from @disclaude/mcp-server for backward compatibility.
 * New code should import directly from '@disclaude/mcp-server'.
 *
 * @deprecated Import from '@disclaude/mcp-server' instead
 * @module ipc/unix-socket-client
 */

export {
  UnixSocketIpcClient,
  getIpcClient,
  resetIpcClient,
  type IpcAvailabilityStatus,
  type IpcUnavailableReason,
} from '@disclaude/mcp-server';
