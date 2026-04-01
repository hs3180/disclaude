/**
 * Tests for content-builder with @mention support.
 *
 * Issue #1742: Tests for buildPostContent with PostAtElement.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPostContent,
  buildTextContent,
  buildSimplePostContent,
  type PostElement,
} from './content-builder.js';

describe('buildTextContent', () => {
  it('should build simple text content', () => {
    const result = buildTextContent('Hello');
    expect(JSON.parse(result)).toEqual({ text: 'Hello' });
  });
});

describe('buildPostContent', () => {
  it('should build post content with text elements', () => {
    const elements: PostElement[][] = [
      [{ tag: 'text', text: 'Hello World' }],
    ];
    const result = buildPostContent(elements);
    const parsed = JSON.parse(result);
    expect(parsed.zh_cn.content).toEqual([[{ tag: 'text', text: 'Hello World' }]]);
  });

  it('should build post content with title', () => {
    const elements: PostElement[][] = [
      [{ tag: 'text', text: 'Content' }],
    ];
    const result = buildPostContent(elements, 'My Title');
    const parsed = JSON.parse(result);
    expect(parsed.zh_cn.title).toBe('My Title');
    expect(parsed.zh_cn.content).toEqual([[{ tag: 'text', text: 'Content' }]]);
  });

  it('should build post content with @mention elements', () => {
    const elements: PostElement[][] = [
      [
        { tag: 'at', user_id: 'ou_bot_001' },
        { tag: 'text', text: ' ' },
      ],
      [
        { tag: 'text', text: 'Please review this.' },
      ],
    ];
    const result = buildPostContent(elements);
    const parsed = JSON.parse(result);
    expect(parsed.zh_cn.content).toEqual([
      [
        { tag: 'at', user_id: 'ou_bot_001' },
        { tag: 'text', text: ' ' },
      ],
      [
        { tag: 'text', text: 'Please review this.' },
      ],
    ]);
  });

  it('should build post content with multiple @mentions', () => {
    const elements: PostElement[][] = [
      [
        { tag: 'at', user_id: 'ou_bot_001' },
        { tag: 'at', user_id: 'ou_bot_002' },
        { tag: 'text', text: ' ' },
      ],
      [
        { tag: 'text', text: 'Hello both!' },
      ],
    ];
    const result = buildPostContent(elements);
    const parsed = JSON.parse(result);
    expect(parsed.zh_cn.content[0]).toEqual([
      { tag: 'at', user_id: 'ou_bot_001' },
      { tag: 'at', user_id: 'ou_bot_002' },
      { tag: 'text', text: ' ' },
    ]);
  });

  it('should build post content without title when not provided', () => {
    const elements: PostElement[][] = [
      [{ tag: 'text', text: 'No title' }],
    ];
    const result = buildPostContent(elements);
    const parsed = JSON.parse(result);
    expect(parsed.zh_cn.title).toBeUndefined();
  });
});

describe('buildSimplePostContent', () => {
  it('should build simple post content from text', () => {
    const result = buildSimplePostContent('Hello, world!');
    const parsed = JSON.parse(result);
    expect(parsed.zh_cn.content).toEqual([[{ tag: 'text', text: 'Hello, world!' }]]);
  });

  it('should include title when provided', () => {
    const result = buildSimplePostContent('Content', 'Title');
    const parsed = JSON.parse(result);
    expect(parsed.zh_cn.title).toBe('Title');
  });
});
