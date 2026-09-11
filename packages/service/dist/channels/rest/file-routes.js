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
 * @module service/channels/rest/file-routes
 */
import { createLogger } from "../../../../core/dist/index.js";
const logger = createLogger('RestFileRoutes');
/**
 * Handles the /api/files/* routes for the REST channel.
 *
 * @see Issue #583 - REST Channel file transfer
 * @see Issue #4127 - extract RestChannel into channels/rest/
 */
export class FileRouteHandlers {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * POST /api/files/upload — store a base64-encoded file.
     */
    async handleUpload(req, res) {
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
        let uploadRequest;
        try {
            uploadRequest = JSON.parse(body);
        }
        catch {
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
            const fileRef = await fileStorage.storeFromBase64(uploadRequest.content, uploadRequest.fileName, uploadRequest.mimeType, 'user', uploadRequest.chatId);
            // Track file-to-chat mapping
            if (uploadRequest.chatId) {
                this.deps.fileToChat.set(fileRef.id, uploadRequest.chatId);
            }
            logger.info({ fileId: fileRef.id, fileName: uploadRequest.fileName }, 'File uploaded');
            const response = {
                success: true,
                file: fileRef,
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
        }
        catch (error) {
            logger.error({ err: error }, 'Failed to store file');
            this.deps.sendError(res, 500, 'Failed to store file');
        }
    }
    /**
     * GET /api/files/:fileId — file metadata.
     */
    async handleInfo(_req, res, fileId) {
        // Satisfy require-await rule
        await Promise.resolve();
        const fileStorage = this.deps.getFileStorage();
        if (!fileStorage) {
            this.deps.sendError(res, 500, 'File storage not initialized');
            return;
        }
        const stored = fileStorage.get(fileId);
        if (!stored) {
            const response = {
                success: false,
                error: 'File not found',
            };
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
            return;
        }
        logger.info({ fileId }, 'File info requested');
        const response = {
            success: true,
            file: stored.ref,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
    }
    /**
     * GET /api/files/:fileId/download — file metadata + base64 content.
     */
    async handleDownload(_req, res, fileId) {
        const fileStorage = this.deps.getFileStorage();
        if (!fileStorage) {
            this.deps.sendError(res, 500, 'File storage not initialized');
            return;
        }
        const stored = fileStorage.get(fileId);
        if (!stored) {
            const response = {
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
            const response = {
                success: true,
                file: stored.ref,
                content,
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
        }
        catch (error) {
            logger.error({ err: error, fileId }, 'Failed to read file content');
            this.deps.sendError(res, 500, 'Failed to read file content');
        }
    }
}
