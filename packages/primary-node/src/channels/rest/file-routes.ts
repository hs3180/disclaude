/**
 * REST channel file-route handlers (Issue #4127).
 *
 * Extracted from rest-channel.ts. Owns the three /api/files/* endpoints:
 *   - POST /api/files/upload          → handleUpload
 *   - GET  /api/files/:fileId         → handleInfo
 *   - GET  /api/files/:fileId/download → handleDownload
 *
 * Dependencies (file storage, body reading, error responses, file→chat map)
 * are injected via FileRouteDeps so this module stays decoupled from the
 * RestChannel class, mirroring the channels/rest/session-manager.ts pattern.
 *
 * @module primary-node/channels/rest/file-routes
 */

import type http from 'node:http';
import { createLogger, type FileRef } from '@disclaude/core';
import type { IFileStorageService } from '../rest-channel.js';

const logger = createLogger('RestFileRoutes');

/** File upload request body (POST /api/files/upload). */
export interface FileUploadRequest {
  /** File name. */
  fileName: string;
  /** MIME type (optional). */
  mimeType?: string;
  /** File content (base64 encoded). */
  content: string;
  /** Associated chat ID (optional). */
  chatId?: string;
}

/** File upload response. */
export interface FileUploadResponse {
  /** Success status. */
  success: boolean;
  /** File reference. */
  file?: FileRef;
  /** Error message (if failed). */
  error?: string;
}

/** File info (metadata) response. */
export interface FileInfoResponse {
  /** Success status. */
  success: boolean;
  /** File reference. */
  file?: FileRef;
  /** Error message (if failed). */
  error?: string;
}

/** File download response. */
export interface FileDownloadResponse {
  /** Success status. */
  success: boolean;
  /** File reference. */
  file?: FileRef;
  /** File content (base64 encoded). */
  content?: string;
  /** Error message (if failed). */
  error?: string;
}

/** Dependencies injected from RestChannel. */
export interface FileRouteDeps {
  /** Accessor for the (lazily-initialized) file storage service. */
  getFileStorage(): IFileStorageService | undefined;
  /** Shared file-id → chat-id map (owned by RestChannel). */
  fileToChat: Map<string, string>;
  /** Reads and returns the request body. */
  readBody(req: http.IncomingMessage): Promise<string>;
  /** Writes a JSON error response with the given status. */
  sendError(res: http.ServerResponse, status: number, message: string): void;
}

/**
 * Handles the /api/files/* routes for the REST channel.
 *
 * @see Issue #583 - REST Channel file transfer
 * @see Issue #4127 - extract RestChannel into channels/rest/
 */
export class FileRouteHandlers {
  constructor(private readonly deps: FileRouteDeps) {}

  /**
   * POST /api/files/upload — store a base64-encoded file.
   */
  async handleUpload(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const fileStorage = this.deps.getFileStorage();
    if (!fileStorage) {
      this.deps.sendError(res, 500, 'File storage not initialized');
      return;
    }

    const body = await this.deps.readBody(req);
    if (!body) {
      this.deps.sendError(res, 400, 'Empty request body');
      return;
    }

    let uploadRequest: FileUploadRequest;
    try {
      uploadRequest = JSON.parse(body) as FileUploadRequest;
    } catch {
      this.deps.sendError(res, 400, 'Invalid JSON');
      return;
    }

    // Validate request
    if (!uploadRequest.fileName) {
      this.deps.sendError(res, 400, 'fileName is required');
      return;
    }
    if (!uploadRequest.content) {
      this.deps.sendError(res, 400, 'content is required');
      return;
    }

    // Validate base64 content
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    if (!base64Regex.test(uploadRequest.content.replace(/\s/g, ''))) {
      this.deps.sendError(res, 400, 'Invalid base64 content');
      return;
    }

    try {
      const fileRef = await fileStorage.storeFromBase64(
        uploadRequest.content,
        uploadRequest.fileName,
        uploadRequest.mimeType,
        'user',
        uploadRequest.chatId,
      );

      // Track file-to-chat mapping
      if (uploadRequest.chatId) {
        this.deps.fileToChat.set(fileRef.id, uploadRequest.chatId);
      }

      logger.info({ fileId: fileRef.id, fileName: uploadRequest.fileName }, 'File uploaded');

      const response: FileUploadResponse = {
        success: true,
        file: fileRef,
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (error) {
      logger.error({ err: error }, 'Failed to store file');
      this.deps.sendError(res, 500, 'Failed to store file');
    }
  }

  /**
   * GET /api/files/:fileId — file metadata.
   */
  async handleInfo(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    fileId: string,
  ): Promise<void> {
    // Satisfy require-await rule
    await Promise.resolve();

    const fileStorage = this.deps.getFileStorage();
    if (!fileStorage) {
      this.deps.sendError(res, 500, 'File storage not initialized');
      return;
    }

    const stored = fileStorage.get(fileId);
    if (!stored) {
      const response: FileInfoResponse = {
        success: false,
        error: 'File not found',
      };
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
      return;
    }

    logger.info({ fileId }, 'File info requested');

    const response: FileInfoResponse = {
      success: true,
      file: stored.ref,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  /**
   * GET /api/files/:fileId/download — file metadata + base64 content.
   */
  async handleDownload(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    fileId: string,
  ): Promise<void> {
    const fileStorage = this.deps.getFileStorage();
    if (!fileStorage) {
      this.deps.sendError(res, 500, 'File storage not initialized');
      return;
    }

    const stored = fileStorage.get(fileId);
    if (!stored) {
      const response: FileDownloadResponse = {
        success: false,
        error: 'File not found',
      };
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
      return;
    }

    try {
      const content = await fileStorage.getContent(fileId);

      logger.info({ fileId, size: content.length }, 'File downloaded');

      const response: FileDownloadResponse = {
        success: true,
        file: stored.ref,
        content,
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (error) {
      logger.error({ err: error, fileId }, 'Failed to read file content');
      this.deps.sendError(res, 500, 'Failed to read file content');
    }
  }
}
