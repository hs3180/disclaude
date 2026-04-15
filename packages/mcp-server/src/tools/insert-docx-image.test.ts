/**
 * Tests for insert_docx_image tool (packages/mcp-server/src/tools/insert-docx-image.ts)
 *
 * Issue #2278: Inline image insertion for Feishu documents.
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

import { insert_docx_image } from './insert-docx-image.js';
import { getIpcClient } from '@disclaude/core';
import { getFeishuCredentials, getWorkspaceDir } from './credentials.js';
import { isIpcAvailable } from './ipc-utils.js';

const mockIpcClient = {
  insertDocxImage: vi.fn(),
};

describe('insert_docx_image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);
    vi.mocked(getFeishuCredentials).mockReturnValue({ appId: 'test-app-id', appSecret: 'test-secret' });
    vi.mocked(getWorkspaceDir).mockReturnValue('/workspace');
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 1024 * 100 } as any);
  });

  describe('parameter validation', () => {
    it('should return error when documentId is empty', async () => {
      const result = await insert_docx_image({ documentId: '', imagePath: '/test/image.png', index: 0 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('documentId is required');
    });

    it('should return error when imagePath is empty', async () => {
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '', index: 0 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('imagePath is required');
    });

    it('should return error when index is negative', async () => {
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/image.png', index: -1 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('non-negative integer');
    });

    it('should return error when index is not an integer', async () => {
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/image.png', index: 1.5 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('non-negative integer');
    });
  });

  describe('credential validation', () => {
    it('should return error when credentials are not configured', async () => {
      vi.mocked(getFeishuCredentials).mockReturnValue({ appId: undefined, appSecret: undefined });
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/image.png', index: 0 });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Platform is not configured');
    });
  });

  describe('image format validation', () => {
    it('should return error for unsupported image format', async () => {
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/file.tiff', index: 0 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported image format');
      expect(result.message).toContain('.tiff');
    });

    it('should accept png format', async () => {
      mockIpcClient.insertDocxImage.mockResolvedValue({
        success: true, blockId: 'blk_123', fileToken: 'ft_456',
      });
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/image.png', index: 0 });
      expect(result.success).toBe(true);
    });

    it('should accept jpg format', async () => {
      mockIpcClient.insertDocxImage.mockResolvedValue({
        success: true, blockId: 'blk_123', fileToken: 'ft_456',
      });
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/image.jpg', index: 0 });
      expect(result.success).toBe(true);
    });

    it('should accept webp format', async () => {
      mockIpcClient.insertDocxImage.mockResolvedValue({
        success: true, blockId: 'blk_123', fileToken: 'ft_456',
      });
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/image.webp', index: 0 });
      expect(result.success).toBe(true);
    });
  });

  describe('file validation', () => {
    it('should return error when path is not a file', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => false, size: 0 } as any);
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/dir.png', index: 0 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not a file');
    });

    it('should return error when file does not exist', async () => {
      vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT: no such file'));
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/nonexistent.png', index: 0 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('ENOENT');
    });

    it('should return error when file exceeds 20MB', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 25 * 1024 * 1024 } as any);
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/large.png', index: 0 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('too large');
    });
  });

  describe('IPC availability', () => {
    it('should return error when IPC is unavailable', async () => {
      vi.mocked(isIpcAvailable).mockResolvedValue(false);
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/image.png', index: 0 });
      expect(result.success).toBe(false);
      expect(result.message).toContain('IPC connection');
    });
  });

  describe('path resolution', () => {
    it('should resolve relative paths using workspace dir', async () => {
      mockIpcClient.insertDocxImage.mockResolvedValue({
        success: true, blockId: 'blk_123', fileToken: 'ft_456',
      });
      await insert_docx_image({ documentId: 'doc123', imagePath: 'image.png', index: 0 });
      expect(mockIpcClient.insertDocxImage).toHaveBeenCalledWith('doc123', '/workspace/image.png', 0);
    });

    it('should use absolute paths directly', async () => {
      mockIpcClient.insertDocxImage.mockResolvedValue({
        success: true, blockId: 'blk_123', fileToken: 'ft_456',
      });
      await insert_docx_image({ documentId: 'doc123', imagePath: '/absolute/image.png', index: 5 });
      expect(mockIpcClient.insertDocxImage).toHaveBeenCalledWith('doc123', '/absolute/image.png', 5);
    });
  });

  describe('successful insertion', () => {
    it('should insert image and return block ID and file token', async () => {
      mockIpcClient.insertDocxImage.mockResolvedValue({
        success: true, blockId: 'blk_abc123', fileToken: 'ft_xyz789',
      });
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/chart.png', index: 3 });
      expect(result.success).toBe(true);
      expect(result.blockId).toBe('blk_abc123');
      expect(result.fileToken).toBe('ft_xyz789');
      expect(result.message).toContain('position 3');
      expect(result.message).toContain('doc123');
    });
  });

  describe('IPC failure', () => {
    it('should return error when IPC call fails', async () => {
      mockIpcClient.insertDocxImage.mockResolvedValue({
        success: false, error: 'Document not found',
      });
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/image.png', index: 0 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Document not found');
    });
  });

  describe('unexpected error handling', () => {
    it('should handle non-Error objects in catch', async () => {
      mockIpcClient.insertDocxImage.mockRejectedValue('string error');
      const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/test/image.png', index: 0 });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });
  });
});
