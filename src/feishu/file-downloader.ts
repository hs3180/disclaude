/**
 * File downloader for Feishu/Lark.
 *
 * Downloads files and images from Feishu using the file_key.
 * Files are saved to the workspace/attachments directory.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('FileDownloader');

/**
 * Feishu file resource response type.
 * SDK returns an object with writeFile method for saving files.
 */
interface FileResourceResponse {
  writeFile: (path: string) => Promise<void>;
  getReadableStream?: () => NodeJS.ReadableStream;
}

/**
 * Extended error type with HTTP response details.
 */
interface FeishuApiError extends Error {
  code?: string;
  response?: {
    status?: number;
    statusText?: string;
    data?: unknown;
  };
}

/**
 * Get the attachments directory path.
 */
function getAttachmentsDir(): string {
  const workspaceDir = Config.getWorkspaceDir();
  return path.join(workspaceDir, 'attachments');
}

/**
 * Ensure attachments directory exists.
 */
async function ensureAttachmentsDir(): Promise<void> {
  const dir = getAttachmentsDir();
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    logger.error({ err: error, dir }, 'Failed to create attachments directory');
    throw error;
  }
}

/**
 * Sanitize filename to be safe for filesystem.
 */
function sanitizeFilename(fileName: string): string {
  // Remove or replace characters that are problematic in filenames
  return fileName
    .replace(/[<>:"/\\|?*]/g, '_') // Replace invalid characters
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .substring(0, 200); // Limit length
}

/**
 * Extract file extension from filename.
 * Returns the extension with dot (e.g., '.jpg', '.png') or empty string if not found.
 *
 * @param fileName - The filename to extract extension from
 * @param fileType - Optional file type for default extension if none found
 * @returns File extension with leading dot, or default based on fileType
 */
export function extractFileExtension(fileName: string, fileType?: string): string {
  if (!fileName) {
    return getDefaultExtension(fileType);
  }

  // Find the last dot in the filename
  const lastDotIndex = fileName.lastIndexOf('.');

  // If no dot, or dot is at the start (hidden file), use default
  if (lastDotIndex <= 0 || lastDotIndex === fileName.length - 1) {
    return getDefaultExtension(fileType);
  }

  // Extract and validate extension
  const extension = fileName.slice(lastDotIndex);

  // Basic validation: extension should be 2-10 chars and only contain alphanumeric
  const extWithoutDot = extension.slice(1);
  if (/^[a-zA-Z0-9]{2,10}$/.test(extWithoutDot)) {
    return extension.toLowerCase();
  }

  // If validation fails, use default
  return getDefaultExtension(fileType);
}

/**
 * Get default file extension based on file type.
 *
 * @param fileType - The type of file ('image', 'file', 'media', etc.)
 * @returns Default extension with leading dot
 */
function getDefaultExtension(fileType?: string): string {
  switch (fileType) {
    case 'image':
      return '.jpg'; // Most common image format
    case 'file':
      return '.bin'; // Unknown binary file
    case 'media':
      return '.mp4'; // Most common video format
    case 'video':
      return '.mp4'; // Video format
    case 'audio':
      return '.mp3'; // Most common audio format
    default:
      return ''; // No default extension
  }
}

/**
 * Map internal file type to Feishu API-supported type.
 *
 * Feishu messageResource.get API only supports these types:
 * - 'file' - Generic files
 * - 'image' - Images
 * - 'video' - Videos (not 'media'!)
 * - 'audio' - Audio files
 *
 * @param fileType - Internal file type from message
 * @param fileName - Optional filename to detect special cases
 * @returns Feishu API-compatible file type
 */
function mapToFileType(fileType: string, fileName?: string): string {
  const typeMap: Record<string, string> = {
    'file': 'file',
    'image': 'image',
    'media': 'video',  // Critical fix: 'media' → 'video'
    'video': 'video',
    'audio': 'audio',
  };

  // Special handling for .MOV files (case-insensitive)
  // Some MOV files (especially iPhone videos) may not work with 'video' type
  // Try using 'file' type as fallback for problematic formats
  if (fileName && fileType === 'media') {
    const ext = fileName.toLowerCase();
    // For .mov files, use 'file' type to avoid API errors
    if (ext.endsWith('.mov')) {
      return 'file';
    }
  }

  return typeMap[fileType] || 'file'; // Default to 'file' for unknown types
}

/**
 * Download a file from Feishu using file_key or image_key.
 *
 * Uses different APIs based on file type:
 * - Images (message images): Uses message resource API with message_id
 * - Files (drive files): Uses message resource API with message_id
 * - Media (audio/video): Uses message resource API with message_id
 *
 * IMPORTANT: For user-uploaded files in messages, we MUST use the message-resource API,
 * NOT the direct image.get or file.download APIs. Those only work for files uploaded by the bot.
 *
 * @param client - Lark API client
 * @param fileKey - Feishu file key (image_key or file_key)
 * @param fileType - File type (image, file, media, etc.)
 * @param fileName - Optional original filename
 * @param messageId - The message ID containing the file (REQUIRED for user uploads)
 * @returns Local file path
 */
export async function downloadFile(
  client: lark.Client,
  fileKey: string,
  fileType: string,
  fileName?: string,
  messageId?: string
): Promise<string> {
  await ensureAttachmentsDir();

  // Generate local filename
  const timestamp = Date.now();
  const sanitizedFileName = fileName
    ? sanitizeFilename(fileName)
    : `${fileType}_${fileKey.substring(0, 16)}`;

  // Extract and preserve file extension
  const extension = extractFileExtension(fileName || sanitizedFileName, fileType);

  // Remove extension from sanitized filename to avoid duplication
  const baseFileName = extension
    ? sanitizedFileName.replace(new RegExp(`${extension}$`, 'i'), '')
    : sanitizedFileName;

  const localFileName = `${timestamp}_${baseFileName}${extension}`;
  const localPath = path.join(getAttachmentsDir(), localFileName);

  logger.info({ fileKey, fileType, fileName, messageId, localPath }, 'Downloading file from Feishu');

  try {
    let fileResource: FileResourceResponse;

    // For user-uploaded files in messages, we MUST use messageResource.get API
    // This API retrieves files from messages regardless of who uploaded them
    if (messageId) {
      logger.debug({ messageId, fileKey, fileType, fileName }, 'Downloading message file using message-resource API');

      // Map internal file type to Feishu API type
      // Required params: 'file', 'image', 'video', or 'audio'
      // Pass fileName to handle special cases like .MOV files
      const apiFileType = mapToFileType(fileType, fileName);

      logger.debug({ messageId, fileKey, fileType, fileName, apiFileType }, 'Using file type for API call');

      // SDK type doesn't include params.type, so we need to cast
      fileResource = await client.im.messageResource.get({
        path: {
          message_id: messageId,
          file_key: fileKey,
        },
        params: {
          type: apiFileType,
        },
      }) as unknown as FileResourceResponse;
    } else if (fileType === 'image') {
      // Fallback: Try direct image API (only works for bot-uploaded images)
      // Reference: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/image/get
      logger.debug({ imageKey: fileKey }, 'Downloading image using direct IM API (bot uploads only)');

      fileResource = await client.im.image.get({
        path: {
          image_key: fileKey,
        },
      }) as unknown as FileResourceResponse;
    } else {
      // Fallback: Try Drive API (only works for drive files uploaded by bot)
      // Reference: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/file/download
      logger.debug({ fileToken: fileKey }, 'Downloading drive file using Drive API (bot uploads only)');

      fileResource = await client.drive.file.download({
        path: {
          file_token: fileKey,
        },
      }) as unknown as FileResourceResponse;
    }

    // Check if response contains file resource
    if (!fileResource) {
      throw new Error('Empty response from Feishu API');
    }

    // The fileResource has writeFile method to save directly
    // Also supports getReadableStream() for streaming
    await fileResource.writeFile(localPath);

    // Get file size for logging
    const stats = await fs.stat(localPath);

    logger.info({ fileKey, localPath, size: stats.size }, 'File downloaded successfully');

    return localPath;
  } catch (error: unknown) {
    // Extract detailed error response from Feishu API
    const apiError = error as FeishuApiError;
    const errorDetails: Record<string, unknown> = {
      fileKey,
      fileType,
      messageId,
      errorMessage: apiError.message,
      errorCode: apiError.code,
    };

    // Add response data if available
    if (apiError.response) {
      errorDetails.statusCode = apiError.response.status;
      errorDetails.statusMessage = apiError.response.statusText;
      errorDetails.responseData = apiError.response.data;
    }

    logger.error({ err: error, ...errorDetails }, 'Failed to download file');
    throw error;
  }
}
