/**
 * WeChat Channel type definitions (MVP).
 *
 * Defines types for the WeChat (Tencent ilink) API integration,
 * including configuration, API request/response types.
 *
 * This is the MVP version — only types needed for
 * Auth (QR login) and Send Message (text) are included.
 *
 * @module channels/wechat/types
 * @see Issue #1473 - WeChat Channel MVP
 */

import type { ChannelConfig } from '@disclaude/core';

/**
 * WeChat channel configuration.
 */
export interface WeChatChannelConfig extends ChannelConfig {
  /** API base URL (e.g., https://api.weixin.qq.com) */
  baseUrl?: string;
  /** Bot token obtained after QR code login */
  token?: string;
  /** Route tag for message routing */
  routeTag?: string;
  /** QR code expiration time in seconds (default: 300) */
  qrExpiration?: number;
}

/**
 * API response wrapper.
 */
export interface WeChatApiResponse<T = unknown> {
  /** Whether the request was successful */
  success: boolean;
  /** Response data */
  data?: T;
  /** Error message (if failed) */
  errorMsg?: string;
  /** Error code (if failed) */
  errorCode?: number;
}
