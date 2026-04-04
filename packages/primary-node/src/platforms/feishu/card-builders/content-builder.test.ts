/**
 * Tests for Feishu message content builder utilities.
 *
 * Tests pure functions for building Feishu API content fields.
 * These are type-safe wrappers around JSON.stringify for different message types.
 *
 * Related: #1617 Phase 4
 */

import { describe, it, expect } from 'vitest';
import {
  buildTextContent,
  buildPostContent,
  buildSimplePostContent,
  type PostTextElement,
  type PostAtElement,
  type PostLinkElement,
  type PostImageElement,
  type PostElement,
} from './content-builder.js';

describe('content-builder', () => {
  describe('buildTextContent', () => {
    it('should build text content with simple string', () => {
      const result = buildTextContent('Hello, world!');
      const parsed = JSON.parse(result);
      expect(parsed).toEqual({ text: 'Hello, world!' });
    });

    it('should handle empty string', () => {
      const result = buildTextContent('');
      const parsed = JSON.parse(result);
      expect(parsed).toEqual({ text: '' });
    });

    it('should handle special characters', () => {
      const result = buildTextContent('Line 1\nLine 2\tTab');
      const parsed = JSON.parse(result);
      expect(parsed.text).toBe('Line 1\nLine 2\tTab');
    });

    it('should handle unicode characters', () => {
      const result = buildTextContent('你好世界 🌍');
      const parsed = JSON.parse(result);
      expect(parsed.text).toBe('你好世界 🌍');
    });

    it('should handle JSON-sensitive characters', () => {
      const text = '{"key": "value"}';
      const result = buildTextContent(text);
      const parsed = JSON.parse(result);
      expect(parsed.text).toBe(text);
    });

    it('should return valid JSON string', () => {
      const result = buildTextContent('test');
      expect(() => JSON.parse(result)).not.toThrow();
    });
  });

  describe('buildPostContent', () => {
    it('should build post content with single text element', () => {
      const elements: PostTextElement[][] = [
        [{ tag: 'text', text: 'Hello' }],
      ];
      const result = buildPostContent(elements);
      const parsed = JSON.parse(result);
      expect(parsed.zh_cn.content).toEqual([[{ tag: 'text', text: 'Hello' }]]);
      expect(parsed.zh_cn.title).toBeUndefined();
    });

    it('should build post content with title', () => {
      const elements: PostTextElement[][] = [
        [{ tag: 'text', text: 'Body text' }],
      ];
      const result = buildPostContent(elements, 'My Title');
      const parsed = JSON.parse(result);
      expect(parsed.zh_cn.title).toBe('My Title');
      expect(parsed.zh_cn.content).toEqual([[{ tag: 'text', text: 'Body text' }]]);
    });

    it('should build post content with multiple rows', () => {
      const elements: PostElement[][] = [
        [{ tag: 'text', text: 'Row 1' }],
        [{ tag: 'text', text: 'Row 2' }],
        [{ tag: 'text', text: 'Row 3' }],
      ];
      const result = buildPostContent(elements);
      const parsed = JSON.parse(result);
      expect(parsed.zh_cn.content).toHaveLength(3);
      expect(parsed.zh_cn.content[0]).toEqual([{ tag: 'text', text: 'Row 1' }]);
      expect(parsed.zh_cn.content[2]).toEqual([{ tag: 'text', text: 'Row 3' }]);
    });

    it('should build post content with mixed element types in same row', () => {
      const elements: PostElement[][] = [
        [
          { tag: 'text', text: 'Hello ' },
          { tag: 'at', user_id: 'ou_123' },
          { tag: 'text', text: '!' },
        ],
      ];
      const result = buildPostContent(elements);
      const parsed = JSON.parse(result);
      expect(parsed.zh_cn.content[0]).toEqual([
        { tag: 'text', text: 'Hello ' },
        { tag: 'at', user_id: 'ou_123' },
        { tag: 'text', text: '!' },
      ]);
    });

    it('should build post content with at element including text', () => {
      const elements: PostAtElement[][] = [
        [
          { tag: 'at', user_id: 'ou_456', text: 'John' },
        ],
      ];
      const result = buildPostContent(elements);
      const parsed = JSON.parse(result);
      expect(parsed.zh_cn.content[0][0]).toEqual({ tag: 'at', user_id: 'ou_456', text: 'John' });
    });

    it('should build post content with link element', () => {
      const elements: PostLinkElement[][] = [
        [
          { tag: 'a', text: 'Click here', href: 'https://example.com' },
        ],
      ];
      const result = buildPostContent(elements);
      const parsed = JSON.parse(result);
      expect(parsed.zh_cn.content[0][0]).toEqual({
        tag: 'a',
        text: 'Click here',
        href: 'https://example.com',
      });
    });

    it('should build post content with image element', () => {
      const elements: PostImageElement[][] = [
        [
          { tag: 'img', image_key: 'img_v3_abc123' },
        ],
      ];
      const result = buildPostContent(elements);
      const parsed = JSON.parse(result);
      expect(parsed.zh_cn.content[0][0]).toEqual({ tag: 'img', image_key: 'img_v3_abc123' });
    });

    it('should handle empty elements array', () => {
      const result = buildPostContent([]);
      const parsed = JSON.parse(result);
      expect(parsed.zh_cn.content).toEqual([]);
      expect(parsed.zh_cn.title).toBeUndefined();
    });

    it('should not set title when title is empty string', () => {
      const elements: PostTextElement[][] = [[{ tag: 'text', text: 'Body' }]];
      const result = buildPostContent(elements, '');
      const parsed = JSON.parse(result);
      expect(parsed.zh_cn.title).toBeUndefined();
    });

    it('should return valid JSON string', () => {
      const elements: PostTextElement[][] = [[{ tag: 'text', text: 'test' }]];
      const result = buildPostContent(elements);
      expect(() => JSON.parse(result)).not.toThrow();
    });

    it('should use zh_cn as top-level key', () => {
      const elements: PostTextElement[][] = [[{ tag: 'text', text: 'test' }]];
      const result = buildPostContent(elements);
      const parsed = JSON.parse(result);
      expect(parsed.zh_cn).toBeDefined();
      expect(parsed.post).toBeUndefined();
    });
  });

  describe('buildSimplePostContent', () => {
    it('should build simple post from text', () => {
      const result = buildSimplePostContent('Hello, world!');
      const parsed = JSON.parse(result);
      expect(parsed.zh_cn.content).toEqual([[{ tag: 'text', text: 'Hello, world!' }]]);
    });

    it('should build simple post with title', () => {
      const result = buildSimplePostContent('Body text', 'Title');
      const parsed = JSON.parse(result);
      expect(parsed.zh_cn.title).toBe('Title');
      expect(parsed.zh_cn.content).toEqual([[{ tag: 'text', text: 'Body text' }]]);
    });

    it('should handle empty text', () => {
      const result = buildSimplePostContent('');
      const parsed = JSON.parse(result);
      expect(parsed.zh_cn.content).toEqual([[{ tag: 'text', text: '' }]]);
    });

    it('should wrap text in single row with single element', () => {
      const result = buildSimplePostContent('Test');
      const parsed = JSON.parse(result);
      expect(parsed.zh_cn.content).toHaveLength(1);
      expect(parsed.zh_cn.content[0]).toHaveLength(1);
      expect(parsed.zh_cn.content[0][0].tag).toBe('text');
    });

    it('should delegate to buildPostContent', () => {
      const simple = buildSimplePostContent('Hello', 'Title');
      const manual = buildPostContent([[{ tag: 'text', text: 'Hello' }]], 'Title');
      expect(simple).toBe(manual);
    });

    it('should handle multiline text', () => {
      const text = 'Line 1\nLine 2\nLine 3';
      const result = buildSimplePostContent(text);
      const parsed = JSON.parse(result);
      expect(parsed.zh_cn.content[0][0].text).toBe(text);
    });
  });
});
