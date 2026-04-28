/**
 * Tests for card image resolver utility.
 *
 * Issue #2951: Auto-translate local image paths in card JSON to Feishu image_keys.
 *
 * Tests cover:
 * - isLocalImagePath detection logic
 * - extractMarkdownImagePaths for markdown image syntax
 * - collectLocalImagePaths recursive card scanning
 * - replacePaths mutation of card JSON
 * - uploadImages with mocked Feishu client
 * - resolveCardImagePaths end-to-end with mocked uploads
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
    })),
  };
});

// Mock fs.createReadStream to avoid real file I/O in upload tests
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createReadStream: vi.fn(() => ({ pipe: vi.fn(), on: vi.fn() })),
  };
});

import {
  isLocalImagePath,
  extractMarkdownImagePaths,
  collectLocalImagePaths,
  replacePaths,
  uploadImages,
  resolveCardImagePaths,
} from './card-image-resolver.js';

// Helper: create a temp file that "exists" for path detection
function createTempImageFile(ext = '.png'): string {
  const tmpDir = os.tmpdir();
  const filePath = path.join(tmpDir, `test-card-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  fs.writeFileSync(filePath, Buffer.from('fake-image-data'));
  return filePath;
}

function cleanupTempFile(filePath: string) {
  try {
    // Use the real unlinkSync (actualFs is available via the mock passthrough)
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

describe('CardImageResolver', () => {
  let tempFiles: string[] = [];

  beforeEach(() => {
    tempFiles = [];
  });

  afterEach(() => {
    for (const f of tempFiles) {
      cleanupTempFile(f);
    }
  });

  function trackTempFile(filePath: string): string {
    tempFiles.push(filePath);
    return filePath;
  }

  // ─── isLocalImagePath ────────────────────────────────────────────

  describe('isLocalImagePath', () => {
    it('should return true for existing local image files with supported extensions', () => {
      const imgPath = trackTempFile(createTempImageFile('.png'));
      expect(isLocalImagePath(imgPath)).toBe(true);
    });

    it('should return true for .jpg extension', () => {
      const imgPath = trackTempFile(createTempImageFile('.jpg'));
      expect(isLocalImagePath(imgPath)).toBe(true);
    });

    it('should return false for non-existent paths', () => {
      expect(isLocalImagePath('/nonexistent/path/image.png')).toBe(false);
    });

    it('should return false for non-image extensions', () => {
      const txtPath = trackTempFile(path.join(os.tmpdir(), `test-${Date.now()}.txt`));
      fs.writeFileSync(txtPath, 'not-an-image');
      expect(isLocalImagePath(txtPath)).toBe(false);
    });

    it('should return false for Feishu image_key format', () => {
      expect(isLocalImagePath('img_v3_02ab_xxxx')).toBe(false);
    });

    it('should return false for HTTP URLs', () => {
      expect(isLocalImagePath('https://example.com/image.png')).toBe(false);
    });

    it('should return false for empty strings', () => {
      expect(isLocalImagePath('')).toBe(false);
    });

    it('should return false for relative paths without leading dot', () => {
      expect(isLocalImagePath('images/chart.png')).toBe(false);
    });
  });

  // ─── extractMarkdownImagePaths ────────────────────────────────────

  describe('extractMarkdownImagePaths', () => {
    it('should extract local image paths from markdown syntax', () => {
      const imgPath = trackTempFile(createTempImageFile('.png'));
      const content = `Here is a chart: ![chart](${imgPath})`;
      const paths = extractMarkdownImagePaths(content);
      expect(paths).toEqual([imgPath]);
    });

    it('should extract multiple image paths', () => {
      const img1 = trackTempFile(createTempImageFile('.png'));
      const img2 = trackTempFile(createTempImageFile('.jpg'));
      const content = `![a](${img1}) and ![b](${img2})`;
      const paths = extractMarkdownImagePaths(content);
      expect(paths).toHaveLength(2);
      expect(paths).toContain(img1);
      expect(paths).toContain(img2);
    });

    it('should ignore non-local paths like URLs', () => {
      const content = '![chart](https://example.com/chart.png)';
      const paths = extractMarkdownImagePaths(content);
      expect(paths).toHaveLength(0);
    });

    it('should ignore non-existent local paths', () => {
      const content = '![chart](/nonexistent/path/chart.png)';
      const paths = extractMarkdownImagePaths(content);
      expect(paths).toHaveLength(0);
    });

    it('should return empty array for content without images', () => {
      expect(extractMarkdownImagePaths('plain text')).toEqual([]);
    });
  });

  // ─── collectLocalImagePaths ───────────────────────────────────────

  describe('collectLocalImagePaths', () => {
    it('should find img_key in img elements', () => {
      const imgPath = trackTempFile(createTempImageFile('.png'));
      const card = {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: 'Test' } },
        elements: [
          { tag: 'img', img_key: imgPath },
        ],
      };
      const paths = collectLocalImagePaths(card);
      expect(paths).toEqual([imgPath]);
    });

    it('should find images in markdown content', () => {
      const imgPath = trackTempFile(createTempImageFile('.png'));
      const card = {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: 'Test' } },
        elements: [
          { tag: 'markdown', content: `![chart](${imgPath})` },
        ],
      };
      const paths = collectLocalImagePaths(card);
      expect(paths).toEqual([imgPath]);
    });

    it('should find images in nested structures', () => {
      const imgPath = trackTempFile(createTempImageFile('.png'));
      const card = {
        config: { wide_screen_mode: true },
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
      const paths = collectLocalImagePaths(card);
      expect(paths).toEqual([imgPath]);
    });

    it('should deduplicate identical paths', () => {
      const imgPath = trackTempFile(createTempImageFile('.png'));
      const card = {
        elements: [
          { tag: 'img', img_key: imgPath },
          { tag: 'markdown', content: `![chart](${imgPath})` },
        ],
      };
      const paths = collectLocalImagePaths(card);
      expect(paths).toEqual([imgPath]); // only once
    });

    it('should skip non-local img_key values', () => {
      const card = {
        elements: [
          { tag: 'img', img_key: 'img_v3_02ab_xxxx' },
        ],
      };
      const paths = collectLocalImagePaths(card);
      expect(paths).toEqual([]);
    });

    it('should skip URL img_key values', () => {
      const card = {
        elements: [
          { tag: 'img', img_key: 'https://example.com/image.png' },
        ],
      };
      const paths = collectLocalImagePaths(card);
      expect(paths).toEqual([]);
    });

    it('should return empty array for card with no images', () => {
      const card = {
        elements: [
          { tag: 'div', text: { tag: 'plain_text', content: 'Hello' } },
        ],
      };
      expect(collectLocalImagePaths(card)).toEqual([]);
    });
  });

  // ─── replacePaths ────────────────────────────────────────────────

  describe('replacePaths', () => {
    it('should replace img_key values', () => {
      const imgPath = '/tmp/chart.png';
      const card = {
        elements: [
          { tag: 'img', img_key: imgPath },
        ],
      };
      const mapping = new Map([[imgPath, 'img_v3_abc123']]);
      replacePaths(card, mapping);
      expect((card.elements[0] as Record<string, unknown>).img_key).toBe('img_v3_abc123');
    });

    it('should replace markdown image references', () => {
      const imgPath = '/tmp/chart.png';
      const card = {
        elements: [
          { tag: 'markdown', content: `![chart](${imgPath}) and some text` },
        ],
      };
      const mapping = new Map([[imgPath, 'img_v3_abc123']]);
      replacePaths(card, mapping);
      expect((card.elements[0] as Record<string, unknown>).content).toBe('![chart](img_v3_abc123) and some text');
    });

    it('should not modify paths not in the mapping', () => {
      const imgPath = '/tmp/chart.png';
      const card = {
        elements: [
          { tag: 'img', img_key: imgPath },
        ],
      };
      const mapping = new Map<string, string>(); // empty mapping
      replacePaths(card, mapping);
      expect((card.elements[0] as Record<string, unknown>).img_key).toBe(imgPath);
    });

    it('should handle multiple replacements in one card', () => {
      const img1 = '/tmp/a.png';
      const img2 = '/tmp/b.jpg';
      const card = {
        elements: [
          { tag: 'img', img_key: img1 },
          { tag: 'img', img_key: img2 },
        ],
      };
      const mapping = new Map([
        [img1, 'img_v3_key1'],
        [img2, 'img_v3_key2'],
      ]);
      replacePaths(card, mapping);
      expect((card.elements[0] as Record<string, unknown>).img_key).toBe('img_v3_key1');
      expect((card.elements[1] as Record<string, unknown>).img_key).toBe('img_v3_key2');
    });
  });

  // ─── uploadImages ────────────────────────────────────────────────

  describe('uploadImages', () => {
    it('should upload images and return path-to-key mapping', async () => {
      const imgPath = trackTempFile(createTempImageFile('.png'));

      const mockClient = {
        im: {
          image: {
            create: vi.fn().mockResolvedValue({ image_key: 'img_v3_test123' }),
          },
        },
      } as unknown as import('@larksuiteoapi/node-sdk').Client;

      const result = await uploadImages([imgPath], mockClient);
      expect(result.get(imgPath)).toBe('img_v3_test123');
      expect(mockClient.im.image.create).toHaveBeenCalledTimes(1);
    });

    it('should skip images that fail to upload', async () => {
      const imgPath = trackTempFile(createTempImageFile('.png'));

      const mockClient = {
        im: {
          image: {
            create: vi.fn().mockRejectedValue(new Error('Upload failed')),
          },
        },
      } as unknown as import('@larksuiteoapi/node-sdk').Client;

      const result = await uploadImages([imgPath], mockClient);
      expect(result.has(imgPath)).toBe(false);
    });

    it('should return empty map for empty input', async () => {
      const mockClient = {} as import('@larksuiteoapi/node-sdk').Client;
      const result = await uploadImages([], mockClient);
      expect(result.size).toBe(0);
    });
  });

  // ─── resolveCardImagePaths (integration) ─────────────────────────

  describe('resolveCardImagePaths', () => {
    it('should end-to-end resolve local paths in a card', async () => {
      const imgPath = trackTempFile(createTempImageFile('.png'));

      const card = {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: 'Report' } },
        elements: [
          { tag: 'img', img_key: imgPath },
          { tag: 'markdown', content: `![chart](${imgPath})` },
        ],
      };

      const mockClient = {
        im: {
          image: {
            create: vi.fn().mockResolvedValue({ image_key: 'img_v3_resolved' }),
          },
        },
      } as unknown as import('@larksuiteoapi/node-sdk').Client;

      const count = await resolveCardImagePaths(card, mockClient);

      // Both references share the same path, so only 1 upload
      expect(count).toBe(1);
      // img element should have image_key
      expect((card.elements[0] as Record<string, unknown>).img_key).toBe('img_v3_resolved');
      // markdown should have replaced path
      expect((card.elements[1] as Record<string, unknown>).content).toBe('![chart](img_v3_resolved)');
    });

    it('should return 0 for cards with no local images', async () => {
      const card = {
        elements: [
          { tag: 'img', img_key: 'img_v3_already_valid' },
          { tag: 'div', text: { tag: 'plain_text', content: 'Hello' } },
        ],
      };

      const mockClient = {
        im: { image: { create: vi.fn() } },
      } as unknown as import('@larksuiteoapi/node-sdk').Client;

      const count = await resolveCardImagePaths(card, mockClient);
      expect(count).toBe(0);
      expect(mockClient.im.image.create).not.toHaveBeenCalled();
    });

    it('should handle partial upload failures gracefully', async () => {
      const img1 = trackTempFile(createTempImageFile('.png'));
      const img2 = trackTempFile(createTempImageFile('.jpg'));

      const card = {
        elements: [
          { tag: 'img', img_key: img1 },
          { tag: 'img', img_key: img2 },
        ],
      };

      let callCount = 0;
      const mockClient = {
        im: {
          image: {
            create: vi.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 1) {
                return Promise.resolve({ image_key: 'img_v3_success' });
              }
              return Promise.reject(new Error('Upload failed'));
            }),
          },
        },
      } as unknown as import('@larksuiteoapi/node-sdk').Client;

      const count = await resolveCardImagePaths(card, mockClient);
      expect(count).toBe(1);
      // First image replaced
      expect((card.elements[0] as Record<string, unknown>).img_key).toBe('img_v3_success');
      // Second image left as-is (upload failed)
      expect((card.elements[1] as Record<string, unknown>).img_key).toBe(img2);
    });
  });
});
