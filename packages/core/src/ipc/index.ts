/**
 * IPC exports
 *
 * @module core/ipc
 */

// Protocol types and constants
export {
  DEFAULT_IPC_CONFIG,
  generateSocketPath,
  type IpcConfig,
  type IpcRequestType,
  type IpcRequestPayloads,
  type IpcResponsePayloads,
  type IpcRequest,
  type IpcResponse,
} from './protocol.js';

// Server implementation
export {
  UnixSocketIpcServer,
  createInteractiveMessageHandler,
  type IpcRequestHandler,
  type ChannelApiHandlers,
  type ChannelHandlersContainer,
  type FeishuApiHandlers,
  type FeishuHandlersContainer,
} from './unix-socket-server.js';

// Client implementation
export {
  UnixSocketIpcClient,
  getIpcClient,
  getIpcSocketPath,
  resetIpcClient,
  type IpcAvailabilityStatus,
  type IpcUnavailableReason,
} from './unix-socket-client.js';

// Transport abstractions (Issue #2352)
export {
  type IIpcConnection,
  type IIpcServerTransport,
  type IIpcClientTransport,
  InMemoryIpcServerTransport,
  InMemoryIpcClientTransport,
} from './transport.js';
