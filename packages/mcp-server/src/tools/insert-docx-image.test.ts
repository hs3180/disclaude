/**
 * Tests for insert_docx_image tool (packages/mcp-server/src/tools/insert-docx-image.ts)
 *
 * Issue #2278: Inline image insertion into Feishu documents.
 *
 * Tests cover:
 * - Parameter validation
 * - Credential validation
 * - File validation (existence, type, size)
 * - Three-step API flow (create block → upload → bind)
 * - Error handling at each API step
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('./credentials.js', () => ({
  getFeishuCredentials: vi.fn(),
  getWorkspaceDir: vi.fn(() => '/workspace'),
}));

vi.mock('fs/promises', () => ({
  stat: vi.fn(),
  readFile: vi.fn(),
}));

import { insert_docx_image } from './insert-docx-image.js';
import { getFeishuCredentials, getWorkspaceDir } from './credentials.js';
import * as fs from 'fs/promises';

// Mock global fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

/**
 * Helper: create a successful JSON fetch response.
 */
function mockFetchResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  } as Response;
}

describe('insert_docx_image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getFeishuCredentials).mockReturnValue({
      appId: 'test-app-id',
      appSecret: 'test-app-secret',
    });
    vi.mocked(getWorkspaceDir).mockReturnValue('/workspace');
    vi.mocked(fs.stat).mockResolvedValue({
      isFile: () => true,
      size: 1024 * 100, // 100 KB
    } as any);
    vi.mocked(fs.readFile).mockResolvedValue(
      Buffer.from('fake-image-data'),
    );
  });

  describe('parameter validation', () => {
    it('should return error when documentId is empty', async () => {
      const result = await insert_docx_image({
        documentId: '',
        filePath: '/test/image.png',
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('documentId is required');
    });

    it('should return error when filePath is empty', async () => {
      const result = await insert_docx_image({
        documentId: 'doxcn123',
        filePath: '',
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('filePath is required');
    });
  });

  describe('credential validation', () => {
    it('should return error when appId is missing', async () => {
      vi.mocked(getFeishuCredentials).mockReturnValue({
        appId: undefined,
        appSecret: 'secret',
      });
      const result = await insert_docx_image({
        documentId: 'doxcn123',
        filePath: '/test/image.png',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('credentials');
    });

    it('should return error when appSecret is missing', async () => {
      vi.mocked(getFeishuCredentials).mockReturnValue({
        appId: 'app-id',
        appSecret: undefined,
      });
      const result = await insert_docx_image({
        documentId: 'doxcn123',
        filePath: '/test/image.png',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('credentials');
    });
  });

  describe('file validation', () => {
    it('should return error when file does not exist', async () => {
      vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT: no such file'));
      const result = await insert_docx_image({
        documentId: 'doxcn123',
        filePath: '/nonexistent.png',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('ENOENT');
    });

    it('should return error when path is a directory', async () => {
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => false,
        size: 0,
      } as any);
      const result = await insert_docx_image({
        documentId: 'doxcn123',
        filePath: '/some/directory',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not a file');
    });

    it('should return error when file exceeds 20 MB', async () => {
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => true,
        size: 21 * 1024 * 1024, // 21 MB
      } as any);
      const result = await insert_docx_image({
        documentId: 'doxcn123',
        filePath: '/large-image.png',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('too large');
    });

    it('should resolve relative paths using workspace dir', async () => {
      // Mock successful three-step API flow
      mockFetch
        .mockResolvedValueOnce(
          mockFetchResponse({ code: 0, tenant_access_token: 'test-token' }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse({
            code: 0,
            data: { children: [{ block_id: 'blk_123' }] },
          }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse({ code: 0, data: { file_token: 'ft_123' } }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse({ code: 0 }),
        );

      await insert_docx_image({
        documentId: 'doxcn123',
        filePath: 'images/photo.png',
      });

      expect(fs.stat).toHaveBeenCalledWith('/workspace/images/photo.png');
    });

    it('should use absolute paths directly', async () => {
      mockFetch
        .mockResolvedValueOnce(
          mockFetchResponse({ code: 0, tenant_access_token: 'test-token' }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse({
            code: 0,
            data: { children: [{ block_id: 'blk_123' }] },
          }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse({ code: 0, data: { file_token: 'ft_123' } }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse({ code: 0 }),
        );

      await insert_docx_image({
        documentId: 'doxcn123',
        filePath: '/absolute/path/image.png',
      });

      expect(fs.stat).toHaveBeenCalledWith('/absolute/path/image.png');
    });
  });

  describe('tenant_access_token acquisition', () => {
    it('should return error when token request fails', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({ code: 10014, msg: 'invalid app_id or app_secret' }),
      );

      const result = await insert_docx_image({
        documentId: 'doxcn123',
        filePath: '/test/image.png',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('tenant_access_token');
      expect(result.error).toContain('10014');
    });
  });

  describe('three-step API flow', () => {
    beforeEach(() => {
      // Default: successful auth
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({ code: 0, tenant_access_token: 'test-token' }),
      );
    });

    it('should return error when create image block fails', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({ code: 2320001, msg: 'document not found' }),
      );

      const result = await insert_docx_image({
        documentId: 'doxcnInvalid',
        filePath: '/test/image.png',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('create image block');
      expect(result.error).toContain('2320001');
    });

    it('should return error when block_id is missing in response', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({ code: 0, data: { children: [{}] } }),
      );

      const result = await insert_docx_image({
        documentId: 'doxcn123',
        filePath: '/test/image.png',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('block_id not returned');
    });

    it('should return error when image upload fails', async () => {
      // Step 1 succeeds
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({
          code: 0,
          data: { children: [{ block_id: 'blk_123' }] },
        }),
      );
      // Step 2 fails
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({ code: 1060002, msg: 'file size exceeds limit' }),
      );

      const result = await insert_docx_image({
        documentId: 'doxcn123',
        filePath: '/test/image.png',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('upload image');
      expect(result.error).toContain('1060002');
    });

    it('should return error when file_token is missing in upload response', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({
          code: 0,
          data: { children: [{ block_id: 'blk_123' }] },
        }),
      );
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({ code: 0, data: {} }),
      );

      const result = await insert_docx_image({
        documentId: 'doxcn123',
        filePath: '/test/image.png',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('file_token not returned');
    });

    it('should return error when replace image fails', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({
          code: 0,
          data: { children: [{ block_id: 'blk_123' }] },
        }),
      );
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({ code: 0, data: { file_token: 'ft_123' } }),
      );
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({ code: 2320005, msg: 'block not found' }),
      );

      const result = await insert_docx_image({
        documentId: 'doxcn123',
        filePath: '/test/image.png',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('bind image');
      expect(result.error).toContain('2320005');
    });

    it('should succeed with all three steps', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({
          code: 0,
          data: { children: [{ block_id: 'blk_456' }] },
        }),
      );
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({ code: 0, data: { file_token: 'ft_456' } }),
      );
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({ code: 0 }),
      );

      const result = await insert_docx_image({
        documentId: 'doxcn123',
        filePath: '/test/image.png',
      });
      expect(result.success).toBe(true);
      expect(result.blockId).toBe('blk_456');
      expect(result.fileToken).toBe('ft_456');
      expect(result.message).toContain('image.png');
    });

    it('should pass index parameter to create block API', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({
          code: 0,
          data: { children: [{ block_id: 'blk_789' }] },
        }),
      );
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({ code: 0, data: { file_token: 'ft_789' } }),
      );
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({ code: 0 }),
      );

      const result = await insert_docx_image({
        documentId: 'doxcn123',
        filePath: '/test/image.png',
        index: 5,
      });
      expect(result.success).toBe(true);

      // Verify the second fetch call (create block) had index: 5 in the body
      const [, createBlockArgs] = mockFetch.mock.calls[1] as [unknown, RequestInit];
      const body = JSON.parse(createBlockArgs.body as string);
      expect(body.index).toBe(5);
    });

    it('should pass -1 as index when not specified (append to end)', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({
          code: 0,
          data: { children: [{ block_id: 'blk_000' }] },
        }),
      );
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({ code: 0, data: { file_token: 'ft_000' } }),
      );
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({ code: 0 }),
      );

      const result = await insert_docx_image({
        documentId: 'doxcn123',
        filePath: '/test/image.png',
      });
      expect(result.success).toBe(true);

      // Verify the create block call had index: -1
      const [, createBlockArgs] = mockFetch.mock.calls[1] as [unknown, RequestInit];
      const body2 = JSON.parse(createBlockArgs.body as string);
      expect(body2.index).toBe(-1);
    });
  });

  describe('network error handling', () => {
    it('should handle fetch rejection', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await insert_docx_image({
        documentId: 'doxcn123',
        filePath: '/test/image.png',
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('ECONNREFUSED');
    });
  });
});
