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
 * @see Issue #1557 - WeChat Channel Dynamic Registration Roadmap
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
// getUpdates API types (Phase 3.1)
// ---------------------------------------------------------------------------

/**
 * Text item within a WeChat message.
 */
export interface WeChatTextItem {
  type: number;
  text_item: {
    text: string;
  };
}

/**
 * A single update (incoming message) from the getUpdates API.
 */
export interface WeChatUpdate {
  /** Unique message identifier */
  msg_id: string;
  /** Sender user ID */
  from_user_id: string;
  /** Recipient user/bot ID */
  to_user_id: string;
  /** Client identifier */
  client_id?: string;
  /** Message type (1 = user text, 2 = bot, 3 = image, 6 = file) */
  message_type: number;
  /** Message content items */
  item_list?: WeChatTextItem[];
  /** Thread context token for reply threading */
  context_token?: string;
  /** Message creation timestamp (seconds) */
  create_time?: number;
}

/**
 * Response from the getUpdates API endpoint.
 */
export interface WeChatGetUpdatesResponse {
  /** API return code (0 = success) */
  ret: number;
  /** Error message (when ret !== 0) */
  err_msg?: string;
  /** Array of incoming message updates */
  update_list: WeChatUpdate[];
}
