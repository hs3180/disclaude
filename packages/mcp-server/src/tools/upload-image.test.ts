/**
 * Tests for upload_image tool implementation.
 *
 * Issue #1919: Image upload for card embedding.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before imports
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
  getIpcErrorMessage: vi.fn(),
}));

vi.mock('./credentials.js', () => ({
  getFeishuCredentials: vi.fn(() => ({ appId: 'test_app', appSecret: 'test_secret' })),
  getWorkspaceDir: vi.fn(() => '/workspace'),
}));

vi.mock('fs/promises', () => ({
  stat: vi.fn(),
}));

import { upload_image } from './upload-image.js';
import { isIpcAvailable } from './ipc-utils.js';
import { getFeishuCredentials } from './credentials.js';
import { getIpcClient } from '@disclaude/core';
import * as fs from 'fs/promises';

const mockedStat = vi.mocked(fs.stat);

describe('upload_image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return error when platform credentials are not configured', async () => {
    vi.mocked(getFeishuCredentials).mockReturnValue({ appId: '', appSecret: '' });

    const result = await upload_image({ filePath: '/path/to/image.png' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Platform is not configured');
  });

  it('should return error for unsupported file format', async () => {
    vi.mocked(getFeishuCredentials).mockReturnValue({ appId: 'app', appSecret: 'secret' });
    mockedStat.mockResolvedValue({ isFile: () => true, size: 100 } as any);

    const result = await upload_image({ filePath: '/path/to/file.pdf' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Unsupported image format');
  });

  it('should return error when file does not exist', async () => {
    vi.mocked(getFeishuCredentials).mockReturnValue({ appId: 'app', appSecret: 'secret' });
    mockedStat.mockRejectedValue(new Error('ENOENT: no such file'));

    const result = await upload_image({ filePath: '/nonexistent/image.png' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to upload image');
  });

  it('should return error when file is too large', async () => {
    vi.mocked(getFeishuCredentials).mockReturnValue({ appId: 'app', appSecret: 'secret' });
    mockedStat.mockResolvedValue({ isFile: () => true, size: 15 * 1024 * 1024 } as any);

    const result = await upload_image({ filePath: '/path/to/large.png' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('too large');
  });

  it('should return error when IPC is not available', async () => {
    vi.mocked(getFeishuCredentials).mockReturnValue({ appId: 'app', appSecret: 'secret' });
    mockedStat.mockResolvedValue({ isFile: () => true, size: 1024 } as any);
    vi.mocked(isIpcAvailable).mockResolvedValue(false);

    const result = await upload_image({ filePath: '/path/to/image.png' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('IPC');
  });

  it('should upload image successfully and return image_key', async () => {
    vi.mocked(getFeishuCredentials).mockReturnValue({ appId: 'app', appSecret: 'secret' });
    mockedStat.mockResolvedValue({ isFile: () => true, size: 5000 } as any);
    vi.mocked(isIpcAvailable).mockResolvedValue(true);

    const mockUploadImage = vi.fn().mockResolvedValue({
      success: true,
      imageKey: 'img_test_key_123',
      fileName: 'chart.png',
      fileSize: 5000,
    });
    vi.mocked(getIpcClient).mockReturnValue({ uploadImage: mockUploadImage } as any);

    const result = await upload_image({ filePath: '/path/to/chart.png' });

    expect(result.success).toBe(true);
    expect(result.imageKey).toBe('img_test_key_123');
    expect(result.fileName).toBe('chart.png');
    expect(result.message).toContain('img_test_key_123');
    expect(mockUploadImage).toHaveBeenCalledWith('/path/to/chart.png');
  });

  it('should resolve relative paths against workspace dir', async () => {
    vi.mocked(getFeishuCredentials).mockReturnValue({ appId: 'app', appSecret: 'secret' });
    mockedStat.mockResolvedValue({ isFile: () => true, size: 3000 } as any);
    vi.mocked(isIpcAvailable).mockResolvedValue(true);

    const mockUploadImage = vi.fn().mockResolvedValue({
      success: true,
      imageKey: 'img_key_456',
      fileName: 'photo.jpg',
      fileSize: 3000,
    });
    vi.mocked(getIpcClient).mockReturnValue({ uploadImage: mockUploadImage } as any);

    const result = await upload_image({ filePath: 'photo.jpg' });

    expect(result.success).toBe(true);
    expect(mockUploadImage).toHaveBeenCalledWith('/workspace/photo.jpg');
  });

  it('should handle IPC upload failure', async () => {
    vi.mocked(getFeishuCredentials).mockReturnValue({ appId: 'app', appSecret: 'secret' });
    mockedStat.mockResolvedValue({ isFile: () => true, size: 2000 } as any);
    vi.mocked(isIpcAvailable).mockResolvedValue(true);

    const mockUploadImage = vi.fn().mockResolvedValue({
      success: false,
      error: 'Feishu API error: invalid token',
    });
    vi.mocked(getIpcClient).mockReturnValue({ uploadImage: mockUploadImage } as any);

    const result = await upload_image({ filePath: '/path/to/image.png' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Feishu API error');
  });
});
