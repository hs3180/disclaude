/**
 * WeChat Channel Module.
 *
 * Provides WeChat messaging platform integration via ilink API.
 *
 * @module channels/wechat
 */

// Main channel class
export { WeChatChannel } from './wechat-channel.js';

// Types
export type {
  WeChatChannelConfig,
  QRCodeStatus,
  QRCodeResponse,
  QRCodeStatusResponse,
  WeChatIncomingMessage,
  WeChatMessageContent,
  TextContent,
  ImageContent,
  FileContent,
  VideoContent,
  AudioContent,
  LinkContent,
  LocationContent,
  OutgoingTextPayload,
  OutgoingImagePayload,
  OutgoingFilePayload,
  OutgoingMessagePayload,
  SendMessageResponse,
  UploadUrlResponse,
  WeChatApiError,
  GetUpdatesResponse,
} from './types.js';

// Internal components (for advanced usage/testing)
export { WeChatApiClient } from './api-client.js';
export { WeChatAuthHandler, type AuthState, type AuthStateCallback, type QRCodeCallback } from './auth.js';
export { WeChatMonitor, type MessageCallback, type ErrorCallback } from './monitor.js';
