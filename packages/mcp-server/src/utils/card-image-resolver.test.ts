/**
 * Tests for card image resolver utilities (packages/mcp-server/src/utils/card-image-resolver.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isLocalImagePath, resolveCardImages } from './card-image-resolver.js';

// Mock @disclaude/core
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getIpcClient: vi.fn(),
}));

import { getIpcClient } from '@disclaude/core';

// Helper to access elements from the result card with proper typing
function getElements(result: { card: Record<string, unknown> }): any[] {
  return result.card.elements as any[];
}

// Temp directory for test image files
const TEST_TMPDIR = join(tmpdir(), 'card-image-resolver-test');

beforeEach(() => {
  if (!existsSync(TEST_TMPDIR)) {
    mkdirSync(TEST_TMPDIR, { recursive: true });
  }
});

afterEach(() => {
  // Clean up temp files
  try {
    rmSync(TEST_TMPDIR, { recursive: true, force: true });
  } catch { /* ignore */ }
});

/** Create a minimal fake image file for testing */
function createTestImage(name: string): string {
  const filePath = join(TEST_TMPDIR, name);
  // Write a minimal PNG-like header
  writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  return filePath;
}

// ============================================================================
// isLocalImagePath
// ============================================================================

describe('isLocalImagePath', () => {
  describe('positive cases (should return true)', () => {
    it('should detect absolute paths with image extension', () => {
      expect(isLocalImagePath('/tmp/chart.png')).toBe(true);
      expect(isLocalImagePath('/home/user/image.jpg')).toBe(true);
      expect(isLocalImagePath('/var/data/photo.jpeg')).toBe(true);
      expect(isLocalImagePath('/tmp/report.webp')).toBe(true);
      expect(isLocalImagePath('/tmp/anim.gif')).toBe(true);
    });

    it('should detect relative paths with ./', () => {
      expect(isLocalImagePath('./chart.png')).toBe(true);
      expect(isLocalImagePath('./images/photo.jpg')).toBe(true);
    });

    it('should detect relative paths with ../', () => {
      expect(isLocalImagePath('../chart.png')).toBe(true);
      expect(isLocalImagePath('../../images/photo.jpg')).toBe(true);
    });

    it('should detect bare filenames with image extension', () => {
      expect(isLocalImagePath('chart.png')).toBe(true);
      expect(isLocalImagePath('photo.jpg')).toBe(true);
      expect(isLocalImagePath('image.jpeg')).toBe(true);
    });
  });

  describe('negative cases (should return false)', () => {
    it('should reject HTTP URLs', () => {
      expect(isLocalImagePath('https://example.com/image.png')).toBe(false);
      expect(isLocalImagePath('http://example.com/image.jpg')).toBe(false);
    });

    it('should reject Feishu image_keys', () => {
      expect(isLocalImagePath('img_v3_xxx')).toBe(false);
      expect(isLocalImagePath('img_v2_abc123')).toBe(false);
    });

    it('should reject data URIs', () => {
      expect(isLocalImagePath('data:image/png;base64,abc123')).toBe(false);
    });

    it('should reject non-image extensions', () => {
      expect(isLocalImagePath('/tmp/file.txt')).toBe(false);
      expect(isLocalImagePath('/tmp/file.pdf')).toBe(false);
      expect(isLocalImagePath('/tmp/file.csv')).toBe(false);
    });

    it('should reject empty/invalid values', () => {
      expect(isLocalImagePath('')).toBe(false);
      expect(isLocalImagePath(null as any)).toBe(false);
      expect(isLocalImagePath(undefined as any)).toBe(false);
    });

    it('should reject paths without extensions', () => {
      expect(isLocalImagePath('/tmp/noextension')).toBe(false);
    });
  });
});

// ============================================================================
// resolveCardImages
// ============================================================================

