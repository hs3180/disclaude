/**
 * WeChat Channel type definitions.
 *
 * Defines types for the WeChat (Tencent ilink) API integration,
 * including configuration and API request/response types.
 *
 * Based on official @tencent-weixin/openclaw-weixin implementation.
 *
 * @module channels/wechat/types
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3.1)
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
// Message item types (from ilink/bot/getupdates API)
// ============================================================================

/**
 * Text message item (type=1).
 */
export interface WeChatTextItem {
  type: 1;
  text_item: { text: string };
}

/**
 * Image message item (type=2).
 */
export interface WeChatImageItem {
  type: 2;
  image_item: { url: string };
}

/**
 * File message item (type=3).
 */
export interface WeChatFileItem {
  type: 3;
  file_item: {
    url: string;
    file_name?: string;
    file_size?: number;
  };
}

/**
 * Union of all known message item types.
 */
export type WeChatMessageItem = WeChatTextItem | WeChatImageItem | WeChatFileItem;

// ============================================================================
// getUpdates API types
// ============================================================================

/**
 * A single update from the getUpdates long-poll API.
 */
export interface WeChatUpdate {
  /** Unique message ID for deduplication */
  msg_id: string;
  /** Sender user ID */
  from_user_id?: string;
  /** Recipient user ID (bot) */
  to_user_id?: string;
  /** Message items (text, image, file, etc.) */
  item_list?: WeChatMessageItem[];
  /** Unix timestamp (seconds) */
  create_time?: number;
  /** Thread context token for conversation threading */
  context_token?: string;
}

/**
 * Response from the getUpdates API.
 */
export interface WeChatGetUpdatesResponse {
  ret?: number;
  err_msg?: string;
  update_list: WeChatUpdate[];
}
