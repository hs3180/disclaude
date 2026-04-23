/**
 * Tests for insert_docx_image tool (packages/mcp-server/src/tools/insert-docx-image.ts)
 *
 * Issue #2278: Inline image insertion in Feishu documents.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// Store original fetch
const originalFetch = globalThis.fetch;

/**
 * Create a mock fetch response.
 */
function mockFetchResponse(data: Record<string, unknown>, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  } as Response;
}

/**
 * Create a mock fetch that routes requests based on URL patterns.
 */
function createMockFetch(routes: Array<{ match: (url: string, method?: string) => boolean; response: Record<string, unknown> }>): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const method = init?.method ?? 'GET';
    for (const route of routes) {
      if (route.match(urlStr, method)) {
        return Promise.resolve(mockFetchResponse(route.response));
      }
    }
    return Promise.resolve(mockFetchResponse({ code: -1, msg: 'Unexpected URL' }));
  }) as typeof fetch;
}

describe('insert_docx_image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getFeishuCredentials).mockReturnValue({ appId: 'test-app-id', appSecret: 'test-secret' });
    vi.mocked(getWorkspaceDir).mockReturnValue('/workspace');
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 102400 } as any);
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('fake-image-data'));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('parameter validation', () => {
    it('should return error when documentId is empty', async () => {
      const result = await insert_docx_image({ documentId: '', imagePath: '/test/image.png', index: 0 });
      expect(result.success).toBe(false);
      expect(result.error).toBe('missing_documentId');
    });

    it('should return error when imagePath is empty', async () => {
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '', index: 0 });
      expect(result.success).toBe(false);
      expect(result.error).toBe('missing_imagePath');
    });

    it('should return error when index is negative', async () => {
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/image.png', index: -1 });
      expect(result.success).toBe(false);
      expect(result.error).toBe('invalid_index');
    });

    it('should return error when index is not an integer', async () => {
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/image.png', index: 1.5 });
      expect(result.success).toBe(false);
      expect(result.error).toBe('invalid_index');
    });
  });

  describe('credential validation', () => {
    it('should return error when appId is missing', async () => {
      vi.mocked(getFeishuCredentials).mockReturnValue({ appId: undefined, appSecret: 'secret' });
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/image.png', index: 0 });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Platform is not configured');
    });

    it('should return error when appSecret is missing', async () => {
      vi.mocked(getFeishuCredentials).mockReturnValue({ appId: 'app-id', appSecret: undefined });
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/image.png', index: 0 });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Platform is not configured');
    });
  });

  describe('file validation', () => {
    it('should return error when path is not a file', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => false } as any);
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/dir', index: 0 });
      expect(result.success).toBe(false);
      expect(result.error).toBe('not_a_file');
    });

    it('should return error when file does not exist', async () => {
      vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT: no such file'));
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/missing.png', index: 0 });
      expect(result.success).toBe(false);
      expect(result.message).toContain('ENOENT');
    });

    it('should return error when file is too large', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 25 * 1024 * 1024 } as any);
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/big.png', index: 0 });
      expect(result.success).toBe(false);
      expect(result.error).toBe('file_too_large');
      expect(result.message).toContain('25.0 MB');
    });

    it('should return error for unsupported file type', async () => {
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/file.exe', index: 0 });
      expect(result.success).toBe(false);
      expect(result.error).toBe('unsupported_type');
    });
  });

  describe('path resolution', () => {
    it('should resolve relative paths using workspace dir', async () => {
      globalThis.fetch = createMockFetch([
        { match: (url) => url.includes('/auth/v3/tenant_access_token'), response: { code: 0, tenant_access_token: 'test-token' } },
        { match: (url, method) => url.includes('/blocks/') && method === 'POST', response: { code: 0, data: { children: [{ block_id: 'blk_123' }] } } },
        { match: (url) => url.includes('/medias/upload_all'), response: { code: 0, data: { file_token: 'ft_123' } } },
        { match: (url, method) => url.includes('/blocks/blk_123') && method === 'PATCH', response: { code: 0 } },
      ]);

      const result = await insert_docx_image({ documentId: 'doc123', imagePath: 'images/chart.png', index: 3 });

      expect(result.success).toBe(true);
      expect(getWorkspaceDir).toHaveBeenCalled();
    });
  });

  describe('API error handling', () => {
    it('should return error when tenant access token request fails', async () => {
      globalThis.fetch = createMockFetch([
        { match: (url) => url.includes('/auth/v3/tenant_access_token'), response: { code: 10014, msg: 'app_id or app_secret is wrong' } },
      ]);

      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/chart.png', index: 0 });
      expect(result.success).toBe(false);
      expect(result.message).toContain('tenant access token');
    });

    it('should return error when create block API fails', async () => {
      globalThis.fetch = createMockFetch([
        { match: (url) => url.includes('/auth/v3/tenant_access_token'), response: { code: 0, tenant_access_token: 'test-token' } },
        { match: (url) => url.includes('/blocks/'), response: { code: 232000, msg: 'document not found' } },
      ]);

      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/chart.png', index: 0 });
      expect(result.success).toBe(false);
      expect(result.message).toContain('create image block');
    });

    it('should return error when image upload fails', async () => {
      globalThis.fetch = createMockFetch([
        { match: (url) => url.includes('/auth/v3/tenant_access_token'), response: { code: 0, tenant_access_token: 'test-token' } },
        { match: (url, method) => url.includes('/blocks/') && method === 'POST', response: { code: 0, data: { children: [{ block_id: 'blk_123' }] } } },
        { match: (url) => url.includes('/medias/upload_all'), response: { code: 104000, msg: 'upload failed' } },
      ]);

      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/chart.png', index: 0 });
      expect(result.success).toBe(false);
      expect(result.message).toContain('upload image');
    });

    it('should return error when bind image fails', async () => {
      globalThis.fetch = createMockFetch([
        { match: (url) => url.includes('/auth/v3/tenant_access_token'), response: { code: 0, tenant_access_token: 'test-token' } },
        { match: (url, method) => url.includes('/blocks/') && method === 'POST', response: { code: 0, data: { children: [{ block_id: 'blk_123' }] } } },
        { match: (url) => url.includes('/medias/upload_all'), response: { code: 0, data: { file_token: 'ft_123' } } },
        { match: (_url, method) => method === 'PATCH', response: { code: 232018, msg: 'replace_image failed' } },
      ]);

      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/chart.png', index: 0 });
      expect(result.success).toBe(false);
      expect(result.message).toContain('bind image');
    });
  });

  describe('successful insertion', () => {
    it('should complete all three steps and return block info', async () => {
      const fetchCalls: Array<{ url: string; method: string }> = [];
      globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        const method = init?.method ?? 'GET';
        fetchCalls.push({ url: urlStr, method });

        if (urlStr.includes('/auth/v3/tenant_access_token')) {
          return Promise.resolve(mockFetchResponse({ code: 0, tenant_access_token: 'tok_abc' }));
        }
        if (urlStr.includes('/blocks/') && method === 'POST') {
          return Promise.resolve(mockFetchResponse({ code: 0, data: { children: [{ block_id: 'blk_new_image' }] } }));
        }
        if (urlStr.includes('/medias/upload_all')) {
          return Promise.resolve(mockFetchResponse({ code: 0, data: { file_token: 'ft_uploaded' } }));
        }
        if (method === 'PATCH') {
          return Promise.resolve(mockFetchResponse({ code: 0 }));
        }
        return Promise.resolve(mockFetchResponse({ code: -1 }));
      }) as typeof fetch;

      const result = await insert_docx_image({
        documentId: 'doxcnAbCdEf',
        imagePath: '/workspace/charts/report.png',
        index: 5,
      });

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('blk_new_image');
      expect(result.fileToken).toBe('ft_uploaded');
      expect(result.message).toContain('position 5');
      expect(result.message).toContain('report.png');

      // Verify all 4 API calls were made (auth + 3 steps)
      expect(fetchCalls).toHaveLength(4);
      expect(fetchCalls[0].url).toContain('/auth/v3/tenant_access_token');
      expect(fetchCalls[1].url).toContain('/docx/v1/documents/doxcnAbCdEf/blocks/doxcnAbCdEf/children');
      expect(fetchCalls[2].url).toContain('/drive/v1/medias/upload_all');
      expect(fetchCalls[3].url).toContain('/docx/v1/documents/doxcnAbCdEf/blocks/blk_new_image');
    });

    it('should insert at position 0 (beginning of document)', async () => {
      const createBlockBodies: Array<Record<string, unknown>> = [];
      globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        const method = init?.method ?? 'GET';

        if (urlStr.includes('/auth/v3/tenant_access_token')) {
          return Promise.resolve(mockFetchResponse({ code: 0, tenant_access_token: 'tok' }));
        }
        if (urlStr.includes('/blocks/') && method === 'POST') {
          const body = JSON.parse(init?.body as string);
          createBlockBodies.push(body);
          return Promise.resolve(mockFetchResponse({ code: 0, data: { children: [{ block_id: 'blk_0' }] } }));
        }
        if (urlStr.includes('/medias/upload_all')) {
          return Promise.resolve(mockFetchResponse({ code: 0, data: { file_token: 'ft_0' } }));
        }
        if (method === 'PATCH') {
          return Promise.resolve(mockFetchResponse({ code: 0 }));
        }
        return Promise.resolve(mockFetchResponse({ code: -1 }));
      }) as typeof fetch;

      const result = await insert_docx_image({
        documentId: 'doc123',
        imagePath: '/test/first.png',
        index: 0,
      });

      expect(result.success).toBe(true);
      expect(createBlockBodies[0].index).toBe(0);
      expect((createBlockBodies[0].children as Array<Record<string, unknown>>)[0].block_type).toBe(27);
    });
  });

  describe('network error handling', () => {
    it('should handle fetch throwing an error', async () => {
      globalThis.fetch = (() => Promise.reject(new Error('Network connection refused'))) as typeof fetch;

      const result = await insert_docx_image({
        documentId: 'doc123',
        imagePath: '/test/chart.png',
        index: 0,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Network connection refused');
    });

    it('should handle non-Error thrown objects', async () => {
      globalThis.fetch = (() => Promise.reject(new Error('something went wrong'))) as typeof fetch;

      const result = await insert_docx_image({
        documentId: 'doc123',
        imagePath: '/test/chart.png',
        index: 0,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('something went wrong');
    });
  });

  describe('supported image types', () => {
    async function testImageType(ext: string, expectedSuccess: boolean): Promise<void> {
      globalThis.fetch = createMockFetch([
        { match: (url) => url.includes('/auth'), response: { code: 0, tenant_access_token: 'tok' } },
        { match: (url) => url.includes('/blocks/'), response: { code: 0, data: { children: [{ block_id: 'blk' }] } } },
        { match: (url) => url.includes('/upload_all'), response: { code: 0, data: { file_token: 'ft' } } },
        { match: (_url) => true, response: { code: 0 } },
      ]);

      const result = await insert_docx_image({ documentId: 'doc123', imagePath: `/test/image.${ext}`, index: 0 });
      expect(result.success).toBe(expectedSuccess);
    }

    it('should support PNG images', () => testImageType('png', true));
    it('should support JPEG images', () => testImageType('jpg', true));
    it('should support JPEG images (.jpeg)', () => testImageType('jpeg', true));
    it('should support GIF images', () => testImageType('gif', true));
    it('should support WebP images', () => testImageType('webp', true));
    it('should support BMP images', () => testImageType('bmp', true));
    it('should support SVG images', () => testImageType('svg', true));
    it('should reject unsupported types', () => testImageType('tiff', false));
  });
});
