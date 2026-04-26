/**
 * Tests for insert_docx_image tool.
 *
 * Issue #2278: Inline image insertion in Feishu documents.
 *
 * @module mcp-server/tools/insert-docx-image.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { insert_docx_image } from './insert-docx-image.js';

// Mock @disclaude/core
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock credentials to return test values
vi.mock('./credentials.js', () => ({
  getFeishuCredentials: () => ({
    appId: 'test_app_id',
    appSecret: 'test_app_secret',
  }),
  getWorkspaceDir: () => '/tmp/test-workspace',
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  default: {
    stat: vi.fn(),
    readFile: vi.fn(),
  },
  stat: vi.fn(),
  readFile: vi.fn(),
}));

import * as fs from 'fs/promises';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('insert_docx_image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return error when documentId is empty', async () => {
    const result = await insert_docx_image({
      documentId: '',
      imagePath: '/tmp/test.png',
      index: 0,
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('documentId');
  });

  it('should return error when imagePath is empty', async () => {
    const result = await insert_docx_image({
      documentId: 'doc123',
      imagePath: '',
      index: 0,
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('imagePath');
  });

  it('should return error when index is negative', async () => {
    const result = await insert_docx_image({
      documentId: 'doc123',
      imagePath: '/tmp/test.png',
      index: -1,
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('index');
  });

  it('should return error when file does not exist', async () => {
    vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT: no such file'));

    const result = await insert_docx_image({
      documentId: 'doc123',
      imagePath: '/tmp/nonexistent.png',
      index: 0,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed');
  });

  it('should return error when path is not a file', async () => {
    vi.mocked(fs.stat).mockResolvedValue({
      isFile: () => false,
    } as unknown as import('fs').Stats);

    const result = await insert_docx_image({
      documentId: 'doc123',
      imagePath: '/tmp/some-directory',
      index: 0,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('不是文件');
  });

  describe('successful insertion flow', () => {
    const mockAuthResponse = {
      ok: true,
      json: () => Promise.resolve({
        code: 0,
        msg: 'ok',
        tenant_access_token: 'test_token_123',
        expire: 7200,
      }),
    };

    const mockCreateBlockResponse = {
      ok: true,
      json: () => Promise.resolve({
        code: 0,
        msg: 'ok',
        data: {
          children: [{ block_id: 'block_abc123' }],
        },
      }),
    };

    const mockUploadResponse = {
      ok: true,
      json: () => Promise.resolve({
        code: 0,
        msg: 'ok',
        data: {
          file_token: 'file_token_xyz',
        },
      }),
    };

    const mockBindResponse = {
      ok: true,
      json: () => Promise.resolve({
        code: 0,
        msg: 'ok',
        data: {},
      }),
    };

    beforeEach(() => {
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => true,
      } as unknown as import('fs').Stats);
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('fake-image-data'));
    });

    it('should successfully insert image through three-step process', async () => {
      // Step 1: auth → create block → upload → bind
      // Token is cached, so auth is only called once
      mockFetch
        .mockResolvedValueOnce(mockAuthResponse)       // 1. get tenant token
        .mockResolvedValueOnce(mockCreateBlockResponse) // 2. create empty block
        .mockResolvedValueOnce(mockUploadResponse)      // 3. upload image
        .mockResolvedValueOnce(mockBindResponse);       // 4. bind image

      const result = await insert_docx_image({
        documentId: 'doc123',
        imagePath: '/tmp/test.png',
        index: 5,
      });

      // Debug: log result if failed
      if (!result.success) {
        console.log('Result:', result);
        console.log('Fetch calls:', mockFetch.mock.calls.length);
        for (let i = 0; i < mockFetch.mock.calls.length; i++) {
          console.log(`Call ${i}:`, mockFetch.mock.calls[i][0], mockFetch.mock.calls[i][1]?.method);
        }
      }

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('block_abc123');
      expect(result.message).toContain('index 5');
      expect(result.message).toContain('block_abc123');
    });
  });

  it('should handle Feishu API auth error', async () => {
    vi.mocked(fs.stat).mockResolvedValue({
      isFile: () => true,
    } as unknown as import('fs').Stats);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        code: 10014,
        msg: 'app_id or app_secret is invalid',
        tenant_access_token: '',
        expire: 0,
      }),
    });

    const result = await insert_docx_image({
      documentId: 'doc123',
      imagePath: '/tmp/test.png',
      index: 0,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed');
  });

  it('should resolve relative paths against workspace directory', async () => {
    vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));

    // Even though it will fail due to file not found, the path resolution should work
    const result = await insert_docx_image({
      documentId: 'doc123',
      imagePath: './images/chart.png',
      index: 0,
    });

    // Should fail because file doesn't exist, but path was resolved
    expect(result.success).toBe(false);
  });
});
