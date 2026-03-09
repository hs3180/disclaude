/**
 * IPC Client exports
 *
 * @module mcp-server/ipc-client
 */

export {
  UnixSocketIpcClient,
  getIpcClient,
  resetIpcClient,
  type IpcAvailabilityStatus,
  type IpcUnavailableReason,
} from './unix-socket-client.js';
