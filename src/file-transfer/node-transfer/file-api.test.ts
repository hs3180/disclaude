/**
 * Tests for File Transfer API Handler (src/file-transfer/node-transfer/file-api.ts)
 *
 * Tests the following functionality:
 * - API request handling
 * - File upload endpoint
 * - File download endpoint
 * - File info endpoint
 * - File delete endpoint
 * - Storage stats endpoint
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as http from 'http';
import { createFileTransferAPIHandler } from './file-api.js';
import type { FileStorageService } from './file-storage.js';

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

// Create mock storage service
const createMockStorageService = (): FileStorageService => {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    storeFromLocal: vi.fn().mockResolvedValue({ id: 'test-id', fileName: 'test.txt' }),
    storeFromBase64: vi.fn().mockResolvedValue({
      id: 'test-id',
      fileName: 'test.txt',
      size: 100,
    }),
    get: vi.fn().mockReturnValue({
      ref: { id: 'test-id', fileName: 'test.txt', size: 100 },
      localPath: '/tmp/test/test.txt',
    }),
    getContent: vi.fn().mockResolvedValue('dGVzdCBjb250ZW50'), // base64 of 'test content'
    getLocalPath: vi.fn().mockReturnValue('/tmp/test/test.txt'),
    delete: vi.fn().mockResolvedValue(true),
    has: vi.fn().mockReturnValue(true),
    getStats: vi.fn().mockReturnValue({ totalFiles: 5, totalSize: 1000 }),
    shutdown: vi.fn(),
  } as unknown as FileStorageService;
};

describe('createFileTransferAPIHandler', () => {
  let mockStorage: FileStorageService;
  let handler: ReturnType<typeof createFileTransferAPIHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage = createMockStorageService();
    handler = createFileTransferAPIHandler({
      storageService: mockStorage,
      maxBodySize: 1000000,
    });
  });

  const createMockRequest = (
    method: string,
    url: string,
    body?: string
  ): http.IncomingMessage => {
    const req = {
      method,
      url,
      on: vi.fn((event: string, callback: (chunk?: unknown) => void) => {
        if (event === 'data' && body) {
          callback(Buffer.from(body));
        }
        if (event === 'end') {
          callback();
        }
        return req;
      }),
      destroy: vi.fn(),
    } as unknown as http.IncomingMessage;
    return req;
  };

  const createMockResponse = () => {
    const res = {
      writeHead: vi.fn(),
      end: vi.fn(),
      statusCode: 200,
    };
    return res as unknown as http.ServerResponse;
  };

  describe('route matching', () => {
    it('should return false for non-API requests', async () => {
      const req = createMockRequest('GET', '/health');
      const res = createMockResponse();

      const handled = await handler(req, res);
      expect(handled).toBe(false);
    });

    it('should return false for non-file API requests', async () => {
      const req = createMockRequest('GET', '/api/users');
      const res = createMockResponse();

      const handled = await handler(req, res);
      expect(handled).toBe(false);
    });
  });

  describe('GET /api/files - storage stats', () => {
    it('should return storage statistics', async () => {
      const req = createMockRequest('GET', '/api/files');
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      expect(mockStorage.getStats).toHaveBeenCalled();
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    });
  });

  describe('POST /api/files - upload file', () => {
    it('should upload file successfully', async () => {
      const body = JSON.stringify({
        fileName: 'test.txt',
        mimeType: 'text/plain',
        content: 'dGVzdA==', // base64 of 'test'
        chatId: 'chat_123',
      });
      const req = createMockRequest('POST', '/api/files', body);
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      expect(mockStorage.storeFromBase64).toHaveBeenCalledWith(
        'dGVzdA==',
        'test.txt',
        'text/plain',
        'agent',
        'chat_123'
      );
    });

    it('should reject upload without fileName', async () => {
      const body = JSON.stringify({
        content: 'dGVzdA==',
      });
      const req = createMockRequest('POST', '/api/files', body);
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      const endCall = (res.end as ReturnType<typeof vi.fn>).mock.calls[0];
      const response = JSON.parse(endCall[0]);
      expect(response.success).toBe(false);
      expect(response.error).toContain('Missing required fields');
    });

    it('should reject upload without content', async () => {
      const body = JSON.stringify({
        fileName: 'test.txt',
      });
      const req = createMockRequest('POST', '/api/files', body);
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      const endCall = (res.end as ReturnType<typeof vi.fn>).mock.calls[0];
      const response = JSON.parse(endCall[0]);
      expect(response.success).toBe(false);
    });
  });

  describe('GET /api/files/:id/info - file info', () => {
    it('should return file info', async () => {
      const req = createMockRequest('GET', '/api/files/test-id/info');
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      expect(mockStorage.get).toHaveBeenCalledWith('test-id');
    });

    it('should return 404 for non-existent file', async () => {
      (mockStorage.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);
      const req = createMockRequest('GET', '/api/files/nonexistent/info');
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      const endCall = (res.end as ReturnType<typeof vi.fn>).mock.calls[0];
      const response = JSON.parse(endCall[0]);
      expect(response.success).toBe(false);
      expect(response.error).toContain('not found');
    });
  });

  describe('GET /api/files/:id - download file', () => {
    it('should download file', async () => {
      const req = createMockRequest('GET', '/api/files/test-id');
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      expect(mockStorage.get).toHaveBeenCalledWith('test-id');
      expect(mockStorage.getContent).toHaveBeenCalledWith('test-id');
    });

    it('should return 404 for non-existent file download', async () => {
      (mockStorage.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);
      const req = createMockRequest('GET', '/api/files/nonexistent');
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      const endCall = (res.end as ReturnType<typeof vi.fn>).mock.calls[0];
      const response = JSON.parse(endCall[0]);
      expect(response.success).toBe(false);
      expect(response.error).toContain('not found');
    });
  });

  describe('DELETE /api/files/:id - delete file', () => {
    it('should delete file', async () => {
      const req = createMockRequest('DELETE', '/api/files/test-id');
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      expect(mockStorage.delete).toHaveBeenCalledWith('test-id');
    });

    it('should return 404 for non-existent file delete', async () => {
      (mockStorage.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
      const req = createMockRequest('DELETE', '/api/files/nonexistent');
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      const endCall = (res.end as ReturnType<typeof vi.fn>).mock.calls[0];
      const response = JSON.parse(endCall[0]);
      expect(response.success).toBe(false);
      expect(response.error).toContain('not found');
    });
  });

  describe('error handling', () => {
    it('should handle storage errors', async () => {
      (mockStorage.get as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Storage error');
      });
      const req = createMockRequest('GET', '/api/files/test-id/info');
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      const endCall = (res.end as ReturnType<typeof vi.fn>).mock.calls[0];
      const response = JSON.parse(endCall[0]);
      expect(response.success).toBe(false);
      expect(response.error).toContain('Storage error');
    });
  });
});
