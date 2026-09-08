/**
 * Tests for Feishu message content builder utilities.
 *
 * @see content-builder.ts
 */

import { describe, it, expect } from 'vitest';
import {
  buildTextContent,
  normalizeMarkdownLineBreaks,
  normalizeCardMarkdown,
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

  // Issue #4817: buildTextContent is the single exit for msg_type 'text',
  // so the escaped-newline restoration must happen here, not at each caller.
  it('restores escaped newlines so Markdown paragraphs survive (Issue #4817)', () => {
    const parsed = JSON.parse(buildTextContent('结论：可行\\n\\n- K3：2.8T\\n- B300：288GB'));
    expect(parsed.text).toBe('结论：可行\n\n- K3：2.8T\n- B300：288GB');
    expect(parsed.text).not.toContain('\\n');
  });

  it('keeps a user-authored doubled backslash literal (Issue #4817)', () => {
    const parsed = JSON.parse(buildTextContent('regex 用 \\\\n 匹配换行'));
    expect(parsed.text).toBe('regex 用 \\\\n 匹配换行');
  });

  it('is idempotent — normalizing twice changes nothing (Issue #4817)', () => {
    const once = JSON.parse(buildTextContent('a\\nb')).text;
    expect(JSON.parse(buildTextContent(once)).text).toBe(once);
  });
});

describe('Markdown line-break normalization', () => {
  it('restores a single escaped newline', () => {
    expect(normalizeMarkdownLineBreaks('**标题**\\n\\n- 项目')).toBe('**标题**\n\n- 项目');
  });

  it('preserves doubled backslashes', () => {
    expect(normalizeMarkdownLineBreaks('```text\\\\n```')).toBe('```text\\\\n```');
  });

  it('changes Markdown elements but not plain-text fields', () => {
    const card = {
      header: { title: { tag: 'plain_text', content: 'title\\ntext' } },
      elements: [
        { tag: 'markdown', content: 'line 1\\nline 2' },
        { tag: 'div', text: { tag: 'plain_text', content: 'literal\\ntext' } },
      ],
    };
    expect(normalizeCardMarkdown(card)).toEqual({
      header: { title: { tag: 'plain_text', content: 'title\\ntext' } },
      elements: [
        { tag: 'markdown', content: 'line 1\nline 2' },
        { tag: 'div', text: { tag: 'plain_text', content: 'literal\\ntext' } },
      ],
    });
  });
});

describe('buildPostContent', () => {
  it('should build post content without title', () => {
    const elements: PostElement[][] = [[{ tag: 'text', text: 'Hello ' }]];
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
    const elements: PostElement[][] = [[{ tag: 'text', text: 'World' }]];
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
      [
        { tag: 'text', text: 'Hello ' },
        { tag: 'text', text: 'World' },
      ],
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
    const elements: PostElement[][] = [[{ tag: 'at', user_id: 'ou_123', text: '@user' }]];
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
    const elements: PostElement[][] = [[{ tag: 'img', image_key: 'img_xxx' }]];
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
    const elements: PostElement[][] = [[{ tag: 'text', text: 'test' }]];
    const result = buildPostContent(elements, 'Title');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('should handle empty elements array', () => {
    const result = buildPostContent([]);
    const parsed = JSON.parse(result);
    expect(parsed.zh_cn.content).toEqual([]);
  });

  // Issue #4817: post rows carry the same text as msg_type 'text'.
  it('restores escaped newlines in text segments (Issue #4817)', () => {
    const elements: PostElement[][] = [[{ tag: 'text', text: '第一段\\n\\n第二段' }]];
    const parsed = JSON.parse(buildPostContent(elements));
    expect(parsed.zh_cn.content[0][0].text).toBe('第一段\n\n第二段');
  });

  it('leaves non-text segments untouched (Issue #4817)', () => {
    const elements: PostElement[][] = [
      [
        { tag: 'at', user_id: 'ou_1', text: 'name\\nwith escape' },
        { tag: 'a', text: 'label\\nkept', href: 'https://example.com/a\\nb' },
        { tag: 'img', image_key: 'img_v3_\\nkey' },
      ],
    ];
    const parsed = JSON.parse(buildPostContent(elements));
    expect(parsed.zh_cn.content[0][0].text).toBe('name\\nwith escape');
    expect(parsed.zh_cn.content[0][1].text).toBe('label\\nkept');
    expect(parsed.zh_cn.content[0][1].href).toBe('https://example.com/a\\nb');
    expect(parsed.zh_cn.content[0][2].image_key).toBe('img_v3_\\nkey');
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
