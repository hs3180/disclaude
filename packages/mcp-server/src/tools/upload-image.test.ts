/**
 * Tests for upload_image tool.
 *
 * Issue #1919: Upload image and return image_key for card embedding.
 *
 * @module mcp-server/tools/upload-image.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { upload_image } from './upload-image.js';
import * as ipcUtils from './ipc-utils.js';
import * as credentials from './credentials.js';
import * as coreModule from '@disclaude/core';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';

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

vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn(),
  getIpcErrorMessage: vi.fn(),
}));

vi.mock('./credentials.js', () => ({
  getFeishuCredentials: vi.fn(),
  getWorkspaceDir: vi.fn(),
}));

describe('upload_image', () => {
  let testFilePath: string;

  beforeEach(async () => {
    // Create a small test PNG file
    const testDir = path.join(tmpdir(), `upload-image-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    testFilePath = path.join(testDir, 'test.png');

    // Minimal PNG header (8 bytes)
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fs.writeFile(testFilePath, pngHeader);

    vi.mocked(credentials.getFeishuCredentials).mockReturnValue({
      appId: 'test-app-id',
      appSecret: 'test-app-secret',
    });
    vi.mocked(credentials.getWorkspaceDir).mockReturnValue(tmpdir());
  });

  afterEach(async () => {
    // Clean up test files
    try {
      const dir = path.dirname(testFilePath);
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    vi.restoreAllMocks();
  });

  it('should return error when filePath is empty', async () => {
    const result = await upload_image({ filePath: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('filePath is required');
  });

  it('should return error when platform credentials not configured', async () => {
    vi.mocked(credentials.getFeishuCredentials).mockReturnValue({
      appId: '',
      appSecret: '',
    });
    const result = await upload_image({ filePath: '/some/image.png' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('Platform is not configured');
  });

  it('should return error when file does not exist', async () => {
    vi.mocked(ipcUtils.isIpcAvailable).mockResolvedValue(true);
    const result = await upload_image({ filePath: '/nonexistent/image.png' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('ENOENT');
  });

  it('should return error for unsupported image format', async () => {
    // Create a file with unsupported extension
    const unsupportedPath = testFilePath.replace('.png', '.xyz');
    await fs.writeFile(unsupportedPath, Buffer.from('data'));

    const result = await upload_image({ filePath: unsupportedPath });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsupported image format');
  });

  it('should return error when IPC not available', async () => {
    vi.mocked(ipcUtils.isIpcAvailable).mockResolvedValue(false);
    const result = await upload_image({ filePath: testFilePath });
    expect(result.success).toBe(false);
    expect(result.message).toContain('IPC');
  });

  it('should upload image successfully via IPC', async () => {
    vi.mocked(ipcUtils.isIpcAvailable).mockResolvedValue(true);

    const mockUploadImage = vi.fn().mockResolvedValue({
      success: true,
      imageKey: 'img_v3_test123',
      fileName: 'test.png',
      fileSize: 8,
    });

    vi.mocked(coreModule.getIpcClient).mockReturnValue({
      uploadImage: mockUploadImage,
    } as unknown as ReturnType<typeof coreModule.getIpcClient>);

    const result = await upload_image({ filePath: testFilePath });

    expect(result.success).toBe(true);
    expect(result.imageKey).toBe('img_v3_test123');
    expect(result.message).toContain('img_v3_test123');
    expect(result.message).toContain('test.png');
    expect(mockUploadImage).toHaveBeenCalledWith(testFilePath);
  });

  it('should return error when IPC upload fails', async () => {
    vi.mocked(ipcUtils.isIpcAvailable).mockResolvedValue(true);

    const mockUploadImage = vi.fn().mockResolvedValue({
      success: false,
      error: 'Upload failed',
    });

    vi.mocked(coreModule.getIpcClient).mockReturnValue({
      uploadImage: mockUploadImage,
    } as unknown as ReturnType<typeof coreModule.getIpcClient>);

    const result = await upload_image({ filePath: testFilePath });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Upload failed');
  });

  it('should handle relative paths by resolving against workspace dir', async () => {
    vi.mocked(ipcUtils.isIpcAvailable).mockResolvedValue(true);
    vi.mocked(credentials.getWorkspaceDir).mockReturnValue(path.dirname(testFilePath));

    const mockUploadImage = vi.fn().mockResolvedValue({
      success: true,
      imageKey: 'img_v3_relative',
      fileName: 'test.png',
      fileSize: 8,
    });

    vi.mocked(coreModule.getIpcClient).mockReturnValue({
      uploadImage: mockUploadImage,
    } as unknown as ReturnType<typeof coreModule.getIpcClient>);

    const result = await upload_image({ filePath: 'test.png' });

    expect(result.success).toBe(true);
    expect(result.imageKey).toBe('img_v3_relative');
    // Should have resolved to absolute path
    expect(mockUploadImage).toHaveBeenCalledWith(testFilePath);
  });
});
