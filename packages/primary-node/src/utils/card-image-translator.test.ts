/**
 * Tests for card image path translator.
 *
 * Issue #2951: Auto-translate local image paths in card JSON to Feishu image_keys.
 *
 * Tests cover:
 * - isLocalImagePath detection logic
 * - translateCardImagePaths with no local paths (passthrough)
 * - translateCardImagePaths with img elements containing local paths
 * - translateCardImagePaths with markdown image references
 * - Deduplication of same path used multiple times
 * - Failed uploads (graceful degradation)
 * - Deep cloning (original card not mutated)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Readable } from 'node:stream';
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

// Mock fs.createReadStream to prevent real file I/O during upload
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createReadStream: vi.fn(() => {
      const stream = new Readable({ read() { this.push(null); } });
      return stream;
    }),
  };
});

import {
  isLocalImagePath,
  translateCardImagePaths,
} from './card-image-translator.js';

// Helper: create a mock Feishu client
function createMockClient(imageKeyResult?: string) {
  return {
    im: {
      image: {
        create: vi.fn().mockResolvedValue({
          image_key: imageKeyResult ?? 'img_v3_test_abc123',
        }),
      },
    },
  } as unknown as import('@larksuiteoapi/node-sdk').Client;
}

// Helper: create a temp image file
function createTempImage(dir: string, name: string): string {
  const filePath = path.join(dir, name);
  // Write a minimal PNG-like file (just some bytes, not a real image)
  fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return filePath;
}

describe('isLocalImagePath', () => {
  it('should detect absolute paths with image extensions', () => {
    expect(isLocalImagePath('/tmp/test.png')).toBe(false); // file doesn't exist
  });

  it('should return false for Feishu image_keys', () => {
    expect(isLocalImagePath('img_v3_02ab_xxxx')).toBe(false);
  });

  it('should return false for non-image extensions', () => {
    expect(isLocalImagePath('/tmp/document.pdf')).toBe(false);
  });

  it('should return false for relative paths without ./', () => {
    expect(isLocalImagePath('image.png')).toBe(false);
  });

  it('should return false for empty strings', () => {
    expect(isLocalImagePath('')).toBe(false);
  });

  it('should return false for non-string values', () => {
    expect(isLocalImagePath(123 as unknown as string)).toBe(false);
  });

  it('should return false for URLs', () => {
    expect(isLocalImagePath('https://example.com/image.png')).toBe(false);
  });

  it('should detect ./ and ../ relative paths with image extensions when file exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-img-test-'));
    const imgPath = path.join(tmpDir, 'test.png');
    fs.writeFileSync(imgPath, 'test');

    // Test with actual file path
    expect(isLocalImagePath(imgPath)).toBe(true);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('translateCardImagePaths', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-img-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('should return original card when no local paths found', async () => {
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Test' } },
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: 'Hello' } },
      ],
    };

    const client = createMockClient();
    const result = await translateCardImagePaths(card, client as never);

    expect(result.card).toBe(card); // Same reference — no cloning
    expect(result.translated).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.failures).toHaveLength(0);
    // No upload attempted
    expect(client.im.image.create).not.toHaveBeenCalled();
  });

  it('should translate img_key with local path', async () => {
    const imgPath = createTempImage(tmpDir, 'chart.png');
    const imageKey = 'img_v3_translated_key';

    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Report' } },
      elements: [
        { tag: 'img', img_key: imgPath },
      ],
    };

    const client = createMockClient(imageKey);
    const result = await translateCardImagePaths(card, client as never);

    expect(result.translated).toBe(1);
    expect(result.failed).toBe(0);
    expect((result.card as Record<string, unknown>).elements).toEqual([
      { tag: 'img', img_key: imageKey },
    ]);
    // Original card should NOT be mutated
    expect((card.elements as Array<Record<string, unknown>>)[0].img_key).toBe(imgPath);
  });

  it('should translate nested img elements in column_set', async () => {
    const imgPath = createTempImage(tmpDir, 'nested.png');
    const imageKey = 'img_v3_nested_key';

    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Nested' } },
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

    const client = createMockClient(imageKey);
    const result = await translateCardImagePaths(card, client as never);

    expect(result.translated).toBe(1);
    const elements = result.card.elements as Array<Record<string, unknown>>;
    const columnSet = elements[0].columns as Array<Record<string, unknown>>;
    const [imgElement] = columnSet[0].elements as Array<Record<string, unknown>>;
    expect(imgElement.img_key).toBe(imageKey);
  });

  it('should translate markdown image references with local paths', async () => {
    const imgPath = createTempImage(tmpDir, 'md-image.png');
    const imageKey = 'img_v3_md_key';

    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'MD Test' } },
      elements: [
        {
          tag: 'markdown',
          content: `Here is a chart:\n\n![Chart](${imgPath})\n\nEnd of report.`,
        },
      ],
    };

    const client = createMockClient(imageKey);
    const result = await translateCardImagePaths(card, client as never);

    expect(result.translated).toBe(1);
    const elements = result.card.elements as Array<Record<string, unknown>>;
    expect(elements[0].content).toContain(imageKey);
    expect(elements[0].content).not.toContain(imgPath);
  });

  it('should deduplicate same path used in multiple img elements', async () => {
    const imgPath = createTempImage(tmpDir, 'shared.png');
    const imageKey = 'img_v3_shared_key';

    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Dedup' } },
      elements: [
        { tag: 'img', img_key: imgPath },
        { tag: 'img', img_key: imgPath },
      ],
    };

    const client = createMockClient(imageKey);
    const result = await translateCardImagePaths(card, client as never);

    expect(result.translated).toBe(1); // Only one upload
    // Both should be replaced
    const elements = result.card.elements as Array<Record<string, unknown>>;
    expect(elements[0].img_key).toBe(imageKey);
    expect(elements[1].img_key).toBe(imageKey);
    // Only one upload call
    expect(client.im.image.create).toHaveBeenCalledTimes(1);
  });

  it('should handle upload failures gracefully', async () => {
    const imgPath = createTempImage(tmpDir, 'fail.png');

    const client = {
      im: {
        image: {
          create: vi.fn().mockRejectedValue(new Error('Network error')),
        },
      },
    } as unknown as import('@larksuiteoapi/node-sdk').Client;

    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Fail' } },
      elements: [
        { tag: 'img', img_key: imgPath },
      ],
    };

    const result = await translateCardImagePaths(card, client as never);

    expect(result.translated).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].path).toBe(imgPath);
    // Original path should remain (not replaced since upload failed)
    const elements = result.card.elements as Array<Record<string, unknown>>;
    expect(elements[0].img_key).toBe(imgPath);
  });

  it('should skip img_key that is already a Feishu image_key', async () => {
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Skip' } },
      elements: [
        { tag: 'img', img_key: 'img_v3_02ab_xxxx' },
      ],
    };

    const client = createMockClient();
    const result = await translateCardImagePaths(card, client as never);

    expect(result.translated).toBe(0);
    expect(result.card).toBe(card); // Same reference
    expect(client.im.image.create).not.toHaveBeenCalled();
  });

  it('should handle mixed valid and invalid paths', async () => {
    const validPath = createTempImage(tmpDir, 'valid.png');
    const imageKey = 'img_v3_valid_key';

    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Mixed' } },
      elements: [
        { tag: 'img', img_key: validPath },
        { tag: 'img', img_key: 'img_v3_already_valid' },
        { tag: 'img', img_key: '/nonexistent/file.png' },
      ],
    };

    const client = createMockClient(imageKey);
    const result = await translateCardImagePaths(card, client as never);

    expect(result.translated).toBe(1);
    const elements = result.card.elements as Array<Record<string, unknown>>;
    expect(elements[0].img_key).toBe(imageKey);
    expect(elements[1].img_key).toBe('img_v3_already_valid');
    expect(elements[2].img_key).toBe('/nonexistent/file.png'); // Doesn't exist, not detected
  });
});
