/**
 * IPC exports
 *
 * Issue #4168 (Phase 3 residual): the Unix-socket transport is removed —
 * `unix-socket-server.ts` / `unix-socket-client.ts` / `transport.ts` and the
 * `getIpcClient` / `getIpcSocketPath` facade in `ipc-utils.ts` had zero
 * production consumers after the REST-only migration (#4280 parts 1–5,
 * #4543, #4547, #4566). What remains is the REST IPC surface: the wire
 * protocol types (`protocol.ts`), the REST client (`rest-ipc-client.ts`),
 * the protocol convenience facade (`ipc-client-facade.ts`), and the live
 * channel-handler contracts extracted from the deleted server file
 * (`channel-api-handlers.ts`).
 *
 * @module core/ipc
 */

// Protocol types
export {
  type IpcRequestType,
  type IpcRequestPayloads,
  type IpcResponsePayloads,
} from './protocol.js';

// Channel API handler contracts (live surface, extracted from the removed
// Unix-socket server — see channel-api-handlers.ts)
export {
  type ChannelApiHandlers,
  type ChannelHandlersContainer,
  type FeishuApiHandlers,
  type FeishuHandlersContainer,
} from './channel-api-handlers.js';

// REST IPC client (Issue #4279 Phase 2 — channel-method surface via HTTP)
export { RestIpcClient, type RestIpcClientOptions } from './rest-ipc-client.js';

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
