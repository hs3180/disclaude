/**
 * Unit tests for upload_image tool.
 *
 * Issue #1919: Image upload for card embedding.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock IPC utilities
vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn(),
}));

// Mock @disclaude/core
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getIpcClient: vi.fn(),
}));

import { upload_image } from './upload-image.js';
import { isIpcAvailable } from './ipc-utils.js';
import { getIpcClient } from '@disclaude/core';

const mockedIsIpcAvailable = vi.mocked(isIpcAvailable);
const mockedGetIpcClient = vi.mocked(getIpcClient);

describe('upload_image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return error when imagePath is empty', async () => {
    const result = await upload_image({ imagePath: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('imagePath is required');
  });

  it('should return error when file does not exist', async () => {
    const result = await upload_image({ imagePath: '/nonexistent/image.png' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('no such file');
  });

  it('should return error when IPC is not available', async () => {
    // Create a temporary test file
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const tmpDir = os.tmpdir();
    const testFile = path.join(tmpDir, `test-image-${Date.now()}.png`);
    await fs.writeFile(testFile, Buffer.alloc(100));

    try {
      mockedIsIpcAvailable.mockResolvedValue(false);

      const result = await upload_image({ imagePath: testFile });
      expect(result.success).toBe(false);
      expect(result.message).toContain('IPC connection');
    } finally {
      await fs.unlink(testFile).catch(() => {});
    }
  });

  it('should successfully upload image via IPC', async () => {
    // Create a temporary test file
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const tmpDir = os.tmpdir();
    const testFile = path.join(tmpDir, `test-image-${Date.now()}.png`);
    const fileContent = Buffer.alloc(1024); // 1KB test file
    await fs.writeFile(testFile, fileContent);

    try {
      mockedIsIpcAvailable.mockResolvedValue(true);
      const mockIpcClient = {
        uploadImage: vi.fn().mockResolvedValue({
          success: true,
          imageKey: 'img_v3_test_key',
          imageName: 'test-image.png',
          imageSize: 1024,
        }),
      };
      mockedGetIpcClient.mockReturnValue(mockIpcClient as never);

      const result = await upload_image({ imagePath: testFile });
      expect(result.success).toBe(true);
      expect(result.imageKey).toBe('img_v3_test_key');
      expect(result.message).toContain('img_v3_test_key');
      expect(result.message).toContain('card img elements');
      expect(mockIpcClient.uploadImage).toHaveBeenCalledWith(testFile);
    } finally {
      await fs.unlink(testFile).catch(() => {});
    }
  });

  it('should return error when IPC upload fails', async () => {
    // Create a temporary test file
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const tmpDir = os.tmpdir();
    const testFile = path.join(tmpDir, `test-image-${Date.now()}.jpg`);
    await fs.writeFile(testFile, Buffer.alloc(100));

    try {
      mockedIsIpcAvailable.mockResolvedValue(true);
      const mockIpcClient = {
        uploadImage: vi.fn().mockResolvedValue({
          success: false,
          error: 'Upload quota exceeded',
        }),
      };
      mockedGetIpcClient.mockReturnValue(mockIpcClient as never);

      const result = await upload_image({ imagePath: testFile });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Upload quota exceeded');
    } finally {
      await fs.unlink(testFile).catch(() => {});
    }
  });

  it('should reject unsupported image formats', async () => {
    // Create a temporary test file with unsupported extension
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const tmpDir = os.tmpdir();
    const testFile = path.join(tmpDir, `test-file-${Date.now()}.svg`);
    await fs.writeFile(testFile, Buffer.alloc(100));

    try {
      const result = await upload_image({ imagePath: testFile });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported image format');
      expect(result.error).toContain('.svg');
    } finally {
      await fs.unlink(testFile).catch(() => {});
    }
  });
});
