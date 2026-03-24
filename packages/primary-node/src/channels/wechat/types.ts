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

import type { ChannelConfig, IncomingMessage } from '@disclaude/core';

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
 * Item types in WeChat message item_list.
 *
 * - 1: text
 * - 2: image
 * - 3: file
 * - 4: link
 */
export type WeChatItemtype = 1 | 2 | 3 | 4;

/**
 * A single item within a WeChat message's item_list.
 */
export interface WeChatMessageItem {
  /** Item type (1=text, 2=image, 3=file, 4=link) */
  type: WeChatItemtype;
  /** Text content (present when type=1) */
  text_item?: { text: string };
  /** Image content (present when type=2) */
  image_item?: { image_key: string; width?: number; height?: number };
  /** File content (present when type=3) */
  file_item?: { file_key: string; file_name: string; file_size?: number };
}

/**
 * Raw message from the WeChat iLink getUpdates API.
 */
export interface WeChatRawMessage {
  /** Unique message identifier */
  msg_id?: string;
  /** Sender user ID */
  from_user_id?: string;
  /** Recipient user ID */
  to_user_id?: string;
  /** Client-generated message ID */
  client_id?: string;
  /** Message type (1=USER, 2=BOT) */
  message_type?: number;
  /** Message state (1=SENDING, 2=FINISH) */
  message_state?: number;
  /** Message content items */
  item_list?: WeChatMessageItem[];
  /** Thread context token */
  context_token?: string;
  /** Message creation timestamp (seconds since epoch) */
  create_time?: number;
}

/**
 * Request body for POST /ilink/bot/getupdates.
 */
export interface WeChatGetUpdatesRequest {
  /** Cursor for pagination (omit for first request) */
  cursor?: string;
  /** Long-poll timeout in seconds (default: 35) */
  timeout?: number;
}

/**
 * Response from POST /ilink/bot/getupdates.
 */
export interface WeChatGetUpdatesResponse {
  /** Error code (0 = success) */
  ret?: number;
  /** Error message (when ret !== 0) */
  err_msg?: string;
  /** List of new messages */
  msg_list?: WeChatRawMessage[];
  /** Cursor for next poll */
  cursor?: string;
  /** Whether more messages are available */
  has_more?: boolean;
}

/**
 * Options for WeChatMessageListener.
 */
export interface WeChatMessageListenerOptions {
  /** Callback invoked for each parsed incoming message */
  onMessage: (message: IncomingMessage) => Promise<void>;
  /** Callback invoked on listener errors (non-fatal, listener retries) */
  onError?: (error: Error) => void;
  /** Long-poll timeout in milliseconds (default: 35000) */
  pollTimeoutMs?: number;
  /** Delay between poll retries on error (default: 1000) */
  retryDelayMs?: number;
  /** Maximum number of deduplicated message IDs to track (default: 10000) */
  maxDedupCacheSize?: number;
}
