/**
 * Tests for card-image-resolver.
 *
 * Issue #2951: feat(channel): auto-translate local image paths to Feishu image_key
 *
 * @module primary-node/utils/card-image-resolver.test
 */

import { describe, it, expect } from 'vitest';
import {
  isLocalImagePath,
  findLocalImagePaths,
  replaceLocalImagePaths,
} from './card-image-resolver.js';

// ─── isLocalImagePath ──────────────────────────────────────────────────

describe('isLocalImagePath', () => {
  it('should detect absolute paths with image extensions', () => {
    expect(isLocalImagePath('/tmp/chart.png')).toBe(true);
    expect(isLocalImagePath('/home/user/photo.jpg')).toBe(true);
    expect(isLocalImagePath('/var/data/image.webp')).toBe(true);
    expect(isLocalImagePath('/tmp/report.gif')).toBe(true);
  });

  it('should detect relative paths with image extensions', () => {
    expect(isLocalImagePath('./chart.png')).toBe(true);
    expect(isLocalImagePath('../images/photo.jpg')).toBe(true);
  });

  it('should detect home-dir paths with image extensions', () => {
    expect(isLocalImagePath('~/Pictures/chart.png')).toBe(true);
  });

  it('should reject URLs', () => {
    expect(isLocalImagePath('https://example.com/image.png')).toBe(false);
    expect(isLocalImagePath('http://cdn.example.com/img.jpg')).toBe(false);
  });

  it('should reject data URIs', () => {
    expect(isLocalImagePath('data:image/png;base64,abc123')).toBe(false);
  });

  it('should reject Feishu image_keys', () => {
    expect(isLocalImagePath('img_v3_02ab_xxxx')).toBe(false);
    expect(isLocalImagePath('img_v2_1234_abcd')).toBe(false);
  });

  it('should reject paths without image extensions', () => {
    expect(isLocalImagePath('/tmp/document.pdf')).toBe(false);
    expect(isLocalImagePath('/tmp/data.json')).toBe(false);
  });

  it('should reject empty or non-string inputs', () => {
    expect(isLocalImagePath('')).toBe(false);
  });

  it('should reject plain filenames without path prefix', () => {
    expect(isLocalImagePath('chart.png')).toBe(false);
    expect(isLocalImagePath('image.jpg')).toBe(false);
  });
});

// ─── findLocalImagePaths ───────────────────────────────────────────────

describe('findLocalImagePaths', () => {
  it('should find img_key in img elements', () => {
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Test' } },
      elements: [
        { tag: 'img', img_key: '/tmp/chart.png', alt: { tag: 'plain_text', content: 'Chart' } },
      ],
    };

    const paths = findLocalImagePaths(card);
    expect(paths).toEqual(new Set(['/tmp/chart.png']));
  });

  it('should find multiple img_key paths', () => {
    const card = {
      elements: [
        { tag: 'img', img_key: '/tmp/chart1.png' },
        { tag: 'img', img_key: '/tmp/chart2.jpg' },
      ],
    };

    const paths = findLocalImagePaths(card);
    expect(paths).toEqual(new Set(['/tmp/chart1.png', '/tmp/chart2.jpg']));
  });

  it('should deduplicate identical paths', () => {
    const card = {
      elements: [
        { tag: 'img', img_key: '/tmp/chart.png' },
        { tag: 'img', img_key: '/tmp/chart.png' },
      ],
    };

    const paths = findLocalImagePaths(card);
    expect(paths).toEqual(new Set(['/tmp/chart.png']));
  });

  it('should find local paths in markdown image syntax', () => {
    const card = {
      elements: [
        { tag: 'markdown', content: 'Here is the chart:\n\n![Chart](/tmp/analysis.png)\n\nEnd.' },
      ],
    };

    const paths = findLocalImagePaths(card);
    expect(paths).toEqual(new Set(['/tmp/analysis.png']));
  });

  it('should find paths in both img_key and markdown', () => {
    const card = {
      elements: [
        { tag: 'img', img_key: '/tmp/chart1.png' },
        { tag: 'markdown', content: '![Chart 2](/tmp/chart2.jpg)' },
      ],
    };

    const paths = findLocalImagePaths(card);
    expect(paths).toEqual(new Set(['/tmp/chart1.png', '/tmp/chart2.jpg']));
  });

  it('should skip non-local paths (URLs, Feishu keys)', () => {
    const card = {
      elements: [
        { tag: 'img', img_key: 'img_v3_02ab_xxxx' },
        { tag: 'img', img_key: 'https://example.com/image.png' },
        { tag: 'markdown', content: '![Remote](https://cdn.example.com/img.jpg)' },
      ],
    };

    const paths = findLocalImagePaths(card);
    expect(paths.size).toBe(0);
  });

  it('should handle nested card structures', () => {
    const card = {
      elements: [
        {
          tag: 'column_set',
          columns: [
            {
              elements: [
                { tag: 'img', img_key: '/tmp/nested.png' },
              ],
            },
          ],
        },
      ],
    };

    const paths = findLocalImagePaths(card);
    expect(paths).toEqual(new Set(['/tmp/nested.png']));
  });

  it('should return empty set for cards without images', () => {
    const card = {
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: 'No images here' } },
        { tag: 'hr' },
      ],
    };

    const paths = findLocalImagePaths(card);
    expect(paths.size).toBe(0);
  });

  it('should handle null/undefined gracefully', () => {
    expect(findLocalImagePaths(null).size).toBe(0);
    expect(findLocalImagePaths(undefined).size).toBe(0);
    expect(findLocalImagePaths({}).size).toBe(0);
  });
});

