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

// Transport abstraction (Issue #2352)
export {
  type IIpcTransport,
  createInMemoryTransportPair,
} from './transport.js';
