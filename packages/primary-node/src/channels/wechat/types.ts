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

/**
 * Response from the CDN upload endpoint (POST /ilink/bot/upload).
 */
export interface WeChatCdnUploadResponse {
  /** WeChat API return code (0 = success) */
  ret?: number;
  /** Error message (if ret !== 0) */
  err_msg?: string;
  /** CDN URL of the uploaded file */
  url?: string;
  /** File key for referencing the uploaded file */
  file_key?: string;
}
