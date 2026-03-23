/**
 * WeChat Media Handler.
 *
 * Orchestrates the full media upload pipeline for the WeChat channel:
 * 1. Read file → compute hash and sizes
 * 2. Generate AES key and file key
 * 3. Call getUploadUrl API to get CDN upload params
 * 4. AES-128-ECB encrypt file content
 * 5. Upload encrypted buffer to CDN
 * 6. Return upload info for message construction
 *
 * Based on official @tencent-weixin/openclaw-weixin implementation.
 *
 * @module channels/wechat/media-handler
 * @see Issue #1475 - WeChat Channel: Media Handling
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { createLogger } from '@disclaude/core';
import type { WeChatApiClient } from './api-client.js';
import { uploadBufferToCdn, aesEcbPaddedSize } from './cdn.js';
import { UploadMediaType, type UploadedFileInfo } from './types.js';

const logger = createLogger('WeChatMediaHandler');

/** Maximum image file size in bytes (10MB). */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/** Maximum file size in bytes (30MB). */
const MAX_FILE_SIZE = 30 * 1024 * 1024;

/** Common image extensions. */
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico',
]);

/** MIME type mappings for common file extensions. */
const EXTENSION_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
};

/**
 * WeChat media handler.
 *
 * Provides the full upload pipeline for images and file attachments,
 * including AES encryption and CDN upload.
 */
export class WeChatMediaHandler {
  private readonly client: WeChatApiClient;
  private readonly cdnBaseUrl: string;

  /**
   * Create a new media handler.
   *
   * @param client - WeChat API client
   * @param cdnBaseUrl - CDN base URL for upload/download
   */
  constructor(client: WeChatApiClient, cdnBaseUrl: string) {
    this.client = client;
    this.cdnBaseUrl = cdnBaseUrl;
  }

  /**
   * Upload a local file to the WeChat CDN.
   *
   * Full pipeline: read → hash → encrypt → upload → return info.
   * Automatically determines media type (image vs file) from extension.
   *
   * @param filePath - Path to the local file
   * @param toUserId - Target user ID for the upload
   * @returns Upload result with CDN reference info
   */
  async uploadFile(filePath: string, toUserId: string): Promise<UploadedFileInfo> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const extension = path.extname(filePath).toLowerCase();
    const isImage = IMAGE_EXTENSIONS.has(extension);

    // Read and validate file
    const plaintext = fs.readFileSync(filePath);
    const rawSize = plaintext.length;

    if (isImage && rawSize > MAX_IMAGE_SIZE) {
      throw new Error(`Image file too large: ${rawSize} bytes (max ${MAX_IMAGE_SIZE} bytes)`);
    }
    if (!isImage && rawSize > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${rawSize} bytes (max ${MAX_FILE_SIZE} bytes)`);
    }

    return this.uploadBuffer(plaintext, toUserId, isImage ? UploadMediaType.IMAGE : UploadMediaType.FILE);
  }

  /**
   * Upload a buffer to the WeChat CDN.
   *
   * @param plaintext - File content as buffer
   * @param toUserId - Target user ID
   * @param mediaType - Upload media type (IMAGE, FILE, VIDEO)
   * @returns Upload result with CDN reference info
   */
  async uploadBuffer(
    plaintext: Buffer,
    toUserId: string,
    mediaType: number,
  ): Promise<UploadedFileInfo> {
    const rawSize = plaintext.length;
    const rawFileMd5 = crypto.createHash('md5').update(plaintext).digest('hex');
    const fileSize = aesEcbPaddedSize(rawSize);
    const filekey = crypto.randomBytes(16).toString('hex');
    const aeskey = crypto.randomBytes(16);

    logger.debug(
      { filekey, rawSize, fileSize, md5: rawFileMd5, mediaType },
      'Uploading media to CDN',
    );

    // Get CDN upload URL from API
    const uploadUrlResp = await this.client.getUploadUrl({
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize: rawSize,
      rawfilemd5: rawFileMd5,
      filesize: fileSize,
      no_need_thumb: true,
      aeskey: aeskey.toString('hex'),
    });

    // Upload encrypted buffer to CDN
    const { downloadParam } = await uploadBufferToCdn({
      buf: plaintext,
      uploadParam: uploadUrlResp.upload_param!,
      filekey,
      cdnBaseUrl: this.cdnBaseUrl,
      aeskey,
      label: `uploadMedia[filekey=${filekey}]`,
    });

    logger.info(
      { filekey, fileSize, downloadParamLength: downloadParam.length },
      'Media uploaded to CDN successfully',
    );

    return {
      filekey,
      downloadEncryptedQueryParam: downloadParam,
      aeskey: aeskey.toString('hex'),
      fileSize: rawSize,
      fileSizeCiphertext: fileSize,
    };
  }

  /**
   * Check if a file extension indicates an image.
   *
   * @param extension - File extension (with dot, e.g., '.png')
   */
  isImageFile(extension: string): boolean {
    return IMAGE_EXTENSIONS.has(extension.toLowerCase());
  }

  /**
   * Get the MIME type for a file extension.
   *
   * @param extension - File extension (with dot, e.g., '.pdf')
   * @returns MIME type string
   */
  getMimeType(extension: string): string {
    return EXTENSION_TO_MIME[extension.toLowerCase()] || 'application/octet-stream';
  }
}
