/**
 * Tests for insert_docx_image tool.
 *
 * Issue #2278: Inline image insertion in Feishu docx documents.
 *
 * @module mcp-server/tools/insert-docx-image.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs/promises';

// Mock dependencies before importing the module under test
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getIpcClient: vi.fn(),
  Config: {
    FEISHU_APP_ID: 'test-app-id',
    FEISHU_APP_SECRET: 'test-app-secret',
    getWorkspaceDir: () => '/workspace',
  },
}));

vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn(),
}));

vi.mock('./credentials.js', () => ({
  getFeishuCredentials: vi.fn(() => ({
    appId: 'test-app-id',
    appSecret: 'test-app-secret',
  })),
  getWorkspaceDir: () => '/workspace',
}));

vi.mock('fs/promises', () => ({
  default: {
    stat: vi.fn(),
  },
  stat: vi.fn(),
}));

import { insert_docx_image } from './insert-docx-image.js';
import { isIpcAvailable } from './ipc-utils.js';
import { getIpcClient } from '@disclaude/core';
import { getFeishuCredentials } from './credentials.js';

describe('insert_docx_image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fail when platform credentials are not configured', async () => {
    vi.mocked(getFeishuCredentials).mockReturnValueOnce({ appId: undefined, appSecret: undefined });

    const result = await insert_docx_image({
      documentId: 'doxcnTest',
      imagePath: '/path/to/image.png',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Platform is not configured');
  });

  it('should fail for non-image file extensions', async () => {
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 1024 } as any);

    const result = await insert_docx_image({
      documentId: 'doxcnTest',
      imagePath: '/path/to/file.pdf',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Not an image file');
  });

  it('should fail for files exceeding 20MB', async () => {
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
    vi.mocked(fs.stat).mockResolvedValue({
      isFile: () => true,
      size: 25 * 1024 * 1024,
    } as any);

    const result = await insert_docx_image({
      documentId: 'doxcnTest',
      imagePath: '/path/to/large-image.png',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('too large');
  });

  it('should fail when IPC is not available', async () => {
    vi.mocked(isIpcAvailable).mockResolvedValue(false);
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 1024 } as any);

    const result = await insert_docx_image({
      documentId: 'doxcnTest',
      imagePath: '/path/to/image.png',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('IPC');
  });

  it('should successfully insert image via IPC', async () => {
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 1024 } as any);

    const mockInsertDocxImage = vi.fn().mockResolvedValue({
      success: true,
      blockId: 'blk-test-123',
    });
    vi.mocked(getIpcClient).mockReturnValue({
      insertDocxImage: mockInsertDocxImage,
    } as any);

    const result = await insert_docx_image({
      documentId: 'doxcnTest',
      imagePath: '/path/to/image.png',
      index: 5,
      caption: 'Test Caption',
    });

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('blk-test-123');
    expect(result.message).toContain('blk-test-123');
    expect(mockInsertDocxImage).toHaveBeenCalledWith(
      'doxcnTest',
      '/path/to/image.png',
      5,
      'Test Caption'
    );
  });

  it('should handle IPC errors gracefully', async () => {
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 1024 } as any);

    const mockInsertDocxImage = vi.fn().mockResolvedValue({
      success: false,
      error: 'Upload failed',
    });
    vi.mocked(getIpcClient).mockReturnValue({
      insertDocxImage: mockInsertDocxImage,
    } as any);

    const result = await insert_docx_image({
      documentId: 'doxcnTest',
      imagePath: '/path/to/image.png',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Upload failed');
  });

  it('should resolve relative paths against workspace directory', async () => {
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 2048 } as any);

    const mockInsertDocxImage = vi.fn().mockResolvedValue({
      success: true,
      blockId: 'blk-test-456',
    });
    vi.mocked(getIpcClient).mockReturnValue({
      insertDocxImage: mockInsertDocxImage,
    } as any);

    await insert_docx_image({
      documentId: 'doxcnTest',
      imagePath: './charts/sales.png',
    });

    expect(mockInsertDocxImage).toHaveBeenCalledWith(
      'doxcnTest',
      '/workspace/charts/sales.png',
      undefined,
      undefined
    );
  });
});
