/**
 * WeChat Channel type definitions.
 *
 * Defines types for the WeChat (Tencent ilink) API integration,
 * including configuration, message items, and API request/response types.
 *
 * Based on official @tencent-weixin/openclaw-weixin implementation.
 *
 * @module channels/wechat/types
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3)
 */

import type { ChannelConfig } from '@disclaude/core';

/**
 * WeChat channel configuration.
 */
export interface WeChatChannelConfig extends ChannelConfig {
  /** API base URL (default: https://ilinkai.weixin.qq.com) */
  baseUrl?: string;
  /** Bot token obtained after QR code login (skip auth if provided) */
  token?: string;
  /** Route tag for message routing */
  routeTag?: string;
}

// ============================================================================
// Message item types (for incoming messages from getUpdates)
// ============================================================================

/**
 * Text message item (type: 1).
 */
export interface WeChatTextItem {
  type: 1;
  text_item: { text: string };
}

/**
 * Image message item (type: 2).
 */
export interface WeChatImageItem {
  type: 2;
  image_item: {
    url: string;
    width?: number;
    height?: number;
  };
}

/**
 * File message item (type: 3).
 */
export interface WeChatFileItem {
  type: 3;
  file_item: {
    url: string;
    file_name: string;
    file_size?: number;
  };
}

/**
 * Union type for all WeChat message items.
 */
export type WeChatMessageItem = WeChatTextItem | WeChatImageItem | WeChatFileItem;

// ============================================================================
// API response types
// ============================================================================

/**
 * Incoming message update from getUpdates long-poll.
 */
export interface WeChatUpdate {
  msg_id: string;
  from_user_id: string;
  to_user_id: string;
  item_list: WeChatMessageItem[];
  create_time: number;
  context_token?: string;
}

/**
 * Response from getUpdates API.
 */
export interface WeChatGetUpdatesResponse {
  ret: number;
  update_list: WeChatUpdate[];
}

/**
 * Response from CDN upload API (ilink/bot/upload).
 */
export interface WeChatCdnUploadResponse {
  ret?: number;
  url?: string;
  file_key?: string;
  err_msg?: string;
}

/**
 * Response from typing indicator API (ilink/bot/typing).
 */
export interface WeChatTypingResponse {
  ret?: number;
  err_msg?: string;
}
