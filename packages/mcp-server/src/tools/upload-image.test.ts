/**
 * Tests for upload_image tool (packages/mcp-server/src/tools/upload-image.ts)
 *
 * Issue #1919: Upload image and return image_key for card embedding.
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
import { getFeishuCredentials } from './credentials.js';
import { isIpcAvailable } from './ipc-utils.js';

const mockIpcClient = {
  uploadImage: vi.fn(),
};

describe('upload_image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);
    vi.mocked(getFeishuCredentials).mockReturnValue({ appId: 'test-app-id', appSecret: 'test-secret' });
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 500 * 1024 } as any);
  });

  describe('parameter validation', () => {
    it('should return error when chatId is empty', async () => {
      const result = await upload_image({ filePath: '/test/image.png', chatId: '' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('chatId is required');
    });

    it('should return error when platform credentials are not configured', async () => {
      vi.mocked(getFeishuCredentials).mockReturnValue({ appId: '', appSecret: '' });
      const result = await upload_image({ filePath: '/test/image.png', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Platform credentials not configured');
    });

    it('should return error for non-image file extension', async () => {
      const result = await upload_image({ filePath: '/test/document.pdf', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unsupported image format');
    });

    it('should return error when path is not a file', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => false, size: 0 } as any);
      const result = await upload_image({ filePath: '/test/dir', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not a file');
    });

    it('should return error when IPC is not available', async () => {
      vi.mocked(isIpcAvailable).mockResolvedValue(false);
      const result = await upload_image({ filePath: '/test/image.png', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('IPC not available');
    });
  });

  describe('successful upload', () => {
    it('should return image_key on successful upload', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true,
        imageKey: 'img_v3_xxxx',
        fileName: 'chart.png',
        fileSize: 500 * 1024,
      });

      const result = await upload_image({ filePath: '/test/chart.png', chatId: 'oc_test' });

      expect(result.success).toBe(true);
      expect(result.imageKey).toBe('img_v3_xxxx');
      expect(result.fileName).toBe('chart.png');
      expect(result.message).toContain('img_v3_xxxx');
      expect(result.message).toContain('chart.png');
    });

    it('should resolve relative paths against workspace dir', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true,
        imageKey: 'img_v3_yyyy',
        fileName: 'photo.jpg',
        fileSize: 200 * 1024,
      });

      const result = await upload_image({ filePath: 'images/photo.jpg', chatId: 'oc_test' });

      expect(result.success).toBe(true);
      expect(mockIpcClient.uploadImage).toHaveBeenCalledWith('oc_test', '/workspace/images/photo.jpg');
    });

    it('should support all image extensions', async () => {
      const extensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico'];
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true,
        imageKey: 'img_v3_test',
        fileName: 'test.png',
        fileSize: 100,
      });

      for (const ext of extensions) {
        vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 100 } as any);
        const result = await upload_image({ filePath: `/test/image${ext}`, chatId: 'oc_test' });
        expect(result.success, `Extension ${ext} should be supported`).toBe(true);
      }
    });
  });

  describe('error handling', () => {
    it('should handle IPC upload failure', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: false,
        error: 'Channel uploadImage not supported',
      });

      const result = await upload_image({ filePath: '/test/image.png', chatId: 'oc_test' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to upload image via IPC');
    });

    it('should handle missing image_key in response', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true,
        imageKey: undefined,
      });

      const result = await upload_image({ filePath: '/test/image.png', chatId: 'oc_test' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('no image_key was returned');
    });

    it('should handle IPC exception', async () => {
      mockIpcClient.uploadImage.mockRejectedValue(new Error('Connection refused'));

      const result = await upload_image({ filePath: '/test/image.png', chatId: 'oc_test' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection refused');
    });
  });
});
