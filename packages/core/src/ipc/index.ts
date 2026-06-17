/**
 * IPC exports
 *
 * @module core/ipc
 */

// Protocol types and constants
export {
  DEFAULT_IPC_CONFIG,
  IPC_SOCKET_PATH_FILE,
  generateSocketPath,
  type IpcConfig,
  type IpcRequestType,
  type IpcRequestPayloads,
  type IpcResponsePayloads,
  type IpcRequest,
  type IpcResponse,
} from './protocol.js';

// Transport interfaces (Issue #2352)
export {
  type IpcConnectionLike,
  type IIpcServerTransport,
  type IpcClientTransportHandlers,
  type IIpcClientTransport,
} from './transport.js';

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

// Client implementation (connection lifecycle only)
export {
  UnixSocketIpcClient,
  type IpcAvailabilityStatus,
  type IpcUnavailableReason,
} from './unix-socket-client.js';

// Client facade (protocol convenience methods)
export {
  sendMessage,
  sendCard,
  uploadFile,
  uploadImage,
  sendInteractive,
  listTempChats,
  markChatResponded,
  pushToAgent,
  type IpcMethodErrorType,
  type IpcMethodResult,
  type IpcClientLike,
} from './ipc-client-facade.js';

// IPC utilities (singleton, socket path, etc.)
export {
  getIpcClient,
  getIpcSocketPath,
  resetIpcClient,
  type GetIpcSocketPathOptions,
} from './ipc-utils.js';
