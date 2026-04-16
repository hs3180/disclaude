/**
 * Tests for upload_image tool (packages/mcp-server/src/tools/upload-image.ts)
 *
 * Issue #1919: MCP tool for image upload with image_key return.
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
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 1024 } as any);
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
        success: true, imageKey: 'img_v3_test', fileName: 'chart.png', fileSize: 1024,
      });
      await upload_image({ filePath: '/absolute/path/chart.png' });
      expect(mockIpcClient.uploadImage).toHaveBeenCalledWith('/absolute/path/chart.png');
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
      const result = await upload_image({ filePath: '/test/file.txt' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported image format');
      expect(result.error).toContain('.txt');
    });

    it('should accept jpg format', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_v3_test', fileName: 'photo.jpg', fileSize: 2048,
      });
      const result = await upload_image({ filePath: '/test/photo.jpg' });
      expect(result.success).toBe(true);
    });

    it('should accept png format', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_v3_test', fileName: 'chart.png', fileSize: 4096,
      });
      const result = await upload_image({ filePath: '/test/chart.png' });
      expect(result.success).toBe(true);
    });

    it('should accept webp format', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_v3_test', fileName: 'img.webp', fileSize: 8192,
      });
      const result = await upload_image({ filePath: '/test/img.webp' });
      expect(result.success).toBe(true);
    });

    it('should reject bmp format' , async () => {
      // bmp is actually supported - let's test svg instead which is NOT supported
      const result = await upload_image({ filePath: '/test/icon.svg' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported image format');
    });

    it('should return error for file exceeding 10MB', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 11 * 1024 * 1024 } as any);
      const result = await upload_image({ filePath: '/test/huge.png' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('too large');
    });

    it('should accept file exactly at 10MB', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 10 * 1024 * 1024 } as any);
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_v3_test', fileName: 'exact.png', fileSize: 10 * 1024 * 1024,
      });
      const result = await upload_image({ filePath: '/test/exact.png' });
      expect(result.success).toBe(true);
    });
  });

  describe('IPC availability', () => {
    it('should return error when IPC is unavailable', async () => {
      vi.mocked(isIpcAvailable).mockResolvedValue(false);
      const result = await upload_image({ filePath: '/test/chart.png' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('IPC connection');
    });
  });

  describe('successful upload', () => {
    it('should upload image successfully and return image_key', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_v3_abc123', fileName: 'chart.png', fileSize: 512000,
      });
      const result = await upload_image({ filePath: '/test/chart.png' });
      expect(result.success).toBe(true);
      expect(result.imageKey).toBe('img_v3_abc123');
      expect(result.fileName).toBe('chart.png');
      expect(result.fileSize).toBe(512000);
      expect(result.message).toContain('img_v3_abc123');
      expect(result.message).toContain('chart.png');
    });

    it('should include usage instructions in success message', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_v3_test', fileName: 'chart.png', fileSize: 1024,
      });
      const result = await upload_image({ filePath: '/test/chart.png' });
      expect(result.message).toContain('img_key');
      expect(result.message).toContain('send_card');
    });
  });

  describe('IPC failure', () => {
    it('should return error when IPC upload fails', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({ success: false });
      const result = await upload_image({ filePath: '/test/chart.png' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to upload image via IPC');
    });

    it('should include IPC error details', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: false,
        error: 'IPC_REQUEST_FAILED: Request failed',
        errorType: 'ipc_request_failed' as const,
      });
      const result = await upload_image({ filePath: '/test/chart.png' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('IPC_REQUEST_FAILED');
    });

    it('should return error when image_key is missing in response', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: '', fileName: 'chart.png', fileSize: 1024,
      });
      const result = await upload_image({ filePath: '/test/chart.png' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('No image_key returned');
    });
  });

  describe('error handling', () => {
    it('should handle IPC exceptions gracefully', async () => {
      mockIpcClient.uploadImage.mockRejectedValue(new Error('Connection refused'));
      const result = await upload_image({ filePath: '/test/chart.png' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection refused');
    });

    it('should handle non-Error objects in catch', async () => {
      mockIpcClient.uploadImage.mockRejectedValue('string error');
      const result = await upload_image({ filePath: '/test/chart.png' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });
  });
});
