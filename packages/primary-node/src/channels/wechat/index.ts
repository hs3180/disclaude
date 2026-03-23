/**
 * WeChat Channel module exports (MVP).
 *
 * @module channels/wechat
 * @see Issue #1473 - WeChat Channel MVP
 */

export { WeChatChannel } from './wechat-channel.js';
export type { WeChatChannelConfig } from './types.js';
export { WeChatApiClient } from './api-client.js';
export { WeChatAuth, type AuthResult } from './auth.js';
