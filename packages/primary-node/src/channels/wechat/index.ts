/**
 * WeChat Channel module exports.
 *
 * @module channels/wechat
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1474 - WeChat Channel: Message Listening
 */

export { WeChatChannel } from './wechat-channel.js';
export type { WeChatChannelConfig } from './types.js';
export { WeChatApiClient } from './api-client.js';
export { WeChatAuth, type AuthResult } from './auth.js';
export { WeChatMonitor, type MonitorState, type MessageCallback, type WeChatUpdate } from './monitor.js';
