/**
 * WeChat Channel module exports.
 *
 * @module channels/wechat
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3)
 */

export { WeChatChannel } from './wechat-channel.js';
export type { WeChatChannelConfig } from './types.js';
export { WeChatApiClient } from './api-client.js';
export { WeChatAuth, type AuthResult } from './auth.js';
export type {
  WeChatTextItem,
  WeChatImageItem,
  WeChatFileItem,
  WeChatMessageItem,
  WeChatUpdate,
  WeChatGetUpdatesResponse,
  WeChatCdnUploadResponse,
  WeChatTypingResponse,
} from './types.js';
