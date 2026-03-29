/**
 * WeChat Channel module exports.
 *
 * @module channels/wechat
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1557 - WeChat Channel Dynamic Registration Roadmap (Phase 3.2)
 */

export { WeChatChannel } from './wechat-channel.js';
export type { WeChatChannelConfig } from './types.js';
export { WeChatApiClient, type MediaType, type MediaUploadResult } from './api-client.js';
export { WeChatAuth, type AuthResult } from './auth.js';
