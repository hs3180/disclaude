/**
 * Tests for File Transfer API Handler.
 *
 * @see file-api.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFileTransferAPIHandler } from './file-api.js';
import type { FileStorageService } from './file-storage.js';
import type { IncomingMessage, ServerResponse } from 'http';

// Mock @disclaude/core
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function createMockStorage(): FileStorageService {
  return {
    initialize: vi.fn(),
    storeFromBase64: vi.fn(),
    get: vi.fn().mockReturnValue(undefined),
    getContent: vi.fn(),
    getLocalPath: vi.fn(),
    delete: vi.fn().mockReturnValue(false),
    has: vi.fn().mockReturnValue(false),
    getStats: vi.fn().mockReturnValue({ totalFiles: 0, totalSize: 0 }),
    shutdown: vi.fn(),
  } as unknown as FileStorageService;
}

function createMockReq(
  method: string,
  url: string,
  body?: object
): IncomingMessage {
  const req = {
    method,
    url,
    on: vi.fn(),
    destroy: vi.fn(),
  } as unknown as IncomingMessage;

  if (body) {
    const bodyStr = JSON.stringify(body);
    let dataEmitted = false;

    (req.on as any).mockImplementation((event: string, handler: any) => {
      if (event === 'data' && !dataEmitted) {
        handler(Buffer.from(bodyStr));
        dataEmitted = true;
      }
      if (event === 'end') {
        handler();
      }
    });
  }

  return req;
}

function createMockRes(): ServerResponse {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
}

describe('createFileTransferAPIHandler', () => {
  let storage: FileStorageService;
  let handler: ReturnType<typeof createFileTransferAPIHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = createMockStorage();
    handler = createFileTransferAPIHandler({
      storageService: storage,
      maxBodySize: 1024 * 1024,
    });
  });

  it('should return false for non-API requests', async () => {
    const req = createMockReq('GET', '/other/path');
    const res = createMockRes();

    const result = await handler(req, res);
    expect(result).toBe(false);
  });

  describe('GET /api/files', () => {
    it('should return storage stats', async () => {
      (storage.getStats as any).mockReturnValue({
        totalFiles: 5,
        totalSize: 1024,
      });

      const req = createMockReq('GET', '/api/files');
      const res = createMockRes();

      const result = await handler(req, res);
      expect(result).toBe(true);
      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'application/json',
      });
      const response = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(response.success).toBe(true);
      expect(response.data).toEqual({ totalFiles: 5, totalSize: 1024 });
    });
  });

  describe('POST /api/files', () => {
    it('should upload file successfully', async () => {
      const fileRef = {
        id: 'file_123',
        fileName: 'test.txt',
        source: 'agent',
        size: 100,
      };
      (storage.storeFromBase64 as any).mockResolvedValue(fileRef);

      const req = createMockReq('POST', '/api/files', {
        fileName: 'test.txt',
        content: 'dGVzdA==',
        mimeType: 'text/plain',
        chatId: 'chat_1',
      });
      const res = createMockRes();

      const result = await handler(req, res);
      expect(result).toBe(true);
      expect(storage.storeFromBase64).toHaveBeenCalledWith(
        'dGVzdA==',
        'test.txt',
        'text/plain',
        'agent',
        'chat_1'
      );

      const response = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(response.success).toBe(true);
      expect(response.data.fileRef.id).toBe('file_123');
    });

    it('should reject upload with missing fields', async () => {
      const req = createMockReq('POST', '/api/files', {
        fileName: 'test.txt',
        // content missing
      });
      const res = createMockRes();

      const result = await handler(req, res);
      expect(result).toBe(true);

      const response = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(response.success).toBe(false);
      expect(response.error).toContain('Missing required fields');
      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });
  });

  describe('GET /api/files/:id', () => {
    it('should download file by id', async () => {
      const storedFile = {
        ref: { id: 'file_1', fileName: 'test.txt', size: 10 },
        localPath: '/storage/file_1/test.txt',
      };
      (storage.get as any).mockReturnValue(storedFile);
      (storage.getContent as any).mockResolvedValue('base64content');

      const req = createMockReq('GET', '/api/files/file_1');
      const res = createMockRes();

      const result = await handler(req, res);
      expect(result).toBe(true);

      const response = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(response.success).toBe(true);
      expect(response.data.content).toBe('base64content');
    });

    it('should return 404 for non-existent file', async () => {
      (storage.get as any).mockReturnValue(undefined);

      const req = createMockReq('GET', '/api/files/nonexistent');
      const res = createMockRes();

      const result = await handler(req, res);
      expect(result).toBe(true);

      const response = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(response.success).toBe(false);
      expect(response.error).toBe('File not found');
      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });
  });

  describe('GET /api/files/:id/info', () => {
    it('should return file info', async () => {
      const storedFile = {
        ref: { id: 'file_1', fileName: 'test.txt', size: 100 },
        localPath: '/storage/file_1/test.txt',
      };
      (storage.get as any).mockReturnValue(storedFile);

      const req = createMockReq('GET', '/api/files/file_1/info');
      const res = createMockRes();

      const result = await handler(req, res);
      expect(result).toBe(true);

      const response = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(response.success).toBe(true);
      expect(response.data.fileRef.fileName).toBe('test.txt');
    });

    it('should return 404 for non-existent file info', async () => {
      (storage.get as any).mockReturnValue(undefined);

      const req = createMockReq('GET', '/api/files/nonexistent/info');
      const res = createMockRes();

      const result = await handler(req, res);
      expect(result).toBe(true);

      const response = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(response.success).toBe(false);
      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });
  });

  describe('DELETE /api/files/:id', () => {
    it('should delete a file', async () => {
      (storage.delete as any).mockResolvedValue(true);

      const req = createMockReq('DELETE', '/api/files/file_1');
      const res = createMockRes();

      const result = await handler(req, res);
      expect(result).toBe(true);

      const response = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(response.success).toBe(true);
      expect(response.data.deleted).toBe(true);
    });

    it('should return 404 when deleting non-existent file', async () => {
      (storage.delete as any).mockResolvedValue(false);

      const req = createMockReq('DELETE', '/api/files/nonexistent');
      const res = createMockRes();

      const result = await handler(req, res);
      expect(result).toBe(true);

      const response = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(response.success).toBe(false);
      expect(response.error).toBe('File not found');
    });
  });

  describe('unknown routes', () => {
    it('should return 404 for unmatched API routes', async () => {
      const req = createMockReq('PUT', '/api/files/xyz');
      const res = createMockRes();

      const result = await handler(req, res);
      expect(result).toBe(true);

      const response = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(response.success).toBe(false);
      expect(response.error).toBe('Not found');
    });
  });

  describe('error handling', () => {
    it('should handle storage errors gracefully', async () => {
      (storage.getStats as any).mockImplementation(() => {
        throw new Error('Storage corrupted');
      });

      const req = createMockReq('GET', '/api/files');
      const res = createMockRes();

      const result = await handler(req, res);
      expect(result).toBe(true);

      const response = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(response.success).toBe(false);
      expect(response.error).toBe('Storage corrupted');
      expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    });
  });
});
