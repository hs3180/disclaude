/**
 * WeChat Channel Types.
 *
 * Type definitions for WeChat ilink API integration.
 * MVP v1: QR login + Token auth + Text messages only.
 *
 * @module channels/wechat/types
 */

import type { ChannelConfig } from '@disclaude/core';

/**
 * WeChat Channel configuration.
 */
export interface WeChatChannelConfig extends ChannelConfig {
  /** ilink API base URL (e.g., https://bot0.weidbot.qq.com) */
  baseUrl: string;

  /** CDN base URL for media uploads (optional) */
  cdnBaseUrl?: string;

  /**
   * Bot token (optional).
   * If provided, skip QR login and use this token directly.
   */
  token?: string;

  /**
   * Bot ID (optional).
   * Required if token is provided.
   */
  botId?: string;

  /** Route tag for request routing (optional) */
  routeTag?: string;

  /** QR login timeout in milliseconds (default: 5 minutes) */
  loginTimeout?: number;

  /** QR status polling interval in milliseconds (default: 2 seconds) */
  pollInterval?: number;
}

/**
 * QR code login status.
 */
export type QRCodeStatus = 'wait' | 'scaned' | 'confirmed' | 'expired' | 'canceled';

/**
 * QR code response from get_bot_qrcode API.
 */
export interface QRCodeResponse {
  /** QR code ID */
  qrid: string;

  /** QR code image URL */
  qrurl: string;

  /** Expiration timestamp */
  expire: number;
}

/**
 * QR code status response from get_qrcode_status API.
 */
export interface QRCodeStatusResponse {
  /** Current status */
  status: QRCodeStatus;

  /** Bot token (only available when status is 'confirmed') */
  bot_token?: string;

  /** Bot ID (only available when status is 'confirmed') */
  ilink_bot_id?: string;
}

/**
 * Outgoing text message payload.
 */
export interface OutgoingTextPayload {
  /** Message type */
  msgtype: 'text';

  /** Text content */
  text: {
    content: string;
  };
}

/**
 * API response wrapper.
 */
export interface ApiResponse<T = unknown> {
  /** Error code (0 means success) */
  errcode: number;

  /** Error message */
  errmsg: string;

  /** Response data */
  data?: T;
}

/**
 * Send message response.
 */
export interface SendMessageResponse {
  /** Message ID */
  msgid: string;
}

/**
 * Authentication state.
 */
export type AuthState = 'unauthenticated' | 'pending' | 'authenticated' | 'error';

/**
 * Authentication credentials.
 */
export interface AuthCredentials {
  /** Bot token */
  token: string;

  /** Bot ID */
  botId: string;
}

/**
 * Event types emitted by WeChatChannel.
 */
export type WeChatChannelEvent =
  | 'qrcode'      // QR code ready for scanning
  | 'authenticated' // Login successful
  | 'error';      // Authentication or connection error

/**
 * QR code event payload.
 */
export interface QRCodeEvent {
  /** QR code URL */
  url: string;

  /** QR code ID */
  id: string;
}
