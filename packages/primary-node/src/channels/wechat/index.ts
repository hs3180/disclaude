/**
 * WeChat Channel module exports.
 *
 * @module channels/wechat
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1556 - WeChat Channel Feature Enhancement
 */

export { WeChatChannel } from './wechat-channel.js';
export type { WeChatChannelConfig } from './types.js';
export { WeChatApiClient } from './api-client.js';
export { WeChatAuth, type AuthResult } from './auth.js';
export { WeChatMessageListener, type MessageProcessor } from './message-listener.js';
export type {
  WeChatTextItem,
  WeChatImageItem,
  WeChatFileItem,
  WeChatMessageItem,
  WeChatUpdate,
  WeChatGetUpdatesResponse,
  WeChatTypingResponse,
} from './types.js';
