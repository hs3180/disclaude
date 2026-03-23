/**
 * WeChat Channel type definitions.
 *
 * Defines types for the WeChat (Tencent ilink) API integration,
 * including configuration, message items, and API request/response types.
 *
 * Based on official @tencent-weixin/openclaw-weixin implementation.
 *
 * @module channels/wechat/types
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1475 - WeChat Channel Media Handling
 */

import type { ChannelConfig } from '@disclaude/core';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

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
  /** CDN base URL for media upload/download (default: https://novac2c.cdn.weixin.qq.com/c2c) */
  cdnBaseUrl?: string;
}

// ---------------------------------------------------------------------------
// Upload media types (mirrors proto: UploadMediaType)
// ---------------------------------------------------------------------------

/** Upload media type constants for getUploadUrl API. */
export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

// ---------------------------------------------------------------------------
// Message item types (mirrors proto: MessageItemType)
// ---------------------------------------------------------------------------

/** Message item type constants. */
export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

// ---------------------------------------------------------------------------
// Message item interfaces
// ---------------------------------------------------------------------------

/** CDN media reference for uploaded files. */
export interface CDNMedia {
  /** Encrypted query param from CDN upload response header (x-encrypted-param). */
  encrypt_query_param?: string;
  /** AES key, base64-encoded. */
  aes_key?: string;
  /** Encrypt type: 0=encrypt fileid only, 1=pack thumbnail/mid-size info. */
  encrypt_type?: number;
}

/** Text message item (type=1). */
export interface TextItem {
  text?: string;
}

/** Image message item (type=2). */
export interface ImageItem {
  media?: CDNMedia;
  mid_size?: number;
}

/** File attachment message item (type=4). */
export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  len?: string;
}

/** A single message item in item_list. */
export interface MessageItem {
  type?: number;
  text_item?: TextItem;
  image_item?: ImageItem;
  file_item?: FileItem;
}

// ---------------------------------------------------------------------------
// Upload request/response types
// ---------------------------------------------------------------------------

/** Request parameters for getUploadUrl API. */
export interface GetUploadUrlReq {
  filekey?: string;
  media_type?: number;
  to_user_id?: string;
  /** Plaintext file size in bytes. */
  rawsize?: number;
  /** Plaintext file MD5 hash. */
  rawfilemd5?: string;
  /** Ciphertext file size (AES-128-ECB padded). */
  filesize?: number;
  /** No thumbnail needed (default: true for file uploads). */
  no_need_thumb?: boolean;
  /** AES key, hex-encoded. */
  aeskey?: string;
}

/** Response from getUploadUrl API. */
export interface GetUploadUrlResp {
  /** Encrypted upload param for CDN upload URL. */
  upload_param?: string;
  /** Encrypted upload param for thumbnail (images/videos only). */
  thumb_upload_param?: string;
}

/** Result of a completed media upload. */
export interface UploadedFileInfo {
  /** Random file key (hex string). */
  filekey: string;
  /** Encrypted query param from CDN response for download reference. */
  downloadEncryptedQueryParam: string;
  /** AES key, hex-encoded. */
  aeskey: string;
  /** Plaintext file size in bytes. */
  fileSize: number;
  /** Ciphertext file size in bytes (AES-128-ECB padded). */
  fileSizeCiphertext: number;
}
