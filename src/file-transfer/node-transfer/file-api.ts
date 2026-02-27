/**
 * File Transfer API Handler
 *
 * Provides HTTP API for file transfer between Communication Node and Execution Node.
 * Uses Node.js built-in http module.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createLogger } from '../../utils/logger.js';
import type { FileStorageService } from './file-storage.js';
import type {
  FileUploadRequest,
  FileUploadResponse,
  FileDownloadResponse,
} from '../../types/file-reference.js';

const logger = createLogger('FileTransferAPI');

/**
 * File Transfer API configuration.
 */
export interface FileTransferAPIConfig {
  /** File storage service */
  storageService: FileStorageService;

  /** Maximum request body size (bytes), default 100MB */
  maxBodySize?: number;
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
 * Read JSON body from request.
 */
function readJsonBody<T>(req: IncomingMessage, maxSize: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error(`Request body too large: ${size} > ${maxSize}`));
        return;
      }
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(body) as T);
      } catch (error) {
        reject(new Error(`Invalid JSON: ${(error as Error).message}`));
      }
    });

    req.on('error', reject);
  });
}

/**
 * Send JSON response.
 */
function sendJson<T>(res: ServerResponse, statusCode: number, response: APIResponse<T>): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
}

/**
 * Create file transfer API handler.
 *
 * Returns a function that handles HTTP requests for the file API.
 *
 * Routes:
 * - POST /api/files - Upload file
 * - GET /api/files/:id - Download file
 * - GET /api/files/:id/info - Get file info
 * - DELETE /api/files/:id - Delete file
 * - GET /api/files - Get storage stats
 */
export function createFileTransferAPIHandler(config: FileTransferAPIConfig) {
  const { storageService, maxBodySize = 100 * 1024 * 1024 } = config;

  /**
   * Handle file API requests.
   */
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = req.url || '/';
    const method = req.method || 'GET';

    // Parse URL path
    const [urlPath] = url.split('?');
    const pathParts = urlPath.split('/').filter(Boolean);

    // Check if this is a file API request
    if (pathParts[0] !== 'api' || pathParts[1] !== 'files') {
      return false; // Not a file API request
    }

    try {
      // GET /api/files - Get storage stats
      if (method === 'GET' && pathParts.length === 2) {
        const stats = storageService.getStats();
        sendJson(res, 200, { success: true, data: stats });
        return true;
      }

      // POST /api/files - Upload file
      if (method === 'POST' && pathParts.length === 2) {
        const request = await readJsonBody<FileUploadRequest>(req, maxBodySize);
        const { fileName, mimeType, content, chatId } = request;

        if (!fileName || !content) {
          sendJson(res, 400, { success: false, error: 'Missing required fields: fileName, content' });
          return true;
        }

        const fileRef = await storageService.storeFromBase64(
          content,
          fileName,
          mimeType,
          'agent',
          chatId
        );

        logger.info({
          fileId: fileRef.id,
          fileName,
          chatId,
          size: fileRef.size,
        }, 'File uploaded via API');

        sendJson(res, 200, { success: true, data: { fileRef } as FileUploadResponse });
        return true;
      }

      // Routes with file ID
      const [, , fileId] = pathParts;

      if (!fileId) {
        sendJson(res, 400, { success: false, error: 'File ID required' });
        return true;
      }

      // GET /api/files/:id/info - Get file info
      if (method === 'GET' && pathParts[3] === 'info') {
        const stored = storageService.get(fileId);
        if (!stored) {
          sendJson(res, 404, { success: false, error: 'File not found' });
          return true;
        }

        sendJson(res, 200, { success: true, data: { fileRef: stored.ref } });
        return true;
      }

      // GET /api/files/:id - Download file
      if (method === 'GET' && pathParts.length === 3) {
        const stored = storageService.get(fileId);
        if (!stored) {
          sendJson(res, 404, { success: false, error: 'File not found' });
          return true;
        }

        const content = await storageService.getContent(fileId);

        logger.info({
          fileId,
          fileName: stored.ref.fileName,
        }, 'File downloaded via API');

        sendJson(res, 200, {
          success: true,
          data: {
            fileRef: stored.ref,
            content,
          } as FileDownloadResponse,
        });
        return true;
      }

      // DELETE /api/files/:id - Delete file
      if (method === 'DELETE' && pathParts.length === 3) {
        const deleted = await storageService.delete(fileId);

        if (!deleted) {
          sendJson(res, 404, { success: false, error: 'File not found' });
          return true;
        }

        logger.info({ fileId }, 'File deleted via API');

        sendJson(res, 200, { success: true, data: { deleted: true } });
        return true;
      }

      // Unknown route
      sendJson(res, 404, { success: false, error: 'Not found' });
      return true;

    } catch (error) {
      const err = error as Error;
      logger.error({ err }, 'File API error');
      sendJson(res, 500, { success: false, error: err.message });
      return true;
    }
  };
}

export type FileTransferAPIHandler = ReturnType<typeof createFileTransferAPIHandler>;
