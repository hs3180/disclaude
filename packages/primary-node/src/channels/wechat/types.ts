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
  /** Message listener configuration */
  listener?: MessageListenerConfig;
}

// ---------------------------------------------------------------------------
// getUpdates API types
// ---------------------------------------------------------------------------

/**
 * WeChat item_list element types (matches send message format).
 */
export interface WeChatTextItem {
  type: 1;
  text_item: { text: string };
}

export interface WeChatImageItem {
  type: 2;
  image_item: {
    image_key?: string;
    image_url?: string;
    image_data?: string;
  };
}

export interface WeChatFileItem {
  type: 3;
  file_item: {
    file_name?: string;
    file_key?: string;
    file_url?: string;
    file_size?: number;
  };
}

export type WeChatMessageItem = WeChatTextItem | WeChatImageItem | WeChatFileItem;

/**
 * Raw message from the getUpdates API response.
 *
 * Mirrors the send message format with additional metadata:
 * - msg_id: unique message identifier for deduplication
 * - from_user_id: sender user ID
 * - create_time: message creation timestamp (seconds)
 */
export interface WeChatRawMessage {
  /** Unique message identifier */
  msg_id?: string;
  /** Sender user ID */
  from_user_id?: string;
  /** Recipient user ID (bot ID) */
  to_user_id?: string;
  /** Client message ID (from sender) */
  client_id?: string;
  /** Message type: 1=text, 2=image, 3=file */
  message_type?: number;
  /** Message state */
  message_state?: number;
  /** Message content items */
  item_list?: WeChatMessageItem[];
  /** Context token for threading */
  context_token?: string;
  /** Creation timestamp (seconds since epoch) */
  create_time?: number;
  /** Source (bot/user/system) */
  source?: string;
}

/**
 * Response from POST /ilink/bot/getupdates.
 */
export interface WeChatGetUpdatesResponse {
  /** API return code (0 = success) */
  ret?: number;
  /** Error message */
  err_msg?: string;
  /** List of incoming messages */
  msg_list?: WeChatRawMessage[];
}

// ---------------------------------------------------------------------------
// Message Listener types
// ---------------------------------------------------------------------------

/**
 * Configuration for the message listener.
 */
export interface MessageListenerConfig {
  /** Maximum number of message IDs to track for deduplication (default: 1000) */
  dedupMaxSize?: number;
  /** Long-poll timeout in milliseconds (default: 35000) */
  pollTimeoutMs?: number;
  /** Delay between poll iterations in milliseconds (default: 500) */
  pollIntervalMs?: number;
  /** Maximum consecutive errors before stopping (default: 10) */
  maxConsecutiveErrors?: number;
  /** Base delay for exponential backoff in milliseconds (default: 1000) */
  backoffBaseMs?: number;
  /** Maximum backoff delay in milliseconds (default: 30000) */
  backoffMaxMs?: number;
}

/**
 * Default message listener configuration values.
 */
export const DEFAULT_LISTENER_CONFIG: Required<MessageListenerConfig> = {
  dedupMaxSize: 1000,
  pollTimeoutMs: 35_000,
  pollIntervalMs: 500,
  maxConsecutiveErrors: 10,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
};

// ---------------------------------------------------------------------------
// Message parsing helpers
// ---------------------------------------------------------------------------

/**
 * Map WeChat message_type to IncomingMessage.messageType.
 */
export const WECHAT_MESSAGE_TYPE_MAP: Record<number, IncomingMessage['messageType']> = {
  1: 'text',
  2: 'image',
  3: 'file',
};
