/** Channel API exports: HTTP client, typed requests, method helpers, and channel handlers. */
// REST API client (Issue #4279 Phase 2 — channel-method surface via HTTP)
export { ChannelApiClient, normalizeChannelApiBaseUrl, } from './client.js';
// Client facade (protocol convenience methods)
export { sendMessage, sendCard, uploadFile, uploadImage, sendInteractive, listTempChats, markChatResponded, pushToAgent, } from './client-methods.js';
