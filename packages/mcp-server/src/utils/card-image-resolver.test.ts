/**
 * Tests for card image path resolver (packages/mcp-server/src/utils/card-image-resolver.ts)
 *
 * Issue #2951: send_card auto-uploads local image paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isLocalImagePath,
  findLocalImagePaths,
  resolveCardImagePaths,
} from './card-image-resolver.js';

// ============================================================================
// isLocalImagePath
// ============================================================================

describe('isLocalImagePath', () => {
  it('should detect absolute paths with image extension', () => {
    expect(isLocalImagePath('/tmp/chart.png')).toBe(true);
    expect(isLocalImagePath('/home/user/image.jpg')).toBe(true);
    expect(isLocalImagePath('/var/data/report.jpeg')).toBe(true);
    expect(isLocalImagePath('/tmp/image.webp')).toBe(true);
    expect(isLocalImagePath('/tmp/image.gif')).toBe(true);
  });

  it('should detect relative paths with image extension', () => {
    expect(isLocalImagePath('./chart.png')).toBe(true);
    expect(isLocalImagePath('../images/chart.png')).toBe(true);
  });

  it('should detect bare filenames with image extension', () => {
    expect(isLocalImagePath('chart.png')).toBe(true);
    expect(isLocalImagePath('image.jpg')).toBe(true);
  });

  it('should skip Feishu image_keys', () => {
    expect(isLocalImagePath('img_v3_0ca5_b123')).toBe(false);
    expect(isLocalImagePath('img_v4_abc_def')).toBe(false);
  });

  it('should skip URLs', () => {
    expect(isLocalImagePath('https://example.com/image.png')).toBe(false);
    expect(isLocalImagePath('http://example.com/image.png')).toBe(false);
  });

  it('should skip data URIs', () => {
    expect(isLocalImagePath('data:image/png;base64,abc123')).toBe(false);
  });

  it('should skip non-image extensions', () => {
    expect(isLocalImagePath('/tmp/document.pdf')).toBe(false);
    expect(isLocalImagePath('/tmp/data.csv')).toBe(false);
    expect(isLocalImagePath('/tmp/file.txt')).toBe(false);
  });

  it('should skip empty or invalid values', () => {
    expect(isLocalImagePath('')).toBe(false);
    expect(isLocalImagePath('   ')).toBe(false);
  });

  it('should be case-insensitive for extensions', () => {
    expect(isLocalImagePath('/tmp/chart.PNG')).toBe(true);
    expect(isLocalImagePath('/tmp/chart.Jpg')).toBe(true);
  });
});

// ============================================================================
// findLocalImagePaths
// ============================================================================

describe('findLocalImagePaths', () => {
  it('should find img_key in top-level img element', () => {
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Test' } },
      elements: [
        { tag: 'img', img_key: '/tmp/chart.png', alt: { tag: 'plain_text', content: 'Chart' } },
      ],
    };

    const refs = findLocalImagePaths(card);
    expect(refs).toHaveLength(1);
    expect(refs[0].filePath).toBe('/tmp/chart.png');
    expect(refs[0].key).toBe('img_key');
  });

  it('should find local paths in nested structures like column_set', () => {
    const card = {
      elements: [
        {
          tag: 'column_set',
          columns: [
            {
              tag: 'column',
              elements: [
                { tag: 'img', img_key: '/tmp/image1.png' },
              ],
            },
            {
              tag: 'column',
              elements: [
                { tag: 'img', img_key: '/tmp/image2.jpg' },
              ],
            },
          ],
        },
      ],
    };

    const refs = findLocalImagePaths(card);
    expect(refs).toHaveLength(2);
    expect(refs[0].filePath).toBe('/tmp/image1.png');
    expect(refs[1].filePath).toBe('/tmp/image2.jpg');
  });

  it('should skip Feishu image_keys (img_v prefix)', () => {
    const card = {
      elements: [
        { tag: 'img', img_key: 'img_v3_0ca5_b123', alt: { tag: 'plain_text', content: 'Chart' } },
      ],
    };

    const refs = findLocalImagePaths(card);
    expect(refs).toHaveLength(0);
  });

  it('should skip URLs in img_key', () => {
    const card = {
      elements: [
        { tag: 'img', img_key: 'https://example.com/image.png' },
      ],
    };

    const refs = findLocalImagePaths(card);
    expect(refs).toHaveLength(0);
  });

  it('should handle card with no images', () => {
    const card = {
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: 'Hello' } },
      ],
    };

    const refs = findLocalImagePaths(card);
    expect(refs).toHaveLength(0);
  });

  it('should handle empty card', () => {
    expect(findLocalImagePaths({})).toHaveLength(0);
  });

  it('should allow in-place mutation via container reference', () => {
    const card = {
      elements: [
        { tag: 'img', img_key: '/tmp/chart.png' },
      ],
    };

    const refs = findLocalImagePaths(card);
    expect(refs).toHaveLength(1);

    // Simulate upload: replace path with image_key
    refs[0].container[refs[0].key] = 'img_v3_uploaded_key';

    expect((card.elements as Array<Record<string, unknown>>)[0].img_key).toBe('img_v3_uploaded_key');
  });

  it('should find multiple images across different elements', () => {
    const card = {
      elements: [
        { tag: 'img', img_key: '/tmp/a.png' },
        { tag: 'div', text: { tag: 'plain_text', content: 'text' } },
        { tag: 'img', img_key: '/tmp/b.jpg' },
        { tag: 'img', img_key: 'img_v3_existing' },
      ],
    };

    const refs = findLocalImagePaths(card);
    expect(refs).toHaveLength(2);
    expect(refs[0].filePath).toBe('/tmp/a.png');
    expect(refs[1].filePath).toBe('/tmp/b.jpg');
  });
});

// ============================================================================
// resolveCardImagePaths
// ============================================================================

describe('resolveCardImagePaths', () => {
  // Mock the IPC client to avoid real file/IPC access
  vi.mock('@disclaude/core', () => ({
    createLogger: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    getIpcClient: () => ({
      uploadImage: vi.fn(),
    }),
  }));

  // We need to test with the mock
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return zero counts for card with no local paths', async () => {
    const card = {
      config: { wide_screen_mode: true },
      elements: [
        { tag: 'img', img_key: 'img_v3_existing_key' },
        { tag: 'div', text: { tag: 'plain_text', content: 'Hello' } },
      ],
    };

    const result = await resolveCardImagePaths(card);
    expect(result.pathsFound).toBe(0);
    expect(result.uploaded).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('should handle card with only non-image elements', async () => {
    const card = {
      config: {},
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: 'Hello' } },
      ],
    };

    const result = await resolveCardImagePaths(card);
    expect(result.pathsFound).toBe(0);
    expect(result.uploaded).toBe(0);
  });
});