describe('resolveCardImages', () => {
  let mockIpcClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIpcClient = {
      uploadImage: vi.fn(),
    };
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient);
  });

  it('should return card unchanged when no local image paths are present', async () => {
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Test' } },
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: 'Hello' } },
      ],
    };

    const result = await resolveCardImages(card);
    expect(result.uploadedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.card).toEqual(card);
    expect(mockIpcClient.uploadImage).not.toHaveBeenCalled();
  });

  it('should handle card with Feishu image_key (no upload needed)', async () => {
    const card = {
      elements: [
        { tag: 'img', img_key: 'img_v3_existing_key' },
      ],
    };

    const result = await resolveCardImages(card);
    expect(result.uploadedCount).toBe(0);
    expect(getElements(result)[0].img_key).toBe('img_v3_existing_key');
    expect(mockIpcClient.uploadImage).not.toHaveBeenCalled();
  });

  it('should upload and replace local image path in img element', async () => {
    const imgPath = createTestImage('chart.png');
    mockIpcClient.uploadImage.mockResolvedValue({
      success: true,
      imageKey: 'img_v3_uploaded123',
    });

    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Report' } },
      elements: [
        { tag: 'img', img_key: imgPath },
      ],
    };

    const result = await resolveCardImages(card);
    expect(result.uploadedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(getElements(result)[0].img_key).toBe('img_v3_uploaded123');
    expect(mockIpcClient.uploadImage).toHaveBeenCalledTimes(1);
  });

  it('should handle upload failure gracefully', async () => {
    const imgPath = createTestImage('missing.png');
    mockIpcClient.uploadImage.mockResolvedValue({
      success: false,
      error: 'Upload failed',
    });

    const card = {
      elements: [
        { tag: 'img', img_key: imgPath },
      ],
    };

    const result = await resolveCardImages(card);
    expect(result.uploadedCount).toBe(0);
    expect(result.failedCount).toBe(1);
    // Graceful degradation: img element replaced with text element
    expect(getElements(result)[0].tag).toBe('div');
    expect(getElements(result)[0].text.content).toBe('🖼️ [图片上传失败]');
    expect(getElements(result)[0].img_key).toBeUndefined();
  });

  it('should upload and replace markdown image references', async () => {
    const imgPath = createTestImage('chart.png');
    mockIpcClient.uploadImage.mockResolvedValue({
      success: true,
      imageKey: 'img_v3_md_upload',
    });

    const card = {
      elements: [
        { tag: 'markdown', content: `Here is the chart: ![Chart](${imgPath})` },
      ],
    };

    const result = await resolveCardImages(card);
    expect(result.uploadedCount).toBe(1);
    expect(getElements(result)[0].content).toBe('Here is the chart: ![Chart](img_v3_md_upload)');
  });

  it('should handle markdown image upload failure gracefully', async () => {
    const imgPath = createTestImage('chart.png');
    mockIpcClient.uploadImage.mockResolvedValue({
      success: false,
      error: 'File not found',
    });

    const card = {
      elements: [
        { tag: 'markdown', content: `Chart: ![Chart](${imgPath})` },
      ],
    };

    const result = await resolveCardImages(card);
    expect(result.failedCount).toBe(1);
    expect(getElements(result)[0].content).toBe('Chart: [Chart: image upload failed]');
  });

  it('should handle multiple images in a single card', async () => {
    const img1 = createTestImage('chart1.png');
    const img2 = createTestImage('chart2.png');
    // Use mockImplementation to return deterministic results based on input path,
    // since Promise.all resolves uploads in non-deterministic order
    mockIpcClient.uploadImage.mockImplementation((filePath: string) => {
      if (filePath.includes('chart1')) {
        return Promise.resolve({ success: true, imageKey: 'img_v3_first' });
      }
      return Promise.resolve({ success: true, imageKey: 'img_v3_second' });
    });

    const card = {
      elements: [
        { tag: 'img', img_key: img1 },
        { tag: 'img', img_key: img2 },
      ],
    };

    const result = await resolveCardImages(card);
    expect(result.uploadedCount).toBe(2);
    expect(getElements(result)[0].img_key).toBe('img_v3_first');
    expect(getElements(result)[1].img_key).toBe('img_v3_second');
  });

  it('should not mutate the original card object', async () => {
    const imgPath = createTestImage('chart.png');
    mockIpcClient.uploadImage.mockResolvedValue({
      success: true,
      imageKey: 'img_v3_new',
    });

    const originalCard = {
      elements: [
        { tag: 'img', img_key: imgPath },
      ],
    };

    const originalImgKey = (originalCard.elements as any[])[0].img_key;
    await resolveCardImages(originalCard);

    // Original should be unchanged
    expect((originalCard.elements as any[])[0].img_key).toBe(originalImgKey);
  });

  it('should handle nested card structures', async () => {
    const imgPath = createTestImage('nested.png');
    mockIpcClient.uploadImage.mockResolvedValue({
      success: true,
      imageKey: 'img_v3_nested',
    });

    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Report' } },
      elements: [
        {
          tag: 'column_set',
          columns: [
            {
              elements: [
                { tag: 'img', img_key: imgPath },
              ],
            },
          ],
        },
      ],
    };

    const result = await resolveCardImages(card);
    expect(result.uploadedCount).toBe(1);
    const [firstElement] = getElements(result);
    const { columns } = firstElement as any;
    const [column] = columns;
    const { elements: colElements } = column;
    const [nestedImg] = colElements;
    expect(nestedImg.img_key).toBe('img_v3_nested');
  });

  it('should handle IPC upload error gracefully', async () => {
    const imgPath = createTestImage('chart.png');
    mockIpcClient.uploadImage.mockRejectedValue(new Error('IPC connection lost'));

    const card = {
      elements: [
        { tag: 'img', img_key: imgPath },
      ],
    };

    const result = await resolveCardImages(card);
    expect(result.uploadedCount).toBe(0);
    expect(result.failedCount).toBe(1);
    // Should not throw, graceful degradation: img replaced with text
    expect(getElements(result)[0].tag).toBe('div');
    expect(getElements(result)[0].img_key).toBeUndefined();
  });

  it('should preserve non-image content in the card', async () => {
    const img1 = createTestImage('chart.png');
    const img2 = createTestImage('img.png');
    mockIpcClient.uploadImage.mockResolvedValue({
      success: true,
      imageKey: 'img_v3_uploaded',
    });

    const card = {
      config: { wide_screen_mode: true },
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: 'Keep this text' } },
        { tag: 'img', img_key: img1 },
        { tag: 'markdown', content: `Some text and ![img](${img2})` },
      ],
    };

    const result = await resolveCardImages(card);
    expect(result.uploadedCount).toBe(2);
    expect(getElements(result)[0].text.content).toBe('Keep this text');
    expect(getElements(result)[1].img_key).toBe('img_v3_uploaded');
    expect(getElements(result)[2].content).toContain('img_v3_uploaded');
  });

  it('should skip non-existent files without error', async () => {
    const card = {
      elements: [
        { tag: 'img', img_key: '/tmp/nonexistent_test_image_12345.png' },
      ],
    };

    const result = await resolveCardImages(card);
    expect(result.uploadedCount).toBe(0);
    expect(result.failedCount).toBe(1);
    // File doesn't exist, upload is not called, gracefully degraded
    expect(mockIpcClient.uploadImage).not.toHaveBeenCalled();
  });
});
