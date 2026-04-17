/**
 * Unit tests for insert_docx_image tool.
 *
 * Issue #2278: Inline image insertion in Feishu documents.
 *
 * @module mcp-server/tools/insert-docx-image.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getIpcClient: vi.fn(),
  Config: {
    FEISHU_APP_ID: 'test_app_id',
    FEISHU_APP_SECRET: 'test_app_secret',
    getWorkspaceDir: () => '/test/workspace',
  },
}));

vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn(),
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
import * as fs from 'fs/promises';

describe('insert_docx_image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return error when documentId is missing', async () => {
    const result = await insert_docx_image({
      documentId: '',
      imagePath: '/path/to/image.png',
      index: 0,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('documentId is required');
  });

  it('should return error when imagePath is missing', async () => {
    const result = await insert_docx_image({
      documentId: 'doc_123',
      imagePath: '',
      index: 0,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('imagePath is required');
  });

  it('should return error when index is negative', async () => {
    const result = await insert_docx_image({
      documentId: 'doc_123',
      imagePath: '/path/to/image.png',
      index: -1,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('index must be a non-negative integer');
  });

  it('should return error when IPC is not available', async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as any);
    vi.mocked(isIpcAvailable).mockResolvedValue(false);

    const result = await insert_docx_image({
      documentId: 'doc_123',
      imagePath: '/path/to/image.png',
      index: 3,
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('IPC');
  });

  it('should return error for unsupported image format', async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as any);
    vi.mocked(isIpcAvailable).mockResolvedValue(true);

    const result = await insert_docx_image({
      documentId: 'doc_123',
      imagePath: '/path/to/document.pdf',
      index: 0,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsupported image format');
  });

  it('should successfully insert image via IPC', async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as any);
    vi.mocked(isIpcAvailable).mockResolvedValue(true);

    const mockIpcClient = {
      insertDocxImage: vi.fn().mockResolvedValue({
        success: true,
        blockId: 'blk_abc123',
      }),
    };
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);

    const result = await insert_docx_image({
      documentId: 'doc_123',
      imagePath: '/path/to/chart.png',
      index: 3,
    });

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('blk_abc123');
    expect(result.message).toContain('position 3');
    expect(mockIpcClient.insertDocxImage).toHaveBeenCalledWith(
      'doc_123',
      '/path/to/chart.png',
      3,
    );
  });

  it('should handle IPC failure', async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as any);
    vi.mocked(isIpcAvailable).mockResolvedValue(true);

    const mockIpcClient = {
      insertDocxImage: vi.fn().mockResolvedValue({
        success: false,
        error: 'Document not found',
      }),
    };
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);

    const result = await insert_docx_image({
      documentId: 'doc_nonexistent',
      imagePath: '/path/to/image.png',
      index: 0,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Document not found');
  });

  it('should resolve relative paths using workspace dir', async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as any);
    vi.mocked(isIpcAvailable).mockResolvedValue(true);

    const mockIpcClient = {
      insertDocxImage: vi.fn().mockResolvedValue({
        success: true,
        blockId: 'blk_xyz',
      }),
    };
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);

    await insert_docx_image({
      documentId: 'doc_123',
      imagePath: 'images/chart.jpg',
      index: 0,
    });

    expect(mockIpcClient.insertDocxImage).toHaveBeenCalledWith(
      'doc_123',
      '/test/workspace/images/chart.jpg',
      0,
    );
  });

  it('should handle non-file paths', async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => false } as any);

    const result = await insert_docx_image({
      documentId: 'doc_123',
      imagePath: '/path/to/directory',
      index: 0,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not a file');
  });
});
