/**
 * WeChat Channel Types.
 *
 * Type definitions for WeChat Channel implementation.
 * Based on openclaw-weixin API documentation.
 *
 * @module channels/wechat/types
 */

import type { ChannelConfig } from '@disclaude/core';

/**
 * WeChat Channel configuration.
 */
export interface WeChatChannelConfig extends ChannelConfig {
  /** API base URL (e.g., https://ilink.example.com) */
  baseUrl: string;
  /** CDN base URL for file uploads (optional) */
  cdnBaseUrl?: string;
  /** Bot token (obtained after QR login) */
  token?: string;
  /** Bot ID (obtained after QR login) */
  botId?: string;
  /** Route tag for message routing (optional) */
  routeTag?: string;
  /** Long polling timeout in seconds (default: 35) */
  pollingTimeout?: number;
}

/**
 * QR code login status.
 */
export type QRCodeStatus = 'wait' | 'scaned' | 'confirmed' | 'expired' | 'canceled';

/**
 * QR code response from API.
 */
export interface QRCodeResponse {
  /** QR code image URL */
  qrcode_url: string;
  /** Unique QR code ID */
  qrcode_id: string;
  /** Expiration timestamp (seconds) */
  expire_time?: number;
}

/**
 * QR code status response from API.
 */
export interface QRCodeStatusResponse {
  /** Current status */
  status: QRCodeStatus;
  /** Bot token (only when status is 'confirmed') */
  bot_token?: string;
  /** Bot ID (only when status is 'confirmed') */
  ilink_bot_id?: string;
  /** User who scanned (optional) */
  scan_user?: {
    user_id?: string;
    nickname?: string;
    avatar?: string;
  };
}

/**
 * Incoming message from WeChat long polling.
 */
export interface WeChatIncomingMessage {
  /** Message ID */
  msg_id: string;
  /** Chat/conversation ID */
  chat_id: string;
  /** Sender user ID */
  from_user: string;
  /** Message type */
  msg_type: 'text' | 'image' | 'file' | 'video' | 'audio' | 'link' | 'location' | 'emoji';
  /** Message content (type-specific) */
  content: WeChatMessageContent;
  /** Timestamp (seconds) */
  timestamp: number;
  /** Is group message */
  is_group?: boolean;
  /** Group ID (if group message) */
  group_id?: string;
  /** @ mention list (if group message) */
  at_user_list?: string[];
}

/**
 * WeChat message content (union type for different message types).
 */
export type WeChatMessageContent =
  | TextContent
  | ImageContent
  | FileContent
  | VideoContent
  | AudioContent
  | LinkContent
  | LocationContent;

/**
 * Text message content.
 */
export interface TextContent {
  text: string;
}

/**
 * Image message content.
 */
export interface ImageContent {
  /** Image URL or file ID */
  file_id?: string;
  /** Image URL (direct) */
  url?: string;
  /** Image format */
  format?: string;
}

/**
 * File message content.
 */
export interface FileContent {
  /** File ID for download */
  file_id: string;
  /** File name */
  file_name: string;
  /** File size in bytes */
  file_size?: number;
  /** MIME type */
  mime_type?: string;
}

/**
 * Video message content.
 */
export interface VideoContent {
  /** Video file ID */
  file_id: string;
  /** Thumbnail file ID */
  thumb_file_id?: string;
  /** Duration in seconds */
  duration?: number;
}

/**
 * Audio message content.
 */
export interface AudioContent {
  /** Audio file ID */
  file_id: string;
  /** Duration in seconds */
  duration?: number;
  /** Format */
  format?: string;
}

/**
 * Link message content.
 */
export interface LinkContent {
  /** Link title */
  title: string;
  /** Link description */
  description?: string;
  /** Link URL */
  url: string;
  /** Thumbnail URL */
  thumb_url?: string;
}

/**
 * Location message content.
 */
export interface LocationContent {
  /** Latitude */
  latitude: number;
  /** Longitude */
  longitude: number;
  /** Location label */
  label?: string;
  /** Precision in meters */
  precision?: number;
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
 * Outgoing image message payload.
 */
export interface OutgoingImagePayload {
  /** Message type */
  msgtype: 'image';
  /** Image content */
  image: {
    file_id: string;
  };
}

/**
 * Outgoing file message payload.
 */
export interface OutgoingFilePayload {
  /** Message type */
  msgtype: 'file';
  /** File content */
  file: {
    file_id: string;
    file_name?: string;
  };
}

/**
 * Outgoing message payload (union type).
 */
export type OutgoingMessagePayload = OutgoingTextPayload | OutgoingImagePayload | OutgoingFilePayload;

/**
 * Send message response.
 */
export interface SendMessageResponse {
  /** Message ID of sent message */
  msg_id: string;
  /** Send timestamp */
  timestamp: number;
}

/**
 * Upload URL response from CDN.
 */
export interface UploadUrlResponse {
  /** Upload URL */
  upload_url: string;
  /** File ID after upload */
  file_id: string;
  /** Expiration timestamp */
  expire_time?: number;
}

/**
 * API error response.
 */
export interface WeChatApiError {
  /** Error code */
  errcode: number;
  /** Error message */
  errmsg: string;
}

/**
 * Long polling update response.
 */
export interface GetUpdatesResponse {
  /** List of new messages */
  messages: WeChatIncomingMessage[];
  /** Next polling offset */
  next_offset?: string;
}
