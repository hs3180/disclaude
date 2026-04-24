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
 */
export interface WeChatTextItem {
  /** Item type (1 = text) */
  type: 1;
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
  type: 2;
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
  type: 3;
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
// Media upload API types (Issue #1556 Phase 3.2)
// ---------------------------------------------------------------------------

/** Maximum file size for media upload (20 MB). */
export const MAX_MEDIA_FILE_SIZE = 20 * 1024 * 1024;

/** Image file extensions recognized by WeChat API. */
export const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp',
]);

/**
 * Result of a media upload to WeChat CDN.
 */
export interface WeChatMediaUploadResult {
  /** CDN URL of the uploaded file */
  url: string;
  /** File name as stored on CDN */
  file_name?: string;
  /** File size in bytes */
  file_size?: number;
}
