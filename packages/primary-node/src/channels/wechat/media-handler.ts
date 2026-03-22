/**
 * WeChat Media Handler.
 *
 * Handles media upload/download operations for the WeChat channel:
 * - Uploading images and files via CDN
 * - Determining file types for upload
 * - Size validation
 *
 * @module channels/wechat/media-handler
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '@disclaude/core';
import type { WeChatApiClient } from './api-client.js';

const logger = createLogger('WeChatMediaHandler');

/** Maximum image file size in bytes (10MB). */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/** Maximum file size in bytes (30MB). */
const MAX_FILE_SIZE = 30 * 1024 * 1024;

/** Common image extensions. */
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico',
]);

/**
 * MIME type mappings for common file extensions.
 */
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
 * Media upload result.
 */
export interface MediaUploadResult {
  /** CDN URL of the uploaded media */
  cdnUrl: string;
  /** Whether the media is an image */
  isImage: boolean;
  /** File name */
  fileName: string;
  /** File size in bytes */
  fileSize: number;
  /** Original file extension */
  extension: string;
}

/**
 * WeChat media handler.
 *
 * Provides utility methods for uploading files and determining media types.
 */
export class WeChatMediaHandler {
  private readonly client: WeChatApiClient;

  /**
   * Create a new media handler.
   *
   * @param client - WeChat API client
   */
  constructor(client: WeChatApiClient) {
    this.client = client;
  }

  /**
   * Upload a file and get its CDN URL.
   *
   * @param filePath - Path to the file to upload
   * @returns Upload result with CDN URL and metadata
   */
  async uploadFile(filePath: string): Promise<MediaUploadResult> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileName = path.basename(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const fileBuffer = fs.readFileSync(filePath);
    const fileSize = fileBuffer.length;
    const isImage = IMAGE_EXTENSIONS.has(extension);
    const mimeType = EXTENSION_TO_MIME[extension] || 'application/octet-stream';

    // Validate file size
    if (isImage && fileSize > MAX_IMAGE_SIZE) {
      throw new Error(`Image file too large: ${fileSize} bytes (max ${MAX_IMAGE_SIZE} bytes)`);
    }
    if (!isImage && fileSize > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${fileSize} bytes (max ${MAX_FILE_SIZE} bytes)`);
    }

    logger.info({ fileName, fileSize, isImage, mimeType }, 'Uploading file to CDN');

    // Get upload URL from API
    const { uploadUrl } = await this.client.getUploadUrl(fileName, fileSize);

    // Upload file content to CDN
    const finalCdnUrl = await this.client.uploadToCdn(uploadUrl, fileBuffer, mimeType);

    logger.info({ fileName, cdnUrl: finalCdnUrl }, 'File uploaded successfully');

    return {
      cdnUrl: finalCdnUrl,
      isImage,
      fileName,
      fileSize,
      extension,
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
