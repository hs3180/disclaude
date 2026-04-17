/**
 * Tests for upload_image tool.
 *
 * Issue #1919: Upload image and return image_key for card embedding.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getIpcClient: vi.fn(),
}));

vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn(),
}));

vi.mock('./credentials.js', () => ({
  getFeishuCredentials: vi.fn(),
  getWorkspaceDir: vi.fn().mockReturnValue('/workspace'),
}));

vi.mock('fs/promises', () => ({
  stat: vi.fn(),
}));

import { upload_image } from './upload-image.js';
import { isIpcAvailable } from './ipc-utils.js';
import { getFeishuCredentials } from './credentials.js';
import { getIpcClient } from '@disclaude/core';
import { stat } from 'fs/promises';

const mockedIsIpcAvailable = vi.mocked(isIpcAvailable);
const mockedGetCredentials = vi.mocked(getFeishuCredentials);
const mockedGetIpcClient = vi.mocked(getIpcClient);
const mockedStat = vi.mocked(stat);

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetCredentials.mockReturnValue({ appId: 'test_app', appSecret: 'test_secret' });
  mockedStat.mockResolvedValue({ isFile: () => true, size: 1024 } as never);
  mockedIsIpcAvailable.mockResolvedValue(true);
});

describe('upload_image', () => {
  it('should return success with image_key on valid upload', async () => {
    const mockUploadImage = vi.fn().mockResolvedValue({
      success: true,
      imageKey: 'img_test_key',
      fileName: 'chart.png',
    });
    mockedGetIpcClient.mockReturnValue({ uploadImage: mockUploadImage } as never);

    const result = await upload_image({ filePath: '/path/to/chart.png' });

    expect(result.success).toBe(true);
    expect(result.imageKey).toBe('img_test_key');
    expect(result.fileName).toBe('chart.png');
    expect(result.message).toContain('img_test_key');
  });

  it('should return error when platform not configured', async () => {
    mockedGetCredentials.mockReturnValue({ appId: '', appSecret: '' });

    const result = await upload_image({ filePath: '/path/to/chart.png' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Platform credentials not configured');
  });

  it('should return error for unsupported image format', async () => {
    const result = await upload_image({ filePath: '/path/to/file.txt' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsupported image format');
  });

  it('should return error when file is too large', async () => {
    mockedStat.mockResolvedValue({ isFile: () => true, size: 20 * 1024 * 1024 } as never);

    const result = await upload_image({ filePath: '/path/to/large.png' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('too large');
  });

  it('should return error when path is not a file', async () => {
    mockedStat.mockResolvedValue({ isFile: () => false, size: 0 } as never);

    const result = await upload_image({ filePath: '/path/to/dir' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('not a file');
  });

  it('should return error when IPC not available', async () => {
    mockedIsIpcAvailable.mockResolvedValue(false);

    const result = await upload_image({ filePath: '/path/to/chart.png' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('IPC not available');
  });

  it('should return error when IPC upload fails', async () => {
    const mockUploadImage = vi.fn().mockResolvedValue({
      success: false,
      error: 'uploadImage not supported',
    });
    mockedGetIpcClient.mockReturnValue({ uploadImage: mockUploadImage } as never);

    const result = await upload_image({ filePath: '/path/to/chart.png' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to upload image');
  });

  it('should return error when stat throws', async () => {
    mockedStat.mockRejectedValue(new Error('ENOENT: no such file') as never);

    const result = await upload_image({ filePath: '/nonexistent.png' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('ENOENT');
  });

  it('should resolve relative paths against workspace dir', async () => {
    const mockUploadImage = vi.fn().mockResolvedValue({
      success: true,
      imageKey: 'img_rel',
      fileName: 'chart.png',
    });
    mockedGetIpcClient.mockReturnValue({ uploadImage: mockUploadImage } as never);

    const result = await upload_image({ filePath: 'chart.png' });

    expect(result.success).toBe(true);
    expect(mockUploadImage).toHaveBeenCalledWith('/workspace/chart.png');
  });

  it('should accept all supported image formats', async () => {
    const mockUploadImage = vi.fn().mockResolvedValue({
      success: true,
      imageKey: 'img_key',
      fileName: 'test.jpg',
    });
    mockedGetIpcClient.mockReturnValue({ uploadImage: mockUploadImage } as never);

    const formats = ['test.jpg', 'test.jpeg', 'test.png', 'test.webp', 'test.gif', 'test.tiff', 'test.bmp', 'test.ico'];
    for (const fmt of formats) {
      const result = await upload_image({ filePath: `/path/${fmt}` });
      expect(result.success).toBe(true);
    }
  });
});
