/**
 * WeChat Channel module exports.
 *
 * @module channels/wechat
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3)
 */

export { WeChatChannel } from './wechat-channel.js';
export type { WeChatChannelConfig, GetUpdatesResponse, WeChatUpdate, WeChatMessageItem, WeChatMessageListenerConfig } from './types.js';
export { WeChatApiClient } from './api-client.js';
export { WeChatAuth, type AuthResult } from './auth.js';
export { WeChatMessageListener } from './message-listener.js';
