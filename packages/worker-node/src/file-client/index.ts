/**
 * File Client for Worker Node.
 *
 * This client allows the Worker Node to interact with the Primary Node's
 * file transfer API for uploading and downloading files.
 *
 * @see Issue #1041 - Separate Worker Node code to @disclaude/worker-node
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  createLogger,
  type FileRef,
  type FileUploadRequest,
  type FileUploadResponse,
  type FileDownloadResponse,
} from '@disclaude/core';

const logger = createLogger('FileClient');

/**
 * File client configuration.
 */
export interface FileClientConfig {
  /** Primary Node HTTP URL */
  commNodeUrl: string;

  /** Request timeout (ms), default 30 seconds */
  timeout?: number;

  /** Download directory for saving downloaded files */
  downloadDir?: string;
}

/**
 * API response structure.
 */
interface APIResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Detect MIME type from file extension.
 */
function detectMimeType(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.ts': 'application/typescript',
    '.py': 'text/x-python',
    '.java': 'text/x-java-source',
    '.c': 'text/x-c',
    '.cpp': 'text/x-c++src',
    '.h': 'text/x-cheader',
  };
  return mimeTypes[ext];
}

/**
 * File Client for Worker Node.
 *
 * Usage:
 * ```typescript
 * const fileClient = new FileClient({
 *   commNodeUrl: 'http://localhost:3001',
 *   downloadDir: './downloads',
 * });
 *
 * // Upload a file
 * const fileRef = await fileClient.uploadFile('/path/to/file.pdf', 'chat-123');
 *
 * // Download a file
 * const localPath = await fileClient.downloadToFile(fileRef);
 * ```
 */
export class FileClient {
  private baseUrl: string;
  private timeout: number;
  private downloadDir?: string;

  constructor(config: FileClientConfig) {
    this.baseUrl = config.commNodeUrl.replace(/\/$/, '');
    this.timeout = config.timeout ?? 30000;
    this.downloadDir = config.downloadDir;

    logger.info({
      baseUrl: this.baseUrl,
      timeout: this.timeout,
      downloadDir: this.downloadDir,
    }, 'FileClient created');
  }

  /**
   * Upload a file to Primary Node.
   *
   * @param filePath - Local file path to upload
   * @param chatId - Optional chat ID for context association
   * @returns FileRef for the uploaded file
   */
  async uploadFile(filePath: string, chatId?: string): Promise<FileRef> {
    const buffer = await fs.readFile(filePath);
    const fileName = path.basename(filePath);
    const mimeType = detectMimeType(filePath);

    logger.info({ filePath, fileName, size: buffer.length, chatId }, 'Uploading file');

    const request: FileUploadRequest = {
      fileName,
      mimeType: mimeType || 'application/octet-stream',
      content: buffer.toString('base64'),
      chatId,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/api/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to upload file: ${response.status} ${text}`);
      }

      const result = (await response.json()) as APIResponse<FileUploadResponse>;

      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to upload file');
      }

      logger.info(
        { fileId: result.data.fileRef.id, fileName },
        'File uploaded successfully'
      );

      return result.data.fileRef;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Download a file from Primary Node.
   *
   * @param fileRef - File reference to download
   * @returns File content as Buffer
   */
  async downloadFile(fileRef: FileRef): Promise<Buffer> {
    logger.info({ fileId: fileRef.id, fileName: fileRef.fileName }, 'Downloading file');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/api/files/${fileRef.id}`, {
        method: 'GET',
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to download file: ${response.status} ${text}`);
      }

      const result = (await response.json()) as APIResponse<FileDownloadResponse>;

      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to download file');
      }

      logger.info(
        { fileId: fileRef.id, size: result.data.content.length },
        'File downloaded'
      );

      return Buffer.from(result.data.content, 'base64');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Download a file and save to local path.
   *
   * @param fileRef - File reference to download
   * @param localPath - Optional local path (auto-generated if not provided)
   * @returns Local path where the file was saved
   */
  async downloadToFile(fileRef: FileRef, localPath?: string): Promise<string> {
    const buffer = await this.downloadFile(fileRef);

    const savePath =
      localPath ||
      path.join(this.downloadDir || '/tmp', fileRef.id, fileRef.fileName);

    await fs.mkdir(path.dirname(savePath), { recursive: true });
    await fs.writeFile(savePath, buffer);

    logger.info({ fileId: fileRef.id, savePath }, 'File saved to local path');

    return savePath;
  }

  /**
   * Get file info without downloading content.
   *
   * @param fileId - File ID to get info for
   * @returns File reference or null if not found
   */
  async getFileInfo(fileId: string): Promise<FileRef | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/api/files/${fileId}/info`, {
        method: 'GET',
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        const text = await response.text();
        throw new Error(`Failed to get file info: ${response.status} ${text}`);
      }

      const result = (await response.json()) as APIResponse<{ fileRef: FileRef }>;

      if (!result.success || !result.data) {
        return null;
      }

      return result.data.fileRef;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