// ─── replaceLocalImagePaths ────────────────────────────────────────────

describe('replaceLocalImagePaths', () => {
  it('should replace img_key paths', () => {
    const card = {
      elements: [
        { tag: 'img', img_key: '/tmp/chart.png', alt: { tag: 'plain_text', content: 'Chart' } },
      ],
    };
    const mapping = new Map([['/tmp/chart.png', 'img_v3_02ab_replaced']]);

    const result = replaceLocalImagePaths(card, mapping) as typeof card;

    expect(result.elements[0].img_key).toBe('img_v3_02ab_replaced');
    // Original card should be unchanged
    expect(card.elements[0].img_key).toBe('/tmp/chart.png');
  });

  it('should replace markdown image paths', () => {
    const card = {
      elements: [
        { tag: 'markdown', content: '![Chart](/tmp/chart.png) and some text' },
      ],
    };
    const mapping = new Map([['/tmp/chart.png', 'img_v3_02ab_md']]);

    const result = replaceLocalImagePaths(card, mapping) as typeof card;

    expect((result.elements[0] as { content: string }).content).toBe(
      '![Chart](img_v3_02ab_md) and some text',
    );
  });

  it('should replace multiple different paths', () => {
    const card = {
      elements: [
        { tag: 'img', img_key: '/tmp/a.png' },
        { tag: 'img', img_key: '/tmp/b.jpg' },
      ],
    };
    const mapping = new Map([
      ['/tmp/a.png', 'img_v3_key_a'],
      ['/tmp/b.jpg', 'img_v3_key_b'],
    ]);

    const result = replaceLocalImagePaths(card, mapping) as typeof card;

    expect(result.elements[0].img_key).toBe('img_v3_key_a');
    expect(result.elements[1].img_key).toBe('img_v3_key_b');
  });

  it('should leave unmapped paths unchanged', () => {
    const card = {
      elements: [
        { tag: 'img', img_key: '/tmp/chart.png' },
        { tag: 'img', img_key: '/tmp/other.png' },
      ],
    };
    const mapping = new Map([['/tmp/chart.png', 'img_v3_replaced']]);

    const result = replaceLocalImagePaths(card, mapping) as typeof card;

    expect(result.elements[0].img_key).toBe('img_v3_replaced');
    expect(result.elements[1].img_key).toBe('/tmp/other.png');
  });

  it('should return original card when mapping is empty', () => {
    const card = { elements: [{ tag: 'img', img_key: '/tmp/chart.png' }] };
    const mapping = new Map<string, string>();

    const result = replaceLocalImagePaths(card, mapping);
    expect(result).toBe(card); // Same reference when no replacements
  });

  it('should not modify the original card', () => {
    const original = {
      elements: [{ tag: 'img', img_key: '/tmp/chart.png' }],
    };
    const mapping = new Map([['/tmp/chart.png', 'img_v3_new']]);

    replaceLocalImagePaths(original, mapping);

    expect(original.elements[0].img_key).toBe('/tmp/chart.png');
  });

  it('should handle deeply nested structures', () => {
    const card = {
      elements: [{
        tag: 'column_set',
        columns: [{
          elements: [
            { tag: 'img', img_key: '/tmp/deep.png' },
          ],
        }],
      }],
    };
    const mapping = new Map([['/tmp/deep.png', 'img_v3_deep']]);

    const result = replaceLocalImagePaths(card, mapping) as typeof card;
    const nestedImg = (result.elements[0] as { columns: Array<{ elements: Array<{ img_key: string }> }> })
      .columns[0].elements[0];

    expect(nestedImg.img_key).toBe('img_v3_deep');
  });

  it('should handle mixed content with both img and markdown', () => {
    const card = {
      elements: [
        { tag: 'markdown', content: 'Here: ![A](/tmp/a.png)' },
        { tag: 'img', img_key: '/tmp/b.png' },
        { tag: 'div', text: { tag: 'plain_text', content: 'No images' } },
      ],
    };
    const mapping = new Map([
      ['/tmp/a.png', 'img_v3_a'],
      ['/tmp/b.png', 'img_v3_b'],
    ]);

    const result = replaceLocalImagePaths(card, mapping) as typeof card;

    expect((result.elements[0] as { content: string }).content).toBe('Here: ![A](img_v3_a)');
    expect((result.elements[1] as { img_key: string }).img_key).toBe('img_v3_b');
    expect(result.elements[2]).toEqual(card.elements[2]);
  });
});
