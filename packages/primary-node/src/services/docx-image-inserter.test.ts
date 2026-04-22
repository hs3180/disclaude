/**
 * Tests for DocxImageInserter service.
 *
 * Issue #2278: Tests the three-step API flow for inserting images
 * into Feishu documents at specified positions.
 *
 * @module services/docx-image-inserter.test
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DocxImageInserter } from './docx-image-inserter.js';

// Mock logger
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

/**
 * Create a mock Lark Client with configurable responses.
 */
function createMockClient(responses?: {
  createBlock?: { data: { children: Array<{ block_id: string }> } };
  uploadFile?: { file_token: string };
  batchUpdate?: unknown;
}) {
  const mockCreate = vi.fn().mockResolvedValue(
    responses?.createBlock ?? {
      data: { children: [{ block_id: 'blk_test_image_001' }] },
    }
  );
  const mockBatchUpdate = vi.fn().mockResolvedValue(responses?.batchUpdate ?? {});
  const mockUpload = vi.fn().mockResolvedValue(
    responses?.uploadFile ?? {
      file_token: 'file_token_test_001',
    }
  );

  return {
    docx: {
      documentBlockChildren: { create: mockCreate },
      documentBlock: { batchUpdate: mockBatchUpdate },
    },
    drive: {
      media: { uploadAll: mockUpload },
    },
    // Expose mocks for assertions
    _mocks: { create: mockCreate, batchUpdate: mockBatchUpdate, upload: mockUpload },
  };
}

/** Type for the mock client including _mocks. */
type MockClient = ReturnType<typeof createMockClient>;

/**
 * Create a temporary image file for testing.
 */
function createTempImageFile(): string {
  const tmpDir = os.tmpdir();
  const filePath = path.join(tmpDir, `test-image-${Date.now()}.png`);
  // Create a minimal PNG file (1x1 pixel, valid PNG header)
  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
    0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
    0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
    0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
    0x44, 0xAE, 0x42, 0x60, 0x82,
  ]);
  fs.writeFileSync(filePath, pngHeader);
  return filePath;
}

describe('DocxImageInserter', () => {
  let mockClient: MockClient;
  let inserter: DocxImageInserter;
  let tempImagePath: string;
  const tempFiles: string[] = [];

  beforeEach(() => {
    mockClient = createMockClient();
    // Cast through unknown to bypass strict typing for test purposes
    inserter = new DocxImageInserter(mockClient as unknown as import('@larksuiteoapi/node-sdk').Client);
    tempImagePath = createTempImageFile();
    tempFiles.push(tempImagePath);
  });

  afterAll(() => {
    // Clean up all temp files at once (streams may still hold handles during individual tests)
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  });

  // ─── Pre-flight validation ──────────────────────────────────────────

  describe('validation', () => {
    it('should fail if documentId is empty', async () => {
      const result = await inserter.insertImage('', tempImagePath, 0);
      expect(result.success).toBe(false);
      expect(result.error).toContain('documentId is required');
    });

    it('should fail if imagePath is empty', async () => {
      const result = await inserter.insertImage('doc_123', '', 0);
      expect(result.success).toBe(false);
      expect(result.error).toContain('imagePath is required');
    });

    it('should fail if index is negative', async () => {
      const result = await inserter.insertImage('doc_123', tempImagePath, -1);
      expect(result.success).toBe(false);
      expect(result.error).toContain('non-negative number');
    });

    it('should fail if file does not exist', async () => {
      const result = await inserter.insertImage('doc_123', '/nonexistent/path.png', 0);
      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
    });

    it('should fail if path is not a file', async () => {
      const result = await inserter.insertImage('doc_123', os.tmpdir(), 0);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not a file');
    });
  });

  // ─── Three-step API flow ────────────────────────────────────────────

  describe('successful insertion', () => {
    it('should create image block, upload file, and bind', async () => {
      const result = await inserter.insertImage('doc_123', tempImagePath, 3);

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('blk_test_image_001');

      // Verify step 1: create block
      const { create: mockCreate } = mockClient._mocks;
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { document_id: 'doc_123', block_id: 'doc_123' },
        })
      );
      const [[createCall]] = mockCreate.mock.calls;
      expect(createCall.data.index).toBe(3);

      // Verify step 2: upload file
      const { upload: mockUpload } = mockClient._mocks;
      expect(mockUpload).toHaveBeenCalled();
      const [[uploadCall]] = mockUpload.mock.calls;
      expect(uploadCall.data.parent_type).toBe('docx_image');
      expect(uploadCall.data.parent_node).toBe('doc_123');

      // Verify step 3: bind image via batchUpdate
      const { batchUpdate: mockBatchUpdate } = mockClient._mocks;
      expect(mockBatchUpdate).toHaveBeenCalled();
    });

    it('should pass correct index to block creation', async () => {
      await inserter.insertImage('doc_abc', tempImagePath, 7);

      const { create: mockCreate } = mockClient._mocks;
      const [[createCall]] = mockCreate.mock.calls;
      expect(createCall.data.index).toBe(7);
    });
  });

  // ─── Error handling ─────────────────────────────────────────────────

  describe('error handling', () => {
    it('should handle step 1 failure (create block)', async () => {
      mockClient._mocks.create.mockRejectedValue(
        new Error('API rate limit exceeded')
      );

      const result = await inserter.insertImage('doc_123', tempImagePath, 0);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to create image block');
      expect(result.error).toContain('API rate limit exceeded');

      // Upload should NOT be called
      expect(mockClient._mocks.upload).not.toHaveBeenCalled();
    });

    it('should handle step 2 failure (upload)', async () => {
      mockClient._mocks.upload.mockRejectedValue(
        new Error('File too large')
      );

      const result = await inserter.insertImage('doc_123', tempImagePath, 0);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to upload image file');
    });

    it('should handle step 3 failure (bind)', async () => {
      mockClient._mocks.batchUpdate.mockRejectedValue(
        new Error('Permission denied')
      );

      const result = await inserter.insertImage('doc_123', tempImagePath, 0);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to bind image to block');
    });

    it('should handle missing block_id in create response', async () => {
      mockClient._mocks.create.mockResolvedValue({
        data: { children: [{ /* no block_id */ }] },
      });

      const result = await inserter.insertImage('doc_123', tempImagePath, 0);

      expect(result.success).toBe(false);
      expect(result.error).toContain('block_id not found');
    });

    it('should handle empty children in create response', async () => {
      mockClient._mocks.create.mockResolvedValue({
        data: { children: [] },
      });

      const result = await inserter.insertImage('doc_123', tempImagePath, 0);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No children returned');
    });

    it('should handle missing file_token in upload response', async () => {
      mockClient._mocks.upload.mockResolvedValue({
        /* no file_token */
      });

      const result = await inserter.insertImage('doc_123', tempImagePath, 0);

      expect(result.success).toBe(false);
      expect(result.error).toContain('file_token not returned');
    });
  });
});
