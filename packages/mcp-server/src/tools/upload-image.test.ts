/**
 * Tests for upload_image tool (packages/mcp-server/src/tools/upload-image.ts)
 *
 * Issue #1919: Image upload for card embedding.
 */

import * as fs from 'fs/promises';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getIpcClient: vi.fn(),
}));

vi.mock('./credentials.js', () => ({
  getFeishuCredentials: vi.fn(),
  getWorkspaceDir: vi.fn(() => '/workspace'),
}));

vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  stat: vi.fn(),
}));

import { upload_image } from './upload-image.js';
import { getIpcClient } from '@disclaude/core';
import { getFeishuCredentials, getWorkspaceDir } from './credentials.js';
import { isIpcAvailable } from './ipc-utils.js';

const mockIpcClient = {
  uploadImage: vi.fn(),
};

describe('upload_image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);
    vi.mocked(getFeishuCredentials).mockReturnValue({ appId: 'test-app-id', appSecret: 'test-secret' });
    vi.mocked(getWorkspaceDir).mockReturnValue('/workspace');
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 1024 * 1024 } as any);
  });

  describe('parameter validation', () => {
    it('should return error when filePath is empty', async () => {
      const result = await upload_image({ filePath: '' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('filePath is required');
    });
  });

  describe('credential validation', () => {
    it('should return error when appId is missing', async () => {
      vi.mocked(getFeishuCredentials).mockReturnValue({ appId: undefined, appSecret: 'secret' });
      const result = await upload_image({ filePath: '/test/image.png' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Platform is not configured');
    });
  });

  describe('file path resolution', () => {
    it('should resolve relative paths using workspace dir', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_key_123', fileName: 'image.png', fileSize: 1024,
      });
      await upload_image({ filePath: 'image.png' });
      expect(mockIpcClient.uploadImage).toHaveBeenCalledWith('/workspace/image.png');
    });

    it('should use absolute paths directly', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_key_123', fileName: 'image.png', fileSize: 1024,
      });
      await upload_image({ filePath: '/absolute/path/image.png' });
      expect(mockIpcClient.uploadImage).toHaveBeenCalledWith('/absolute/path/image.png');
    });
  });

  describe('file validation', () => {
    it('should return error when path is not a file', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => false } as any);
      const result = await upload_image({ filePath: '/test/dir' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not a file');
    });

    it('should return error when file does not exist', async () => {
      vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT: no such file'));
      const result = await upload_image({ filePath: '/test/nonexistent.png' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('ENOENT');
    });

    it('should return error for unsupported image format', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 1024 } as any);
      const result = await upload_image({ filePath: '/test/document.pdf' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported image format');
      expect(result.error).toContain('.pdf');
    });

    it('should return error for image file too large (>10MB)', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 11 * 1024 * 1024 } as any);
      const result = await upload_image({ filePath: '/test/large.png' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('too large');
    });
  });

  describe('supported image formats', () => {
    const supportedFormats = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico'];

    for (const ext of supportedFormats) {
      it(`should accept ${ext} format`, async () => {
        mockIpcClient.uploadImage.mockResolvedValue({
          success: true, imageKey: 'img_key_123', fileName: `image${ext}`, fileSize: 1024,
        });
        const result = await upload_image({ filePath: `/test/image${ext}` });
        expect(result.success).toBe(true);
      });
    }
  });

  describe('IPC availability', () => {
    it('should return error when IPC is unavailable', async () => {
      vi.mocked(isIpcAvailable).mockResolvedValue(false);
      const result = await upload_image({ filePath: '/test/image.png' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('IPC connection');
    });
  });

  describe('successful upload', () => {
    it('should upload image successfully and return image_key', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_v3_abc123', fileName: 'chart.png', fileSize: 2048000,
      });
      const result = await upload_image({ filePath: '/test/chart.png' });
      expect(result.success).toBe(true);
      expect(result.imageKey).toBe('img_v3_abc123');
      expect(result.fileName).toBe('chart.png');
      expect(result.fileSize).toBe(2048000);
      expect(result.sizeMB).toBe('1.95');
      expect(result.message).toContain('img_v3_abc123');
    });

    it('should calculate correct sizeMB', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'key', fileName: 'image.png', fileSize: 512000,
      });
      const result = await upload_image({ filePath: '/test/image.png' });
      expect(result.sizeMB).toBe('0.49');
    });
  });

  describe('IPC failure', () => {
    it('should return error when IPC upload fails', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({ success: false });
      const result = await upload_image({ filePath: '/test/image.png' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to upload image via IPC');
    });
  });

  describe('platform error handling', () => {
    it('should extract platform error details from response', async () => {
      const platformError = new Error('API Error') as Error & {
        response: { data: [{ code: 99991668, msg: 'image type not allowed' }] };
      };
      platformError.response = { data: [{ code: 99991668, msg: 'image type not allowed' }] };
      mockIpcClient.uploadImage.mockRejectedValue(platformError);
      const result = await upload_image({ filePath: '/test/image.png' });
      expect(result.success).toBe(false);
      expect(result.platformCode).toBe(99991668);
      expect(result.platformMsg).toBe('image type not allowed');
    });

    it('should handle non-Error objects in catch', async () => {
      mockIpcClient.uploadImage.mockRejectedValue('string error');
      const result = await upload_image({ filePath: '/test/image.png' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });
  });
});
