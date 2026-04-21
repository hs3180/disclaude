/**
 * Tests for upload_image tool.
 *
 * Issue #1919: Image upload for card embedding.
 *
 * @module mcp-server/tools/upload-image.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock @disclaude/core before importing the module under test
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getIpcClient: vi.fn(),
}));

// Mock ipc-utils
vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn(),
}));

// Mock credentials
vi.mock('./credentials.js', () => ({
  getFeishuCredentials: vi.fn(),
  getWorkspaceDir: vi.fn(),
}));

import { upload_image } from './upload-image.js';
import { getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';
import { getFeishuCredentials, getWorkspaceDir } from './credentials.js';

const mockedGetIpcClient = vi.mocked(getIpcClient);
const mockedIsIpcAvailable = vi.mocked(isIpcAvailable);
const mockedGetFeishuCredentials = vi.mocked(getFeishuCredentials);
const mockedGetWorkspaceDir = vi.mocked(getWorkspaceDir);

describe('upload_image', () => {
  let tempDir: string;
  let tempImageFile: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create a temp directory and a dummy image file
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-image-test-'));
    tempImageFile = path.join(tempDir, 'test-chart.png');
    await fs.writeFile(tempImageFile, Buffer.alloc(1024)); // 1KB dummy file

    // Default mock setup
    mockedGetFeishuCredentials.mockReturnValue({ appId: 'test-app', appSecret: 'test-secret' });
    mockedGetWorkspaceDir.mockReturnValue(tempDir);
    mockedIsIpcAvailable.mockResolvedValue(true);
    mockedGetIpcClient.mockReturnValue({
      uploadImage: vi.fn().mockResolvedValue({
        success: true,
        imageKey: 'img_v3_test123',
        fileName: 'test-chart.png',
        fileSize: 1024,
      }),
    } as unknown as ReturnType<typeof getIpcClient>);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should successfully upload an image and return image_key', async () => {
    const result = await upload_image({ filePath: tempImageFile });

    expect(result.success).toBe(true);
    expect(result.imageKey).toBe('img_v3_test123');
    expect(result.fileName).toBe('test-chart.png');
    expect(result.fileSize).toBe(1024);
    expect(result.message).toContain('img_v3_test123');
    expect(result.message).toContain('image_key');
  });

  it('should reject unsupported image formats', async () => {
    const pdfFile = path.join(tempDir, 'document.pdf');
    await fs.writeFile(pdfFile, Buffer.alloc(100));

    const result = await upload_image({ filePath: pdfFile });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Unsupported image format');
    expect(result.message).toContain('.pdf');
  });

  it('should handle server-side file size validation errors', async () => {
    // File size validation happens server-side in feishu-channel.ts.
    // Test that the tool correctly propagates upload errors from IPC.
    mockedGetIpcClient.mockReturnValue({
      uploadImage: vi.fn().mockResolvedValue({
        success: false,
        error: 'Image file too large: 11534336 bytes (max 10MB)',
      }),
    } as unknown as ReturnType<typeof getIpcClient>);

    const result = await upload_image({ filePath: tempImageFile });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to upload image');
    expect(result.message).toContain('too large');
  });

  it('should return error when platform credentials not configured', async () => {
    mockedGetFeishuCredentials.mockReturnValue({ appId: '', appSecret: '' });

    const result = await upload_image({ filePath: tempImageFile });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Platform is not configured');
  });

  it('should return error when IPC is not available', async () => {
    mockedIsIpcAvailable.mockResolvedValue(false);

    const result = await upload_image({ filePath: tempImageFile });

    expect(result.success).toBe(false);
    expect(result.message).toContain('IPC connection');
  });

  it('should return error when filePath is empty', async () => {
    const result = await upload_image({ filePath: '' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('filePath is required');
  });

  it('should return error when file does not exist', async () => {
    const result = await upload_image({ filePath: '/nonexistent/file.png' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to upload image');
  });

  it('should handle IPC upload failure', async () => {
    mockedGetIpcClient.mockReturnValue({
      uploadImage: vi.fn().mockResolvedValue({
        success: false,
        error: 'uploadImage not supported by this channel',
      }),
    } as unknown as ReturnType<typeof getIpcClient>);

    const result = await upload_image({ filePath: tempImageFile });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to upload image');
  });

  it('should handle IPC connection error', async () => {
    mockedGetIpcClient.mockReturnValue({
      uploadImage: vi.fn().mockRejectedValue(new Error('IPC_NOT_AVAILABLE: connection failed')),
    } as unknown as ReturnType<typeof getIpcClient>);

    const result = await upload_image({ filePath: tempImageFile });

    expect(result.success).toBe(false);
    expect(result.message).toContain('IPC_NOT_AVAILABLE');
  });

  it('should resolve relative paths against workspace directory', async () => {
    const relativePath = 'test-chart.png';
    mockedGetWorkspaceDir.mockReturnValue(tempDir);

    const result = await upload_image({ filePath: relativePath });

    expect(result.success).toBe(true);
    expect(result.imageKey).toBe('img_v3_test123');
  });

  it('should accept all supported image formats', async () => {
    const supportedFormats = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.ico'];

    for (const ext of supportedFormats) {
      const filePath = path.join(tempDir, `test${ext}`);
      await fs.writeFile(filePath, Buffer.alloc(100));

      const result = await upload_image({ filePath });
      expect(result.success).toBe(true);

      await fs.unlink(filePath).catch(() => {});
    }
  });
});
