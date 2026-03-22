/**
 * WeChat Channel type definitions.
 *
 * Defines types for the WeChat (Tencent ilink) API integration,
 * including configuration, API request/response types, and
 * internal message structures.
 *
 * @module channels/wechat/types
 */

import type { ChannelConfig } from '@disclaude/core';

/**
 * WeChat channel configuration.
 */
export interface WeChatChannelConfig extends ChannelConfig {
  /** API base URL (e.g., https://api.weixin.qq.com) */
  baseUrl?: string;
  /** CDN base URL for media uploads (optional) */
  cdnBaseUrl?: string;
  /** Bot token obtained after QR code login */
  token?: string;
  /** Route tag for message routing */
  routeTag?: string;
  /** Polling interval in milliseconds for long polling (default: 35000) */
  pollingInterval?: number;
  /** QR code expiration time in seconds (default: 300) */
  qrExpiration?: number;
}

/**
 * QR code login status response.
 */
export interface QrCodeStatus {
  /** Login status: 'wait', 'scaned', 'confirmed', 'expired' */
  status: 'wait' | 'scaned' | 'confirmed' | 'expired';
  /** Bot token (only present when confirmed) */
  botToken?: string;
  /** Bot ID (only present when confirmed) */
  botId?: string;
  /** User info (only present when confirmed) */
  userInfo?: {
    /** User name */
    name: string;
    /** User ID */
    id: string;
  };
}

/**
 * Incoming WeChat message from API.
 */
export interface WeChatApiMessage {
  /** Unique message ID */
  msgId: string;
  /** Sender info */
  fromUser: {
    /** User ID */
    id: string;
    /** User name */
    name?: string;
  };
  /** Chat ID (group or P2P) */
  chatId: string;
  /** Chat type: 'p2p' or 'group' */
  chatType: 'p2p' | 'group';
  /** Message type: 'text', 'image', 'file', 'voice' */
  msgType: 'text' | 'image' | 'file' | 'voice';
  /** Text content (for text messages) */
  text?: {
    content: string;
  };
  /** Image info (for image messages) */
  image?: {
    /** CDN URL */
    cdnUrl: string;
    /** File size */
    fileSize?: number;
    /** Width */
    width?: number;
    /** Height */
    height?: number;
  };
  /** File info (for file messages) */
  file?: {
    /** File name */
    fileName: string;
    /** CDN URL */
    cdnUrl: string;
    /** File size */
    fileSize: number;
    /** MIME type */
    mimeType?: string;
  };
  /** Voice info (for voice messages) */
  voice?: {
    /** CDN URL */
    cdnUrl: string;
    /** Duration in seconds */
    duration?: number;
  };
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Mentioned user IDs (for group messages) */
  mentionedUserIds?: string[];
}

/**
 * Send text message request.
 */
export interface SendTextRequest {
  /** Target chat ID */
  to: string;
  /** Message type */
  msgtype: 'text';
  /** Text content */
  text: {
    content: string;
  };
}

/**
 * Send image message request.
 */
export interface SendImageRequest {
  /** Target chat ID */
  to: string;
  /** Message type */
  msgtype: 'image';
  /** Image content */
  image: {
    /** CDN URL of the uploaded image */
    cdnUrl: string;
    /** Image width (optional) */
    width?: number;
    /** Image height (optional) */
    height?: number;
  };
}

/**
 * Send file message request.
 */
export interface SendFileRequest {
  /** Target chat ID */
  to: string;
  /** Message type */
  msgtype: 'file';
  /** File content */
  file: {
    /** File name */
    fileName: string;
    /** CDN URL of the uploaded file */
    cdnUrl: string;
    /** File size in bytes */
    fileSize: number;
    /** MIME type */
    mimeType?: string;
  };
}

/**
 * Union type for send message requests.
 */
export type SendMessageRequest = SendTextRequest | SendImageRequest | SendFileRequest;

/**
 * CDN upload URL response.
 */
export interface UploadUrlResponse {
  /** Upload URL */
  uploadUrl: string;
  /** CDN URL for the uploaded file */
  cdnUrl: string;
  /** URL expiration time in seconds */
  expireSeconds: number;
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

/**
 * Message deduplication entry.
 */
export interface DeduplicationEntry {
  /** Message ID */
  msgId: string;
  /** Timestamp when message was first seen */
  seenAt: number;
}

/**
 * WeChat monitor state.
 */
export type MonitorState = 'idle' | 'polling' | 'stopped' | 'error';
