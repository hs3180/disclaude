/**
 * Tests for Feishu message content builder utilities.
 *
 * @see content-builder.ts
 */

import { describe, it, expect } from 'vitest';
import {
  buildTextContent,
  buildPostContent,
  buildSimplePostContent,
  type PostElement,
} from './content-builder.js';

describe('buildTextContent', () => {
  it('should build simple text content as JSON string', () => {
    const result = buildTextContent('Hello, world!');
    expect(result).toBe('{"text":"Hello, world!"}');
  });

  it('should produce valid JSON', () => {
    const result = buildTextContent('test');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('should handle empty string', () => {
    const result = buildTextContent('');
    expect(JSON.parse(result)).toEqual({ text: '' });
  });

  it('should handle special characters', () => {
    const result = buildTextContent('Hello "world" & <friends>');
    const parsed = JSON.parse(result);
    expect(parsed.text).toBe('Hello "world" & <friends>');
  });

  it('should handle unicode text', () => {
    const result = buildTextContent('你好世界 🎉');
    const parsed = JSON.parse(result);
    expect(parsed.text).toBe('你好世界 🎉');
  });

  it('should handle multiline text', () => {
    const result = buildTextContent('line1\nline2\nline3');
    const parsed = JSON.parse(result);
    expect(parsed.text).toBe('line1\nline2\nline3');
  });
});

describe('buildPostContent', () => {
  it('should build post content without title', () => {
    const elements: PostElement[][] = [
      [{ tag: 'text', text: 'Hello ' }],
    ];
    const result = buildPostContent(elements);
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({
      zh_cn: {
        content: [[{ tag: 'text', text: 'Hello ' }]],
      },
    });
    expect(parsed.zh_cn.title).toBeUndefined();
  });

  it('should build post content with title', () => {
    const elements: PostElement[][] = [
      [{ tag: 'text', text: 'World' }],
    ];
    const result = buildPostContent(elements, 'Title');
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({
      zh_cn: {
        title: 'Title',
        content: [[{ tag: 'text', text: 'World' }]],
      },
    });
  });

  it('should handle multiple rows with multiple elements', () => {
    const elements: PostElement[][] = [
      [{ tag: 'text', text: 'Hello ' }, { tag: 'text', text: 'World' }],
      [{ tag: 'text', text: 'Second line' }],
    ];
    const result = buildPostContent(elements, 'Multi-row');
    const parsed = JSON.parse(result);

    expect(parsed.zh_cn.title).toBe('Multi-row');
    expect(parsed.zh_cn.content).toHaveLength(2);
    expect(parsed.zh_cn.content[0]).toHaveLength(2);
    expect(parsed.zh_cn.content[1]).toHaveLength(1);
  });

  it('should handle @ element', () => {
    const elements: PostElement[][] = [
      [{ tag: 'at', user_id: 'ou_123', text: '@user' }],
    ];
    const result = buildPostContent(elements);
    const parsed = JSON.parse(result);

    expect(parsed.zh_cn.content[0][0]).toEqual({
      tag: 'at',
      user_id: 'ou_123',
      text: '@user',
    });
  });

  it('should handle link element', () => {
    const elements: PostElement[][] = [
      [{ tag: 'a', text: 'Click here', href: 'https://example.com' }],
    ];
    const result = buildPostContent(elements);
    const parsed = JSON.parse(result);

    expect(parsed.zh_cn.content[0][0]).toEqual({
      tag: 'a',
      text: 'Click here',
      href: 'https://example.com',
    });
  });

  it('should handle image element', () => {
    const elements: PostElement[][] = [
      [{ tag: 'img', image_key: 'img_xxx' }],
    ];
    const result = buildPostContent(elements);
    const parsed = JSON.parse(result);

    expect(parsed.zh_cn.content[0][0]).toEqual({
      tag: 'img',
      image_key: 'img_xxx',
    });
  });

  it('should use zh_cn as top-level key (not "post")', () => {
    const elements: PostElement[][] = [[{ tag: 'text', text: 'test' }]];
    const result = buildPostContent(elements);
    const parsed = JSON.parse(result);

    expect(parsed).toHaveProperty('zh_cn');
    expect(parsed).not.toHaveProperty('post');
  });

  it('should produce valid JSON', () => {
    const elements: PostElement[][] = [
      [{ tag: 'text', text: 'test' }],
    ];
    const result = buildPostContent(elements, 'Title');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('should handle empty elements array', () => {
    const result = buildPostContent([]);
    const parsed = JSON.parse(result);
    expect(parsed.zh_cn.content).toEqual([]);
  });
});

describe('buildSimplePostContent', () => {
  it('should build simple post from plain text', () => {
    const result = buildSimplePostContent('Hello, world!');
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({
      zh_cn: {
        content: [[{ tag: 'text', text: 'Hello, world!' }]],
      },
    });
  });

  it('should build simple post with title', () => {
    const result = buildSimplePostContent('Hello', 'Greeting');
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({
      zh_cn: {
        title: 'Greeting',
        content: [[{ tag: 'text', text: 'Hello' }]],
      },
    });
  });

  it('should wrap plain text into a single text element', () => {
    const result = buildSimplePostContent('Some text');
    const parsed = JSON.parse(result);

    // Should be a 2D array with 1 row and 1 element
    expect(parsed.zh_cn.content).toHaveLength(1);
    expect(parsed.zh_cn.content[0]).toHaveLength(1);
    expect(parsed.zh_cn.content[0][0].tag).toBe('text');
  });

  it('should produce valid JSON', () => {
    const result = buildSimplePostContent('test', 'title');
    expect(() => JSON.parse(result)).not.toThrow();
  });
});
