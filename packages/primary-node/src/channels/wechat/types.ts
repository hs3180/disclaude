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
 * @see Issue #1556 - WeChat Channel Feature Enhancement
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

// ---------------------------------------------------------------------------
// getUpdates API types (Issue #1556 Phase 3.1)
// ---------------------------------------------------------------------------

/**
 * Text item in a WeChat message.
 * Item type 1.
 */
export interface WeChatTextItem {
  /** Item type (1 = text) */
  type: number;
  /** Text content */
  text_item: {
    text: string;
  };
}

/**
 * Image item in a WeChat message.
 * Item type 2.
 */
export interface WeChatImageItem {
  /** Item type (2 = image) */
  type: number;
  /** Image content */
  image_item: {
    url: string;
    width?: number;
    height?: number;
  };
}

/**
 * File item in a WeChat message.
 * Item type 3.
 */
export interface WeChatFileItem {
  /** Item type (3 = file) */
  type: number;
  /** File content */
  file_item: {
    url: string;
    file_name?: string;
    file_size?: number;
  };
}

/**
 * Union type for all message item types.
 */
export type WeChatMessageItem = WeChatTextItem | WeChatImageItem | WeChatFileItem;

/**
 * A single update from the getUpdates API.
 *
 * Represents an incoming message from a user.
 */
export interface WeChatUpdate {
  /** Unique message identifier */
  msg_id?: string;
  /** Sender user ID */
  from_user_id?: string;
  /** Recipient user ID (bot ID) */
  to_user_id?: string;
  /** Message content items */
  item_list?: WeChatMessageItem[];
  /** Message creation timestamp (seconds since epoch) */
  create_time?: number;
  /** Context token for thread replies */
  context_token?: string;
}

/**
 * Response from the getUpdates API.
 */
export interface WeChatGetUpdatesResponse {
  /** Return code (0 = success) */
  ret?: number;
  /** Error message */
  err_msg?: string;
  /** List of new message updates */
  update_list?: WeChatUpdate[];
}
