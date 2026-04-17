/**
 * Tests for insert_docx_image tool.
 *
 * Issue #2278: Insert image at specific position in Feishu document.
 * Issue #918: Uses dependency injection instead of vi.mock() for external SDKs.
 *
 * @module mcp-server/tools/insert-docx-image.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { insert_docx_image, _setLarkClientFactory, _resetLarkClientFactory, type LarkDocxClient } from './insert-docx-image.js';

// Mock core (allowed by ESLint rules)
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
  Config: {
    FEISHU_APP_ID: 'test_app_id',
    FEISHU_APP_SECRET: 'test_app_secret',
    getWorkspaceDir: () => '/test/workspace',
  },
}));

function createMockClient(): { client: LarkDocxClient; mocks: { uploadAll: ReturnType<typeof vi.fn>; createBlock: ReturnType<typeof vi.fn> } } {
  const uploadAll = vi.fn();
  const createBlock = vi.fn();

  const client: LarkDocxClient = {
    drive: {
      media: {
        uploadAll,
      },
    },
    docx: {
      documentBlockChildren: {
        create: createBlock,
      },
    },
  };

  return { client, mocks: { uploadAll, createBlock } };
}

describe('insert_docx_image', () => {
  let tempDir: string;
  let tempImageFile: string;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create a temp directory and test image file
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'insert-docx-image-test-'));
    tempImageFile = path.join(tempDir, 'test-chart.png');

    // Create a fake PNG file (1x1 pixel PNG)
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    await fs.writeFile(tempImageFile, pngBuffer);

    // Set up mock client via dependency injection
    mockClient = createMockClient();
    _setLarkClientFactory(() => mockClient.client);
  });

  afterEach(async () => {
    _resetLarkClientFactory();

    // Clean up temp files
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ─── Parameter Validation ─────────────────────────────────────────────────

  it('should validate required parameters', async () => {
    const result1 = await insert_docx_image({ documentId: '', imagePath: '/test.png' });
    expect(result1.success).toBe(false);
    expect(result1.error).toContain('documentId is required');

    const result2 = await insert_docx_image({ documentId: 'doc123', imagePath: '' });
    expect(result2.success).toBe(false);
    expect(result2.error).toContain('imagePath is required');
  });

  it('should validate documentId format', async () => {
    const result = await insert_docx_image({ documentId: 'invalid/id!', imagePath: tempImageFile });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid documentId');
  });

  it('should validate index parameter', async () => {
    const result = await insert_docx_image({ documentId: 'doc123', imagePath: tempImageFile, index: 1.5 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid index');
  });

  // ─── Credential Checks ────────────────────────────────────────────────────

  it('should return error when credentials are not configured', async () => {
    // Dynamically import Config to modify it
    const { Config } = await import('@disclaude/core');
    const mockedConfig = Config as unknown as {
      FEISHU_APP_ID: string;
      FEISHU_APP_SECRET: string;
    };
    mockedConfig.FEISHU_APP_ID = '';
    mockedConfig.FEISHU_APP_SECRET = '';

    const result = await insert_docx_image({ documentId: 'doc123', imagePath: tempImageFile });
    expect(result.success).toBe(false);
    expect(result.message).toContain('credentials not configured');

    // Restore
    mockedConfig.FEISHU_APP_ID = 'test_app_id';
    mockedConfig.FEISHU_APP_SECRET = 'test_app_secret';
  });

  // ─── File Handling ────────────────────────────────────────────────────────

  it('should return error when image file does not exist', async () => {
    const result = await insert_docx_image({ documentId: 'doc123', imagePath: '/nonexistent/image.png' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('no such file');
  });

  // ─── Successful Insertion ─────────────────────────────────────────────────

  it('should successfully insert image at a specific index', async () => {
    // Mock successful upload
    mockClient.mocks.uploadAll.mockResolvedValue({ file_token: 'file_token_123' });

    // Mock successful block creation
    mockClient.mocks.createBlock.mockResolvedValue({
      code: 0,
      data: {
        children: [{ block_id: 'block_abc123' }],
      },
    });

    const result = await insert_docx_image({
      documentId: 'doc123',
      imagePath: tempImageFile,
      index: 3,
      caption: 'Figure 1: Test chart',
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('at index 3');
    expect(result.blockId).toBe('block_abc123');
    expect(result.fileToken).toBe('file_token_123');
    expect(result.fileName).toBe('test-chart.png');

    // Verify upload was called with correct params
    expect(mockClient.mocks.uploadAll).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          file_name: 'test-chart.png',
          parent_type: 'docx_image',
          parent_node: 'doc123',
        }),
      })
    );

    // Verify block creation was called with correct params
    expect(mockClient.mocks.createBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          index: 3,
        }),
        path: { document_id: 'doc123', block_id: 'doc123' },
      })
    );
  });

  it('should append image to end when index is omitted', async () => {
    mockClient.mocks.uploadAll.mockResolvedValue({ file_token: 'file_token_456' });
    mockClient.mocks.createBlock.mockResolvedValue({
      code: 0,
      data: { children: [{ block_id: 'block_def456' }] },
    });

    const result = await insert_docx_image({
      documentId: 'doc456',
      imagePath: tempImageFile,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('at end of document');

    // Verify index was not set in the create call
    const createCall = mockClient.mocks.createBlock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createCall.data.index).toBeUndefined();
  });

  it('should append image to end when index is -1', async () => {
    mockClient.mocks.uploadAll.mockResolvedValue({ file_token: 'file_token_789' });
    mockClient.mocks.createBlock.mockResolvedValue({
      code: 0,
      data: { children: [{ block_id: 'block_ghi789' }] },
    });

    const result = await insert_docx_image({
      documentId: 'doc789',
      imagePath: tempImageFile,
      index: -1,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('at end of document');

    // Verify index was not set in the create call (index -1 means append)
    const createCall = mockClient.mocks.createBlock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createCall.data.index).toBeUndefined();
  });

  it('should include caption in the image block when provided', async () => {
    mockClient.mocks.uploadAll.mockResolvedValue({ file_token: 'file_token_cap' });
    mockClient.mocks.createBlock.mockResolvedValue({
      code: 0,
      data: { children: [{ block_id: 'block_cap' }] },
    });

    await insert_docx_image({
      documentId: 'docCap',
      imagePath: tempImageFile,
      caption: 'Figure 2: Growth chart',
    });

    const createCall = mockClient.mocks.createBlock.mock.calls[0][0] as {
      data: {
        children: Array<{ image: { caption?: { content: string } } }>;
      };
    };
    expect(createCall.data.children[0].image.caption).toEqual({ content: 'Figure 2: Growth chart' });
  });

  // ─── Error Handling ───────────────────────────────────────────────────────

  it('should handle upload failure gracefully', async () => {
    mockClient.mocks.uploadAll.mockResolvedValue(null);

    const result = await insert_docx_image({
      documentId: 'doc123',
      imagePath: tempImageFile,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('no file_token');
  });

  it('should handle Feishu API error in block creation', async () => {
    mockClient.mocks.uploadAll.mockResolvedValue({ file_token: 'file_token_err' });
    mockClient.mocks.createBlock.mockResolvedValue({
      code: 99991400,
      msg: 'invalid param',
    });

    const result = await insert_docx_image({
      documentId: 'doc123',
      imagePath: tempImageFile,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Feishu API error');
    expect(result.error).toContain('99991400');
  });

  it('should handle network/upload errors gracefully', async () => {
    mockClient.mocks.uploadAll.mockRejectedValue(new Error('Network timeout'));

    const result = await insert_docx_image({
      documentId: 'doc123',
      imagePath: tempImageFile,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Network timeout');
  });

  // ─── Path Resolution ──────────────────────────────────────────────────────

  it('should resolve relative path against workspace directory', async () => {
    mockClient.mocks.uploadAll.mockResolvedValue({ file_token: 'file_token_rel' });
    mockClient.mocks.createBlock.mockResolvedValue({
      code: 0,
      data: { children: [{ block_id: 'block_rel' }] },
    });

    // Use a relative path with the temp file
    const relativePath = path.relative('/test/workspace', tempImageFile);

    // Only test if the relative path is actually relative
    if (!path.isAbsolute(relativePath)) {
      const result = await insert_docx_image({
        documentId: 'docRel',
        imagePath: relativePath,
      });

      expect(result.success).toBe(true);
    }
  });
});
