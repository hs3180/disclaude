/**
 * WeChat Channel module exports.
 *
 * @module channels/wechat
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1557 - WeChat Channel Dynamic Registration Roadmap
 */

export { WeChatChannel } from './wechat-channel.js';
export type { WeChatChannelConfig, WeChatUpdate, WeChatGetUpdatesResponse, WeChatTextItem } from './types.js';
export { WeChatApiClient } from './api-client.js';
export { WeChatAuth, type AuthResult } from './auth.js';
export { WeChatMessageListener, type MessageCallback } from './message-listener.js';
