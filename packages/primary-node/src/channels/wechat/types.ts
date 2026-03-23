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
 * @see Issue #1476 - Config injection & CLI integration
 */

import type { ChannelConfig } from '@disclaude/core';

/**
 * WeChat channel configuration.
 *
 * Supports configuration via YAML (channels.wechat.*) or environment variables:
 * - channels.wechat.baseUrl → WECHAT_API_BASE_URL
 * - channels.wechat.token → WECHAT_BOT_TOKEN
 * - channels.wechat.cdnBaseUrl → WECHAT_CDN_BASE_URL
 */
export interface WeChatChannelConfig extends ChannelConfig {
  /** API base URL (default: https://ilinkai.weixin.qq.com) */
  baseUrl?: string;
  /** Bot token obtained after QR code login (skip auth if provided) */
  token?: string;
  /** Route tag for message routing */
  routeTag?: string;
  /** CDN base URL for media uploads (used by media handler) */
  cdnBaseUrl?: string;
}
