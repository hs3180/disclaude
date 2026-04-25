/**
 * Tests for insert_docx_image tool.
 *
 * Issue #2278: Inline image insertion in Feishu documents.
 *
 * @module mcp-server/tools/insert-docx-image.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { insert_docx_image } from './insert-docx-image.js';
import * as credentials from './credentials.js';
import * as ipcUtils from './ipc-utils.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

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
}));

vi.mock('./credentials.js', () => ({
  getFeishuCredentials: vi.fn(),
  getWorkspaceDir: vi.fn(),
}));

describe('insert_docx_image', () => {
  let tempDir: string;
  let tempImageFile: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-insert-docx-'));
    tempImageFile = path.join(tempDir, 'test-image.png');

    // Create a fake PNG file (minimal valid PNG header)
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 pixel
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // 8-bit RGB
      0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT chunk
      0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
      0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
      0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, // IEND chunk
      0x44, 0xAE, 0x42, 0x60, 0x82,
    ]);
    await fs.writeFile(tempImageFile, pngHeader);

    vi.mocked(credentials.getFeishuCredentials).mockReturnValue({
      appId: 'test-app-id',
      appSecret: 'test-app-secret',
    });
    vi.mocked(credentials.getWorkspaceDir).mockReturnValue(tempDir);
    vi.mocked(ipcUtils.isIpcAvailable).mockResolvedValue(true);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should return error when documentId is empty', async () => {
    const result = await insert_docx_image({
      documentId: '',
      filePath: tempImageFile,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('documentId is required');
  });

  it('should return error when filePath is empty', async () => {
    const result = await insert_docx_image({
      documentId: 'doc123',
      filePath: '',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('filePath is required');
  });

  it('should return error when platform credentials not configured', async () => {
    vi.mocked(credentials.getFeishuCredentials).mockReturnValue({
      appId: undefined,
      appSecret: undefined,
    });

    const result = await insert_docx_image({
      documentId: 'doc123',
      filePath: tempImageFile,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Platform is not configured');
  });

  it('should return error when IPC is not available', async () => {
    vi.mocked(ipcUtils.isIpcAvailable).mockResolvedValue(false);

    const result = await insert_docx_image({
      documentId: 'doc123',
      filePath: tempImageFile,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('IPC connection');
  });

  it('should return error for non-existent file', async () => {
    const { getIpcClient } = await import('@disclaude/core');
    vi.mocked(getIpcClient).mockReturnValue({
      insertDocxImage: vi.fn().mockResolvedValue({ success: true, blockId: 'block123' }),
    } as any);

    const result = await insert_docx_image({
      documentId: 'doc123',
      filePath: '/nonexistent/image.png',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to insert image');
  });

  it('should return error for unsupported file format', async () => {
    const txtFile = path.join(tempDir, 'test.txt');
    await fs.writeFile(txtFile, 'not an image');

    const result = await insert_docx_image({
      documentId: 'doc123',
      filePath: txtFile,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Unsupported image format');
  });

  it('should successfully insert image via IPC', async () => {
    const { getIpcClient } = await import('@disclaude/core');
    const mockInsertDocxImage = vi.fn().mockResolvedValue({
      success: true,
      blockId: 'block_abc123',
    });
    vi.mocked(getIpcClient).mockReturnValue({
      insertDocxImage: mockInsertDocxImage,
    } as any);

    const result = await insert_docx_image({
      documentId: 'doxcnGxxxxxxx',
      filePath: tempImageFile,
      index: 3,
    });

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('block_abc123');
    expect(result.message).toContain('Image inserted');

    // Verify IPC was called with correct params
    expect(mockInsertDocxImage).toHaveBeenCalledWith(
      'doxcnGxxxxxxx',
      tempImageFile,
      3
    );
  });

  it('should insert image with default index (append to end)', async () => {
    const { getIpcClient } = await import('@disclaude/core');
    const mockInsertDocxImage = vi.fn().mockResolvedValue({
      success: true,
      blockId: 'block_xyz',
    });
    vi.mocked(getIpcClient).mockReturnValue({
      insertDocxImage: mockInsertDocxImage,
    } as any);

    const result = await insert_docx_image({
      documentId: 'doxcnGxxxxxxx',
      filePath: tempImageFile,
    });

    expect(result.success).toBe(true);
    // index should be undefined (defaults to -1 = append)
    expect(mockInsertDocxImage).toHaveBeenCalledWith(
      'doxcnGxxxxxxx',
      tempImageFile,
      undefined
    );
  });

  it('should handle IPC failure gracefully', async () => {
    const { getIpcClient } = await import('@disclaude/core');
    vi.mocked(getIpcClient).mockReturnValue({
      insertDocxImage: vi.fn().mockResolvedValue({
        success: false,
        error: 'document not found',
      }),
    } as any);

    const result = await insert_docx_image({
      documentId: 'invalid-doc-id',
      filePath: tempImageFile,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to insert');
  });

  it('should handle IPC connection error', async () => {
    const { getIpcClient } = await import('@disclaude/core');
    vi.mocked(getIpcClient).mockReturnValue({
      insertDocxImage: vi.fn().mockRejectedValue(new Error('IPC_REQUEST_FAILED: timeout')),
    } as any);

    const result = await insert_docx_image({
      documentId: 'doc123',
      filePath: tempImageFile,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to insert');
  });
});
