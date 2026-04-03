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
// getUpdates API types (Phase 3 - Issue #1556)
// ============================================================================

/**
 * WeChat getUpdates API response.
 *
 * POST /ilink/bot/getupdates
 */
export interface GetUpdatesResponse {
  /** API return code (0 = success) */
  ret: number;
  /** Cursor for next poll (opaque string) */
  cursor?: string;
  /** Has more updates to fetch */
  has_more?: boolean;
  /** List of new updates (messages) */
  update_list?: WeChatUpdate[];
}

/**
 * A single update (message) from the WeChat getUpdates API.
 */
export interface WeChatUpdate {
  /** Unique message identifier */
  msg_id?: string;
  /** Sender user ID */
  from_user_id?: string;
  /** Recipient user ID (bot ID) */
  to_user_id?: string;
  /** Message type: 1=text, 2=image, 3=file, 4=link, etc. */
  message_type?: number;
  /** Message state: 1=sending, 2=finished */
  message_state?: number;
  /** Message content items */
  item_list?: WeChatMessageItem[];
  /** Thread/context token for replies */
  context_token?: string;
  /** Message creation timestamp (seconds since epoch) */
  create_time?: number;
}

/**
 * A message content item within a WeChat update.
 */
export interface WeChatMessageItem {
  /** Item type: 1=text, 2=image, 3=file, 4=link */
  type?: number;
  /** Text content (when type=1) */
  text_item?: { text?: string };
  /** File content (when type=3) */
  file_item?: { file_name?: string; file_url?: string; file_size?: number };
  /** Image content (when type=2) */
  image_item?: { image_url?: string };
}

// ============================================================================
// Message Listener types (Phase 3 - Issue #1556)
// ============================================================================

/**
 * Configuration for the WeChat message listener.
 */
export interface WeChatMessageListenerConfig {
  /** Maximum deduplication set size before FIFO eviction (default: 10000) */
  maxDedupSize?: number;
  /** Maximum consecutive errors before stopping the poll loop (default: 10) */
  maxConsecutiveErrors?: number;
  /** Long-poll timeout in milliseconds (default: 35000) */
  pollTimeoutMs?: number;
  /** Base delay for exponential backoff in milliseconds (default: 1000) */
  backoffBaseMs?: number;
  /** Maximum backoff delay in milliseconds (default: 30000) */
  backoffMaxMs?: number;
}
