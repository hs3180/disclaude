/**
 * WeChat Channel Module.
 *
 * MVP v1: QR login + Token auth + Text messages.
 *
 * @module channels/wechat
 */

export { WeChatChannel } from './wechat-channel.js';
export { WeChatApiClient } from './api-client.js';
export { WeChatAuthHandler } from './auth.js';
export type {
  WeChatChannelConfig,
  WeChatChannelEvent,
  QRCodeStatus,
  QRCodeResponse,
  QRCodeStatusResponse,
  OutgoingTextPayload,
  ApiResponse,
  SendMessageResponse,
  AuthState,
  AuthCredentials,
  QRCodeEvent,
} from './types.js';
