/**
 * Tests for card-image-resolver — Issue #2951.
 *
 * Tests cover:
 * - isLocalImagePath: path detection logic
 * - findLocalImagePaths: recursive scanning of card JSON
 * - resolveCardImagePaths: end-to-end resolution with mock Feishu client
 * - Edge cases: missing files, upload failures, nested structures
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
  isLocalImagePath,
  findLocalImagePaths,
  resolveCardImagePaths,
} from './card-image-resolver.js';

// ─── Mock Logger ────────────────────────────────────────────────────────────

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
}));

vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

// ─── isLocalImagePath ───────────────────────────────────────────────────────

describe('isLocalImagePath', () => {
  it('should detect absolute paths with image extensions', () => {
    expect(isLocalImagePath('/tmp/chart.png')).toBe(true);
    expect(isLocalImagePath('/home/user/photo.jpg')).toBe(true);
    expect(isLocalImagePath('/var/data/image.jpeg')).toBe(true);
    expect(isLocalImagePath('/tmp/anim.gif')).toBe(true);
    expect(isLocalImagePath('/tmp/pic.webp')).toBe(true);
  });

  it('should detect relative paths with image extensions', () => {
    expect(isLocalImagePath('./chart.png')).toBe(true);
    expect(isLocalImagePath('./images/photo.jpg')).toBe(true);
  });

  it('should reject Feishu image_keys', () => {
    expect(isLocalImagePath('img_v3_02ab_xxxx')).toBe(false);
    expect(isLocalImagePath('img_v2_abc_def')).toBe(false);
  });

  it('should reject HTTP URLs', () => {
    expect(isLocalImagePath('http://example.com/image.png')).toBe(false);
    expect(isLocalImagePath('https://cdn.example.com/photo.jpg')).toBe(false);
  });

  it('should reject paths without image extensions', () => {
    expect(isLocalImagePath('/tmp/document.pdf')).toBe(false);
    expect(isLocalImagePath('/tmp/data.csv')).toBe(false);
    expect(isLocalImagePath('/tmp/script.sh')).toBe(false);
  });

  it('should reject bare filenames without path prefix', () => {
    expect(isLocalImagePath('chart.png')).toBe(false);
    expect(isLocalImagePath('image.jpg')).toBe(false);
  });

  it('should reject empty and non-string values', () => {
    expect(isLocalImagePath('')).toBe(false);
  });
});

// ─── findLocalImagePaths ────────────────────────────────────────────────────

describe('findLocalImagePaths', () => {
  it('should find img elements with local paths at top level', () => {
    const card = {
      config: { wide_screen_mode: true },
      elements: [
        { tag: 'img', img_key: '/tmp/chart.png' },
        { tag: 'div', text: 'Hello' },
      ],
    };

    const refs = findLocalImagePaths(card);
    expect(refs).toHaveLength(1);
    expect(refs[0].filePath).toBe('/tmp/chart.png');
    expect(refs[0].container).toBe(card.elements[0]);
    expect(refs[0].key).toBe('img_key');
  });

  it('should find img elements in nested structures', () => {
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Test' } },
      elements: [
        {
          tag: 'column_set',
          columns: [
            {
              tag: 'column',
              elements: [
                { tag: 'img', img_key: '/tmp/nested_image.png' },
              ],
            },
          ],
        },
      ],
    };

    const refs = findLocalImagePaths(card);
    expect(refs).toHaveLength(1);
    expect(refs[0].filePath).toBe('/tmp/nested_image.png');
  });

  it('should find multiple img elements across the card', () => {
    const card = {
      elements: [
        { tag: 'img', img_key: '/tmp/chart1.png' },
        { tag: 'div', text: 'separator' },
        { tag: 'img', img_key: '/tmp/chart2.jpg' },
        { tag: 'img', img_key: 'img_v3_02ab_xxxx' }, // Already a Feishu key
      ],
    };

    const refs = findLocalImagePaths(card);
    expect(refs).toHaveLength(2);
    expect(refs[0].filePath).toBe('/tmp/chart1.png');
    expect(refs[1].filePath).toBe('/tmp/chart2.jpg');
  });

  it('should return empty array for card with no img elements', () => {
    const card = {
      config: { wide_screen_mode: true },
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: 'No images' } },
      ],
    };

    const refs = findLocalImagePaths(card);
    expect(refs).toHaveLength(0);
  });

  it('should skip img elements with non-local paths', () => {
    const card = {
      elements: [
        { tag: 'img', img_key: 'img_v3_02ab_xxxx' },
        { tag: 'img', img_key: 'https://cdn.example.com/image.png' },
      ],
    };

    const refs = findLocalImagePaths(card);
    expect(refs).toHaveLength(0);
  });

  it('should handle card with no elements', () => {
    const card = { config: { wide_screen_mode: true } };
    const refs = findLocalImagePaths(card);
    expect(refs).toHaveLength(0);
  });
});

// ─── resolveCardImagePaths (integration) ────────────────────────────────────

describe('resolveCardImagePaths', () => {
  // Collect temp files for cleanup after all tests in this describe block.
  // Cannot delete immediately: fs.createReadStream opens asynchronously,
  // and the mock upload API resolves without consuming the stream,
  // causing ENOENT race conditions in ESM mode.
  const tempFiles: string[] = [];

  afterAll(() => {
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createTempImage(suffix: string): string {
    const filePath = path.join(os.tmpdir(), `test_card_img_${Date.now()}_${suffix}`);
    // Minimal valid PNG
    fs.writeFileSync(filePath, Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
      '0000000a49444154789c62000100000500010d0a2db40000000049454e44ae426082',
      'hex',
    ));
    tempFiles.push(filePath);
    return filePath;
  }

  function createMockClient(imageKey = 'img_v3_uploaded_001') {
    return {
      im: {
        image: {
          create: vi.fn().mockImplementation(async (opts: any) => {
            const stream = opts?.data?.image;
            if (stream && typeof stream.on === 'function') {
              for await (const _chunk of stream) { /* drain */ }
            }
            return { image_key: imageKey };
          }),
        },
      },
    } as any;
  }

  it('should replace local paths with Feishu image_keys', async () => {
    const imgPath = createTempImage('a.png');
    const client = createMockClient('img_v3_resolved_key');

    const card = {
      config: { wide_screen_mode: true },
      elements: [
        { tag: 'img', img_key: imgPath },
      ],
    };

    const resolved = await resolveCardImagePaths(card, client);

    expect(resolved).toBe(1);
    expect((card.elements[0] as any).img_key).toBe('img_v3_resolved_key');
  });

  it('should handle multiple images in one card', async () => {
    const imgPath1 = createTempImage('b.png');
    const imgPath2 = createTempImage('c.jpg');
    const client = createMockClient();

    const card = {
      elements: [
        { tag: 'img', img_key: imgPath1 },
        { tag: 'div', text: 'between' },
        { tag: 'img', img_key: imgPath2 },
      ],
    };

    const resolved = await resolveCardImagePaths(card, client);

    expect(resolved).toBe(2);
    expect(client.im.image.create).toHaveBeenCalledTimes(2);
  });

  it('should skip non-existent files', async () => {
    const client = createMockClient();

    const card = {
      elements: [
        { tag: 'img', img_key: '/tmp/nonexistent_chart_abc123.png' },
      ],
    };

    const resolved = await resolveCardImagePaths(card, client);

    expect(resolved).toBe(0);
    expect(client.im.image.create).not.toHaveBeenCalled();
    // Original path left unchanged
    expect((card.elements[0] as any).img_key).toBe('/tmp/nonexistent_chart_abc123.png');
  });

  it('should leave path unchanged when upload fails', async () => {
    const imgPath = createTempImage('d.png');
    const client = {
      im: {
        image: {
          create: vi.fn().mockImplementation(async (opts: any) => {
            // Drain the stream to avoid ENOENT race conditions on cleanup
            const stream = opts?.data?.image;
            if (stream && typeof stream.on === 'function') {
              for await (const _chunk of stream) { /* drain */ }
            }
            throw new Error('Network error');
          }),
        },
      },
    } as any;

    const card = {
      elements: [
        { tag: 'img', img_key: imgPath },
      ],
    };

    const resolved = await resolveCardImagePaths(card, client);

    expect(resolved).toBe(0);
    expect((card.elements[0] as any).img_key).toBe(imgPath);
  });

  it('should return 0 for card with no local image paths', async () => {
    const client = createMockClient();

    const card = {
      elements: [
        { tag: 'img', img_key: 'img_v3_already_exists' },
        { tag: 'div', text: 'Hello' },
      ],
    };

    const resolved = await resolveCardImagePaths(card, client);

    expect(resolved).toBe(0);
    expect(client.im.image.create).not.toHaveBeenCalled();
  });

  it('should handle nested img elements in column_set', async () => {
    const imgPath = createTempImage('e.png');
    const client = createMockClient('img_v3_nested_key');

    const card = {
      elements: [
        {
          tag: 'column_set',
          columns: [
            {
              tag: 'column',
              elements: [
                { tag: 'img', img_key: imgPath },
              ],
            },
          ],
        },
      ],
    };

    const resolved = await resolveCardImagePaths(card, client);

    expect(resolved).toBe(1);
    const columnElements = (card.elements[0] as any).columns[0].elements;
    expect(columnElements[0].img_key).toBe('img_v3_nested_key');
  });

  it('should handle empty card gracefully', async () => {
    const client = createMockClient();
    const card = {};

    const resolved = await resolveCardImagePaths(card, client);

    expect(resolved).toBe(0);
  });
});
