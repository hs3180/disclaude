/**
 * Tests for insert_docx_image tool (packages/mcp-server/src/tools/insert-docx-image.ts)
 *
 * Tests parameter validation, credential checks, file resolution,
 * and the 3-step API flow (create block → upload → replace).
 *
 * Mocks the low-level API functions (feishu-docx-api) to avoid network
 * interference with other test files.
 *
 * Issue #2278: Support inline image insertion in Feishu documents.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock core logger
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

// Mock the low-level API functions to avoid nock interference
vi.mock('./feishu-docx-api.js', () => ({
  getTenantAccessToken: vi.fn(),
  createImageBlock: vi.fn(),
  uploadDocxImage: vi.fn(),
  replaceImageBlock: vi.fn(),
  clearTokenCache: vi.fn(),
}));

import { insert_docx_image } from './insert-docx-image.js';
import { getFeishuCredentials, getWorkspaceDir } from './credentials.js';
import { getTenantAccessToken, createImageBlock, uploadDocxImage, replaceImageBlock } from './feishu-docx-api.js';

describe('insert_docx_image', () => {
  let tempDir: string;
  let tempImage: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    vi.mocked(getFeishuCredentials).mockReturnValue({
      appId: 'test-app-id',
      appSecret: 'test-app-secret',
    });

    // Default mock: successful 3-step flow
    vi.mocked(getTenantAccessToken).mockResolvedValue('mock-token');
    vi.mocked(createImageBlock).mockResolvedValue('mock-block-id');
    vi.mocked(uploadDocxImage).mockResolvedValue('mock-file-token');
    vi.mocked(replaceImageBlock).mockResolvedValue('mock-block-id');

    // Create a temp image file for testing
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'docx-test-'));
    tempImage = path.join(tempDir, 'test-image.png');
    await fs.promises.writeFile(tempImage, Buffer.from('fake-png-data'));
  });

  afterEach(async () => {
    // Clean up temp files
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('parameter validation', () => {
    it('should return error when documentId is empty', async () => {
      const result = await insert_docx_image({ documentId: '', imagePath: tempImage, index: 0 });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing documentId');
    });

    it('should return error when imagePath is empty', async () => {
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '', index: 0 });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing imagePath');
    });

    it('should return error when index is negative', async () => {
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: tempImage, index: -1 });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid index');
    });

    it('should return error when index is not an integer', async () => {
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: tempImage, index: 1.5 });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid index');
    });
  });

  describe('credential validation', () => {
    it('should return error when Feishu credentials are missing', async () => {
      vi.mocked(getFeishuCredentials).mockReturnValue({ appId: undefined, appSecret: undefined });
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: tempImage, index: 0 });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Feishu credentials not configured');
    });

    it('should return error when only appId is missing', async () => {
      vi.mocked(getFeishuCredentials).mockReturnValue({ appId: undefined, appSecret: 'secret' });
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: tempImage, index: 0 });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Feishu credentials not configured');
    });
  });

  describe('file validation', () => {
    it('should return error when image file does not exist', async () => {
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/nonexistent/image.png', index: 0 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should resolve relative paths using workspace dir', async () => {
      // Use a temp directory as workspace
      const wsDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ws-'));
      const resolvedPath = path.join(wsDir, 'images', 'chart.png');
      await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.promises.writeFile(resolvedPath, Buffer.from('fake-image'));

      vi.mocked(getWorkspaceDir).mockReturnValue(wsDir);
      vi.mocked(createImageBlock).mockResolvedValue('block_456');

      try {
        const result = await insert_docx_image({ documentId: 'doc123', imagePath: 'images/chart.png', index: 2 });
        expect(result.success).toBe(true);
        expect(result.blockId).toBe('block_456');
        expect(result.index).toBe(2);
        // Verify the resolved path was used for upload
        expect(uploadDocxImage).toHaveBeenCalledWith('mock-token', resolvedPath);
      } finally {
        await fs.promises.rm(wsDir, { recursive: true, force: true });
      }
    });
  });

  describe('successful 3-step flow', () => {
    it('should insert image successfully with valid parameters', async () => {
      vi.mocked(createImageBlock).mockResolvedValue('block_abc');

      const result = await insert_docx_image({
        documentId: 'doc123',
        imagePath: tempImage,
        index: 5,
      });

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('block_abc');
      expect(result.index).toBe(5);
      expect(result.message).toContain('position 5');
      expect(result.message).toContain('doc123');

      // Verify the 3-step flow was called correctly
      expect(getTenantAccessToken).toHaveBeenCalledWith('test-app-id', 'test-app-secret');
      expect(createImageBlock).toHaveBeenCalledWith('mock-token', 'doc123', 5);
      expect(uploadDocxImage).toHaveBeenCalledWith('mock-token', tempImage);
      expect(replaceImageBlock).toHaveBeenCalledWith('mock-token', 'doc123', 'block_abc', 'mock-file-token');
    });

    it('should insert image at index 0', async () => {
      vi.mocked(createImageBlock).mockResolvedValue('block_001');

      const result = await insert_docx_image({
        documentId: 'doc456',
        imagePath: tempImage,
        index: 0,
      });

      expect(result.success).toBe(true);
      expect(result.index).toBe(0);
      expect(createImageBlock).toHaveBeenCalledWith('mock-token', 'doc456', 0);
    });
  });

  describe('API error handling', () => {
    it('should return error when auth fails', async () => {
      vi.mocked(getTenantAccessToken).mockRejectedValue(new Error('Feishu auth error 10014: invalid credentials'));

      const result = await insert_docx_image({
        documentId: 'doc123',
        imagePath: tempImage,
        index: 0,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('auth error');
    });

    it('should return error when create block fails', async () => {
      vi.mocked(createImageBlock).mockRejectedValue(new Error('Feishu API error 10010: document not found'));

      const result = await insert_docx_image({
        documentId: 'doc123',
        imagePath: tempImage,
        index: 0,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to insert image');
      expect(result.message).toContain('document not found');
    });

    it('should return error when upload fails', async () => {
      vi.mocked(uploadDocxImage).mockRejectedValue(new Error('Feishu upload error 10012: upload failed'));

      const result = await insert_docx_image({
        documentId: 'doc123',
        imagePath: tempImage,
        index: 0,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to insert image');
      expect(result.message).toContain('upload error');
    });

    it('should return error when replace_image fails', async () => {
      vi.mocked(replaceImageBlock).mockRejectedValue(new Error('Feishu replace_image error 10013: replace failed'));

      const result = await insert_docx_image({
        documentId: 'doc123',
        imagePath: tempImage,
        index: 0,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to insert image');
      expect(result.message).toContain('replace_image error');
    });

    it('should handle unexpected errors gracefully', async () => {
      vi.mocked(createImageBlock).mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await insert_docx_image({
        documentId: 'doc123',
        imagePath: tempImage,
        index: 0,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to insert image');
    });
  });
});
