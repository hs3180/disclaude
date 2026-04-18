/**
 * Tests for insert_docx_image tool.
 *
 * Issue #2278: Insert image into Feishu docx at specific position.
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

import { insert_docx_image } from './insert-docx-image.js';
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

describe('insert_docx_image', () => {
  it('should return success with blockId and fileToken on valid insert', async () => {
    const mockInsertDocxImage = vi.fn().mockResolvedValue({
      success: true,
      blockId: 'blk_test123',
      fileToken: 'file_test456',
    });
    mockedGetIpcClient.mockReturnValue({ insertDocxImage: mockInsertDocxImage } as never);

    const result = await insert_docx_image({
      documentId: 'doxcnABCDEFG12345',
      imagePath: '/path/to/chart.png',
      index: 3,
      caption: 'Figure 1: Revenue',
    });

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('blk_test123');
    expect(result.fileToken).toBe('file_test456');
    expect(result.message).toContain('chart.png');
    expect(result.message).toContain('position 3');
    expect(mockInsertDocxImage).toHaveBeenCalledWith(
      'doxcnABCDEFG12345',
      '/path/to/chart.png',
      3,
      'Figure 1: Revenue',
    );
  });

  it('should return error when platform not configured', async () => {
    mockedGetCredentials.mockReturnValue({ appId: '', appSecret: '' });

    const result = await insert_docx_image({
      documentId: 'doxcnABCDEFG12345',
      imagePath: '/path/to/chart.png',
      index: 0,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Platform credentials not configured');
  });

  it('should return error for unsupported image format', async () => {
    const result = await insert_docx_image({
      documentId: 'doxcnABCDEFG12345',
      imagePath: '/path/to/file.txt',
      index: 0,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsupported image format');
  });

  it('should return error when file is too large', async () => {
    mockedStat.mockResolvedValue({ isFile: () => true, size: 25 * 1024 * 1024 } as never);

    const result = await insert_docx_image({
      documentId: 'doxcnABCDEFG12345',
      imagePath: '/path/to/large.png',
      index: 0,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('too large');
  });

  it('should return error when path is not a file', async () => {
    mockedStat.mockResolvedValue({ isFile: () => false, size: 0 } as never);

    const result = await insert_docx_image({
      documentId: 'doxcnABCDEFG12345',
      imagePath: '/path/to/dir.png',
      index: 0,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('not a file');
  });

  it('should return error when IPC not available', async () => {
    mockedIsIpcAvailable.mockResolvedValue(false);

    const result = await insert_docx_image({
      documentId: 'doxcnABCDEFG12345',
      imagePath: '/path/to/chart.png',
      index: 0,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('IPC not available');
  });

  it('should return error when IPC insertDocxImage fails', async () => {
    const mockInsertDocxImage = vi.fn().mockResolvedValue({
      success: false,
      error: 'block_type invalid',
    });
    mockedGetIpcClient.mockReturnValue({ insertDocxImage: mockInsertDocxImage } as never);

    const result = await insert_docx_image({
      documentId: 'doxcnABCDEFG12345',
      imagePath: '/path/to/chart.png',
      index: 0,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to insert image');
  });

  it('should return error when stat throws', async () => {
    mockedStat.mockRejectedValue(new Error('ENOENT: no such file') as never);

    const result = await insert_docx_image({
      documentId: 'doxcnABCDEFG12345',
      imagePath: '/nonexistent.png',
      index: 0,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('ENOENT');
  });

  it('should resolve relative paths against workspace dir', async () => {
    const mockInsertDocxImage = vi.fn().mockResolvedValue({
      success: true,
      blockId: 'blk_rel',
      fileToken: 'file_rel',
    });
    mockedGetIpcClient.mockReturnValue({ insertDocxImage: mockInsertDocxImage } as never);

    const result = await insert_docx_image({
      documentId: 'doxcnTest',
      imagePath: 'chart.png',
      index: 0,
    });

    expect(result.success).toBe(true);
    expect(mockInsertDocxImage).toHaveBeenCalledWith('doxcnTest', '/workspace/chart.png', 0, undefined);
  });

  it('should reject negative index', async () => {
    const result = await insert_docx_image({
      documentId: 'doxcnTest',
      imagePath: '/path/to/chart.png',
      index: -1,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('index must be a non-negative number');
  });

  it('should work without caption', async () => {
    const mockInsertDocxImage = vi.fn().mockResolvedValue({
      success: true,
      blockId: 'blk_nocap',
      fileToken: 'file_nocap',
    });
    mockedGetIpcClient.mockReturnValue({ insertDocxImage: mockInsertDocxImage } as never);

    const result = await insert_docx_image({
      documentId: 'doxcnTest',
      imagePath: '/path/to/image.png',
      index: 5,
    });

    expect(result.success).toBe(true);
    expect(mockInsertDocxImage).toHaveBeenCalledWith('doxcnTest', '/path/to/image.png', 5, undefined);
  });
});
