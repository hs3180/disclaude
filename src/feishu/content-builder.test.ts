/**
 * Tests for content builder (src/feishu/content-builder.ts)
 *
 * Tests the following functionality:
 * - Building text message content
 * - Building post (rich text) content
 * - Building simple post content from plain text
 * - Post element type support (text, at, link, image)
 */

import { describe, it, expect } from 'vitest';
import {
  buildTextContent,
  buildPostContent,
  buildSimplePostContent,
  type PostElement,
} from './content-builder.js';

describe('buildTextContent', () => {
  it('should build simple text content', () => {
    const content = buildTextContent('Hello, world!');

    expect(content).toBe('{"text":"Hello, world!"}');
  });

  it('should handle empty string', () => {
    const content = buildTextContent('');

    expect(content).toBe('{"text":""}');
  });

  it('should handle special characters', () => {
    const text = 'Hello "world"!\nNew line\tTab';
    const content = buildTextContent(text);

    const parsed = JSON.parse(content);
    expect(parsed.text).toBe(text);
  });

  it('should handle unicode characters', () => {
    const text = '你好世界 🎉';
    const content = buildTextContent(text);

    const parsed = JSON.parse(content);
    expect(parsed.text).toBe(text);
  });

  it('should handle multiline text', () => {
    const text = 'Line 1\nLine 2\nLine 3';
    const content = buildTextContent(text);

    const parsed = JSON.parse(content);
    expect(parsed.text).toBe(text);
  });
});

describe('buildPostContent', () => {
  it('should build post content with text elements', () => {
    const elements: PostElement[][] = [
      [{ tag: 'text', text: 'Hello ' }],
      [{ tag: 'text', text: 'World' }],
    ];

    const content = buildPostContent(elements);
    const parsed = JSON.parse(content);

    expect(parsed.zh_cn).toBeDefined();
    expect(parsed.zh_cn.content).toEqual(elements);
    expect(parsed.zh_cn.title).toBeUndefined();
  });

  it('should build post content with title', () => {
    const elements: PostElement[][] = [
      [{ tag: 'text', text: 'Content' }],
    ];

    const content = buildPostContent(elements, 'Title');
    const parsed = JSON.parse(content);

    expect(parsed.zh_cn.title).toBe('Title');
    expect(parsed.zh_cn.content).toEqual(elements);
  });

  it('should build post content with at elements', () => {
    const elements: PostElement[][] = [
      [
        { tag: 'text', text: 'Hello ' },
        { tag: 'at', user_id: 'ou_123', text: '@User' },
      ],
    ];

    const content = buildPostContent(elements);
    const parsed = JSON.parse(content);

    expect(parsed.zh_cn.content[0][1]).toEqual({
      tag: 'at',
      user_id: 'ou_123',
      text: '@User',
    });
  });

  it('should build post content with link elements', () => {
    const elements: PostElement[][] = [
      [
        { tag: 'a', text: 'Link', href: 'https://example.com' },
      ],
    ];

    const content = buildPostContent(elements);
    const parsed = JSON.parse(content);

    expect(parsed.zh_cn.content[0][0]).toEqual({
      tag: 'a',
      text: 'Link',
      href: 'https://example.com',
    });
  });

  it('should build post content with image elements', () => {
    const elements: PostElement[][] = [
      [
        { tag: 'img', image_key: 'img_123' },
      ],
    ];

    const content = buildPostContent(elements);
    const parsed = JSON.parse(content);

    expect(parsed.zh_cn.content[0][0]).toEqual({
      tag: 'img',
      image_key: 'img_123',
    });
  });

  it('should handle mixed element types in one row', () => {
    const elements: PostElement[][] = [
      [
        { tag: 'text', text: 'Click ' },
        { tag: 'a', text: 'here', href: 'https://example.com' },
        { tag: 'text', text: ' for more' },
      ],
    ];

    const content = buildPostContent(elements);
    const parsed = JSON.parse(content);

    expect(parsed.zh_cn.content[0]).toHaveLength(3);
    expect(parsed.zh_cn.content[0][0].tag).toBe('text');
    expect(parsed.zh_cn.content[0][1].tag).toBe('a');
    expect(parsed.zh_cn.content[0][2].tag).toBe('text');
  });

  it('should handle multiple rows', () => {
    const elements: PostElement[][] = [
      [{ tag: 'text', text: 'Row 1' }],
      [{ tag: 'text', text: 'Row 2' }],
      [{ tag: 'text', text: 'Row 3' }],
    ];

    const content = buildPostContent(elements);
    const parsed = JSON.parse(content);

    expect(parsed.zh_cn.content).toHaveLength(3);
  });

  it('should handle empty elements array', () => {
    const elements: PostElement[][] = [];

    const content = buildPostContent(elements);
    const parsed = JSON.parse(content);

    expect(parsed.zh_cn.content).toEqual([]);
  });

  it('should handle special characters in title', () => {
    const elements: PostElement[][] = [
      [{ tag: 'text', text: 'Content' }],
    ];

    const title = 'Title with "quotes" and \'apostrophes\'';
    const content = buildPostContent(elements, title);
    const parsed = JSON.parse(content);

    expect(parsed.zh_cn.title).toBe(title);
  });
});

describe('buildSimplePostContent', () => {
  it('should build simple post content from text', () => {
    const content = buildSimplePostContent('Hello, world!');
    const parsed = JSON.parse(content);

    expect(parsed.zh_cn.content).toEqual([
      [{ tag: 'text', text: 'Hello, world!' }],
    ]);
    expect(parsed.zh_cn.title).toBeUndefined();
  });

  it('should build simple post content with title', () => {
    const content = buildSimplePostContent('Hello, world!', 'Greeting');
    const parsed = JSON.parse(content);

    expect(parsed.zh_cn.content).toEqual([
      [{ tag: 'text', text: 'Hello, world!' }],
    ]);
    expect(parsed.zh_cn.title).toBe('Greeting');
  });

  it('should handle empty text', () => {
    const content = buildSimplePostContent('');
    const parsed = JSON.parse(content);

    expect(parsed.zh_cn.content).toEqual([
      [{ tag: 'text', text: '' }],
    ]);
  });

  it('should handle multiline text', () => {
    const text = 'Line 1\nLine 2\nLine 3';
    const content = buildSimplePostContent(text);
    const parsed = JSON.parse(content);

    expect(parsed.zh_cn.content[0][0].text).toBe(text);
  });

  it('should handle unicode characters', () => {
    const text = '你好 🎉 世界';
    const content = buildSimplePostContent(text);
    const parsed = JSON.parse(content);

    expect(parsed.zh_cn.content[0][0].text).toBe(text);
  });

  it('should handle special markdown characters', () => {
    const text = '**Bold** *Italic* `code`';
    const content = buildSimplePostContent(text);
    const parsed = JSON.parse(content);

    expect(parsed.zh_cn.content[0][0].text).toBe(text);
  });
});
