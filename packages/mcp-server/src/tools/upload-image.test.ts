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
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 1024 * 100 } as any); // 100KB image
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
        success: true, imageKey: 'img_v3_test', fileName: 'chart.png', fileSize: 102400,
      });
      await upload_image({ filePath: 'chart.png' });
      expect(mockIpcClient.uploadImage).toHaveBeenCalledWith('/workspace/chart.png');
    });

    it('should use absolute paths directly', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_v3_test', fileName: 'image.jpg', fileSize: 51200,
      });
      await upload_image({ filePath: '/absolute/path/image.jpg' });
      expect(mockIpcClient.uploadImage).toHaveBeenCalledWith('/absolute/path/image.jpg');
    });
  });

  describe('file validation', () => {
    it('should return error when path is not a file', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => false } as any);
      const result = await upload_image({ filePath: '/test/directory' });
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
        success: true, imageKey: 'img_v3_test', fileName: 'photo.jpg', fileSize: 2048,
      });
      const formats = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tiff', 'bmp', 'ico'];
      for (const fmt of formats) {
        const result = await upload_image({ filePath: `/test/image.${fmt}` });
        expect(result.success).toBe(true);
      }
    });

    it('should reject unsupported image formats', async () => {
      const result = await upload_image({ filePath: '/test/document.pdf' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unsupported image format');
      expect(result.message).toContain('.pdf');
    });

    it('should reject non-image extensions', async () => {
      const result = await upload_image({ filePath: '/test/data.csv' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unsupported image format');
    });
  });

  describe('file size validation', () => {
    it('should reject images larger than 10MB', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 11 * 1024 * 1024 } as any);
      const result = await upload_image({ filePath: '/test/large.png' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('too large');
    });

    it('should accept images exactly 10MB', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_v3_test', fileName: 'exact.png', fileSize: 10 * 1024 * 1024,
      });
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 10 * 1024 * 1024 } as any);
      const result = await upload_image({ filePath: '/test/exact.png' });
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
        success: true, imageKey: 'img_v3_abc123', fileName: 'chart.png', fileSize: 102400,
      });
      const result = await upload_image({ filePath: '/workspace/chart.png' });
      expect(result.success).toBe(true);
      expect(result.imageKey).toBe('img_v3_abc123');
      expect(result.fileName).toBe('chart.png');
      expect(result.fileSize).toBe(102400);
      expect(result.message).toContain('img_v3_abc123');
      expect(result.message).toContain('chart.png');
    });

    it('should return correct message format', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_v3_xyz', fileName: 'diagram.png', fileSize: 51200,
      });
      const result = await upload_image({ filePath: '/test/diagram.png' });
      expect(result.success).toBe(true);
      expect(result.message).toContain('✅');
      expect(result.message).toContain('image_key: img_v3_xyz');
    });
  });

  describe('IPC failure', () => {
    it('should return error when IPC upload fails', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({ success: false });
      const result = await upload_image({ filePath: '/test/image.png' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to upload image via IPC');
    });

    it('should include IPC error details', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: false,
        error: 'IPC_REQUEST_FAILED: Upload failed',
      });
      const result = await upload_image({ filePath: '/test/image.png' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('IPC_REQUEST_FAILED');
    });
  });

  describe('error handling', () => {
    it('should handle non-Error objects in catch', async () => {
      mockIpcClient.uploadImage.mockRejectedValue('string error');
      const result = await upload_image({ filePath: '/test/image.png' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });
  });
});
