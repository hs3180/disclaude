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
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 1024 * 512 } as any);
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
  });

  describe('image format validation', () => {
    it('should reject non-image file extensions', async () => {
      const result = await upload_image({ filePath: '/test/document.pdf' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported image format');
    });

    it('should accept jpg files', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_key_123', fileName: 'photo.jpg', fileSize: 2048,
      });
      const result = await upload_image({ filePath: '/test/photo.jpg' });
      expect(result.success).toBe(true);
    });

    it('should accept png files', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_key_456', fileName: 'chart.png', fileSize: 4096,
      });
      const result = await upload_image({ filePath: '/test/chart.png' });
      expect(result.success).toBe(true);
    });

    it('should accept uppercase extensions', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_key_789', fileName: 'image.PNG', fileSize: 1024,
      });
      const result = await upload_image({ filePath: '/test/image.PNG' });
      expect(result.success).toBe(true);
    });
  });

  describe('file size validation', () => {
    it('should reject files over 10MB', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 11 * 1024 * 1024 } as any);
      const result = await upload_image({ filePath: '/test/huge.png' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('too large');
    });

    it('should accept files under 10MB', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 9 * 1024 * 1024 } as any);
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_key_ok', fileName: 'big.png', fileSize: 9 * 1024 * 1024,
      });
      const result = await upload_image({ filePath: '/test/big.png' });
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
        success: true, imageKey: 'img_v2_xxxxx', fileName: 'chart.png', fileSize: 512000,
      });
      const result = await upload_image({ filePath: '/test/chart.png' });
      expect(result.success).toBe(true);
      expect(result.imageKey).toBe('img_v2_xxxxx');
      expect(result.fileName).toBe('chart.png');
      expect(result.fileSize).toBe(512000);
      expect(result.message).toContain('img_v2_xxxxx');
      expect(result.message).toContain('chart.png');
    });

    it('should include usage instructions in success message', async () => {
      mockIpcClient.uploadImage.mockResolvedValue({
        success: true, imageKey: 'img_key_test', fileName: 'diagram.png', fileSize: 2048,
      });
      const result = await upload_image({ filePath: '/test/diagram.png' });
      expect(result.message).toContain('img_key_test');
      expect(result.message).toContain('img');
      expect(result.message).toContain('send_card');
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
        error: 'IPC_REQUEST_FAILED: Image upload rejected',
        errorType: 'ipc_request_failed' as const,
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
