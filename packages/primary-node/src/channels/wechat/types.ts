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
// getUpdates API types
// ---------------------------------------------------------------------------

/**
 * Text item in a WeChat message.
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
 */
export interface WeChatImageItem {
  /** Item type (2 = image) */
  type: number;
  /** Image content */
  image_item: {
    /** Image CDN URL */
    url: string;
    /** Image width */
    width?: number;
    /** Image height */
    height?: number;
  };
}

/**
 * File item in a WeChat message.
 */
export interface WeChatFileItem {
  /** Item type (3 = file) */
  type: number;
  /** File content */
  file_item: {
    /** File CDN URL */
    url: string;
    /** File name */
    file_name?: string;
    /** File size in bytes */
    file_size?: number;
  };
}

/**
 * Union type for message content items.
 */
export type WeChatMessageItem = WeChatTextItem | WeChatImageItem | WeChatFileItem;

/**
 * A single update from the getUpdates long-poll API.
 */
export interface WeChatUpdate {
  /** Unique message identifier */
  msg_id: string;
  /** Sender user ID */
  from_user_id?: string;
  /** Recipient user ID (bot ID) */
  to_user_id?: string;
  /** Message content items */
  item_list?: WeChatMessageItem[];
  /** Context token for thread replies */
  context_token?: string;
  /** Message creation timestamp (seconds since epoch) */
  create_time?: number;
  /** Message type (1 = user, 2 = bot) */
  message_type?: number;
}

/**
 * Response from the getUpdates long-poll API.
 */
export interface WeChatGetUpdatesResponse {
  /** Return code (0 = success) */
  ret?: number;
  /** List of new updates/messages */
  update_list?: WeChatUpdate[];
}

// ---------------------------------------------------------------------------
// Media upload API types
// ---------------------------------------------------------------------------

/**
 * Response from CDN upload API.
 */
export interface WeChatCdnUploadResponse {
  /** Return code (0 = success) */
  ret?: number;
  /** CDN URL of the uploaded file */
  url?: string;
  /** File key for referencing the uploaded file */
  file_key?: string;
}

// ---------------------------------------------------------------------------
// Typing indicator types
// ---------------------------------------------------------------------------

/**
 * Response from the typing indicator API.
 */
export interface WeChatTypingResponse {
  /** Return code (0 = success) */
  ret?: number;
}
