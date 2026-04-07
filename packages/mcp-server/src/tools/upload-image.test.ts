/**
 * Tests for upload_image tool (packages/mcp-server/src/tools/upload-image.ts)
 *
 * Issue #1919: Upload image to Feishu and return image_key for card embedding.
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

    it('should return error when filePath is undefined', async () => {
      const result = await upload_image({ filePath: undefined as any });
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

    it('should return error when appSecret is missing', async () => {
      vi.mocked(getFeishuCredentials).mockReturnValue({ appId: 'app-id', appSecret: undefined });
      const result = await upload_image({ filePath: '/test/image.png' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Platform is not configured');
    });
  });

  describe('file path resolution', () => {
    it('should resolve relative paths using workspace dir', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_key_123', fileName: 'chart.png', fileSize: 1024,
      });
      await upload_image({ filePath: 'chart.png' });
      expect(mockIpcClient.uploadImage).toHaveBeenCalledWith('/workspace/chart.png');
    });

    it('should use absolute paths directly', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_key_456', fileName: 'photo.jpg', fileSize: 2048,
      });
      await upload_image({ filePath: '/absolute/path/photo.jpg' });
      expect(mockIpcClient.uploadImage).toHaveBeenCalledWith('/absolute/path/photo.jpg');
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

    it('should reject unsupported image formats', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 1024 } as any);
      const result = await upload_image({ filePath: '/test/document.pdf' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported image format');
      expect(result.error).toContain('.pdf');
    });

    it('should reject files larger than 10MB', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 11 * 1024 * 1024 } as any);
      const result = await upload_image({ filePath: '/test/large.png' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('too large');
    });

    it('should accept supported image formats', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_key_789', fileName: 'image.webp', fileSize: 1024,
      });
      const result = await upload_image({ filePath: '/test/image.webp' });
      expect(result.success).toBe(true);
    });
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
    it('should upload image and return image_key', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_v3_abc123', fileName: 'chart.png', fileSize: 512000,
      });
      const result = await upload_image({ filePath: '/test/chart.png' });
      expect(result.success).toBe(true);
      expect(result.imageKey).toBe('img_v3_abc123');
      expect(result.fileName).toBe('chart.png');
      expect(result.fileSize).toBe(512000);
      expect(result.sizeMB).toBe('0.49');
      expect(result.message).toContain('chart.png');
      expect(result.message).toContain('img_v3_abc123');
    });

    it('should include usage hint in message', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_key_usage', fileName: 'plot.jpg', fileSize: 2048000,
      });
      const result = await upload_image({ filePath: '/test/plot.jpg' });
      expect(result.message).toContain('img_key');
      expect(result.message).toContain('tag');
    });
  });

  describe('IPC failure', () => {
    it('should return error when IPC upload fails (no imageKey)', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({ success: false });
      const result = await upload_image({ filePath: '/test/image.png' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to upload image via IPC');
    });

    it('should return error when IPC upload returns no imageKey', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: undefined, fileName: 'image.png', fileSize: 1024,
      });
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
      expect(result.message).toContain('99991668');
      expect(result.message).toContain('image type not allowed');
    });

    it('should handle non-Error objects in catch', async () => {
      mockIpcClient.uploadImage.mockRejectedValue('string error');
      const result = await upload_image({ filePath: '/test/image.png' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });
  });
});
