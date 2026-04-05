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
import { getWorkspaceDir } from './credentials.js';
import { isIpcAvailable } from './ipc-utils.js';

const mockIpcClient = {
  uploadImage: vi.fn(),
};

describe('upload_image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);
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

  describe('file path resolution', () => {
    it('should resolve relative paths using workspace dir', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_v3_test', fileName: 'chart.png', fileSize: 1024,
      });
      await upload_image({ filePath: 'chart.png' });
      expect(mockIpcClient.uploadImage).toHaveBeenCalledWith('/workspace/chart.png');
    });

    it('should use absolute paths directly', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_v3_test', fileName: 'image.png', fileSize: 1024,
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
  });

  describe('image format validation', () => {
    it('should accept supported image formats', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_v3_jpg', fileName: 'photo.jpg', fileSize: 500,
      });
      const result = await upload_image({ filePath: '/test/photo.jpg' });
      expect(result.success).toBe(true);
    });

    it('should accept png format', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_v3_png', fileName: 'chart.png', fileSize: 500,
      });
      const result = await upload_image({ filePath: '/test/chart.png' });
      expect(result.success).toBe(true);
    });

    it('should accept webp format', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_v3_webp', fileName: 'image.webp', fileSize: 500,
      });
      const result = await upload_image({ filePath: '/test/image.webp' });
      expect(result.success).toBe(true);
    });

    it('should reject unsupported format (pdf)', async () => {
      const result = await upload_image({ filePath: '/test/document.pdf' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unsupported image format');
      expect(result.message).toContain('.pdf');
    });

    it('should reject unsupported format (txt)', async () => {
      const result = await upload_image({ filePath: '/test/note.txt' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unsupported image format');
    });
  });

  describe('file size validation', () => {
    it('should reject files larger than 10MB', async () => {
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => true,
        size: 11 * 1024 * 1024, // 11MB
      } as any);
      const result = await upload_image({ filePath: '/test/large.png' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('too large');
      expect(result.message).toContain('10MB');
    });

    it('should accept files at exactly 10MB', async () => {
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => true,
        size: 10 * 1024 * 1024, // exactly 10MB
      } as any);
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_v3_max', fileName: 'max.png', fileSize: 10 * 1024 * 1024,
      });
      const result = await upload_image({ filePath: '/test/max.png' });
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
    it('should return image_key on successful upload', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true,
        imageKey: 'img_v3_abc123',
        fileName: 'chart.png',
        fileSize: 2048000,
      });
      const result = await upload_image({ filePath: '/test/chart.png' });
      expect(result.success).toBe(true);
      expect(result.imageKey).toBe('img_v3_abc123');
      expect(result.fileName).toBe('chart.png');
      expect(result.fileSize).toBe(2048000);
      expect(result.sizeMB).toBe('1.95');
    });

    it('should include usage instructions in message', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true,
        imageKey: 'img_v3_xyz789',
        fileName: 'report.png',
        fileSize: 512000,
      });
      const result = await upload_image({ filePath: '/test/report.png' });
      expect(result.message).toContain('img_v3_xyz789');
      expect(result.message).toContain('img_key');
      expect(result.message).toContain('send_card');
    });

    it('should calculate correct sizeMB', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true,
        imageKey: 'img_v3_size',
        fileName: 'small.png',
        fileSize: 512000,
      });
      const result = await upload_image({ filePath: '/test/small.png' });
      expect(result.sizeMB).toBe('0.49');
    });
  });

  describe('IPC failure', () => {
    it('should return error when IPC upload fails without imageKey', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: false,
        error: 'Upload failed',
      });
      const result = await upload_image({ filePath: '/test/image.png' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Upload failed');
    });

    it('should return error when IPC upload returns success=false with no imageKey', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: false,
      });
      const result = await upload_image({ filePath: '/test/image.png' });
      expect(result.success).toBe(false);
    });
  });

  describe('platform error handling', () => {
    it('should extract platform error details from response', async () => {
      const platformError = new Error('API Error') as Error & {
        response: { data: [{ code: 99991668, msg: 'image format not allowed' }] };
      };
      platformError.response = { data: [{ code: 99991668, msg: 'image format not allowed' }] };
      mockIpcClient.uploadImage.mockRejectedValue(platformError);
      const result = await upload_image({ filePath: '/test/image.png' });
      expect(result.success).toBe(false);
      expect(result.platformCode).toBe(99991668);
      expect(result.platformMsg).toBe('image format not allowed');
    });

    it('should handle non-Error objects in catch', async () => {
      mockIpcClient.uploadImage.mockRejectedValue('string error');
      const result = await upload_image({ filePath: '/test/image.png' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });
  });
});
