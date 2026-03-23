/**
 * WeChat Channel module exports.
 *
 * @module channels/wechat
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1475 - WeChat Channel Media Handling
 */

export { WeChatChannel } from './wechat-channel.js';
export type { WeChatChannelConfig } from './types.js';
export { WeChatApiClient } from './api-client.js';
export { WeChatAuth, type AuthResult } from './auth.js';
export { WeChatMediaHandler } from './media-handler.js';
export { encryptAesEcb, aesEcbPaddedSize, uploadBufferToCdn, buildCdnUploadUrl, buildCdnDownloadUrl, DEFAULT_CDN_BASE_URL } from './cdn.js';
export { UploadMediaType, MessageItemType } from './types.js';
export type { MessageItem, CDNMedia, ImageItem, FileItem, UploadedFileInfo, GetUploadUrlReq, GetUploadUrlResp } from './types.js';
