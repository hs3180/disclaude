/**
 * IPC Module for Worker Node.
 *
 * Provides IPC server and bridge functionality for MCP Server communication.
 *
 * @module worker-node/ipc
 */

export {
  WorkerIpcServer,
  type WorkerIpcServerConfig,
  type IpcRequestHandler,
} from './worker-ipc-server.js';

export {
  createIpcToWsBridge,
  type IpcToWsBridgeConfig,
} from './ipc-to-ws-bridge.js';
