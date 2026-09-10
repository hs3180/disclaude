/** Channel API exports: HTTP client, typed requests, method helpers, and channel handlers. */

// Protocol types
export {
  type ChannelApiRequestType,
  type ChannelApiRequestPayloads,
  type ChannelApiResponsePayloads,
} from './protocol.js';

// Channel API handler contracts
export {
  type ChannelApiHandlers,
  type ChannelHandlersContainer,
  type FeishuApiHandlers,
  type FeishuHandlersContainer,
} from './channel-api-handlers.js';

// REST API client (Issue #4279 Phase 2 — channel-method surface via HTTP)
export {
  ChannelApiClient,
  normalizeChannelApiBaseUrl,
  type ChannelApiClientOptions,
} from './client.js';

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
  type ChannelApiMethodErrorType,
  type ChannelApiMethodResult,
  type ChannelApiClientLike,
} from './client-methods.js';
