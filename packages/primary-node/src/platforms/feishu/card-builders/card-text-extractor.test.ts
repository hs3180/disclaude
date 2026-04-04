import { describe, it, expect } from 'vitest';
import { extractCardTextContent } from './card-text-extractor.js';

describe('extractCardTextContent', () => {
  it('should extract header title', () => {
    const card = {
      header: {
        title: { content: '任务执行中' }
      },
      elements: []
    };
    const result = extractCardTextContent(card);
    expect(result).toContain('[任务执行中]');
  });

  it('should extract markdown content', () => {
    const card = {
      elements: [
        { tag: 'markdown', content: '正在处理您的请求...' }
      ]
    };
    const result = extractCardTextContent(card);
    expect(result).toContain('正在处理您的请求...');
    expect(result).toContain('[Interactive Card]');
  });

  it('should extract div text', () => {
    const card = {
      elements: [
        { tag: 'div', text: '这是一条文本消息' }
      ]
    };
    const result = extractCardTextContent(card);
    expect(result).toContain('这是一条文本消息');
  });

  it('should extract button text', () => {
    const card = {
      elements: [
        {
          tag: 'action',
          actions: [
            { tag: 'button', text: { content: '确认' } }
          ]
        }
      ]
    };
    const result = extractCardTextContent(card);
    expect(result).toContain('[确认]');
  });

  it('should extract note content', () => {
    const card = {
      elements: [
        { tag: 'note', content: '这是一条备注信息' }
      ]
    };
    const result = extractCardTextContent(card);
    expect(result).toContain('这是一条备注信息');
  });

  it('should handle nested elements', () => {
    const card = {
      elements: [
        {
          tag: 'column_set',
          columns: [
            {
              elements: [
                { tag: 'markdown', content: '列1内容' }
              ]
            },
            {
              elements: [
                { tag: 'markdown', content: '列2内容' }
              ]
            }
          ]
        }
      ]
    };
    const result = extractCardTextContent(card);
    expect(result).toContain('列1内容');
    expect(result).toContain('列2内容');
  });

  it('should limit output to first 3 text parts', () => {
    const card = {
      elements: [
        { tag: 'markdown', content: '第一行' },
        { tag: 'markdown', content: '第二行' },
        { tag: 'markdown', content: '第三行' },
        { tag: 'markdown', content: '第四行（不应出现）' }
      ]
    };
    const result = extractCardTextContent(card);
    expect(result).toContain('第一行');
    expect(result).toContain('第二行');
    expect(result).toContain('第三行');
    expect(result).not.toContain('第四行');
  });

  it('should truncate long markdown content to first line and 100 chars', () => {
    const longContent = '这是一个很长很长的内容，'.repeat(20);
    const card = {
      elements: [
        { tag: 'markdown', content: longContent }
      ]
    };
    const result = extractCardTextContent(card);
    expect(result.length).toBeLessThan(200); // Reasonable limit
  });

  it('should return generic description for empty card', () => {
    const card = {
      elements: []
    };
    const result = extractCardTextContent(card);
    expect(result).toBe('[Interactive Card]');
  });

  it('should return generic description for card with no recognizable content', () => {
    const card = {
      elements: [
        { tag: 'unknown', data: 'something' }
      ]
    };
    const result = extractCardTextContent(card);
    expect(result).toBe('[Interactive Card]');
  });

  it('should handle complex real-world card', () => {
    const card = {
      header: {
        title: { content: '接下来您可以...' }
      },
      elements: [
        { tag: 'markdown', content: '✅ 任务已完成' },
        {
          tag: 'action',
          actions: [
            { tag: 'button', text: { content: '选项1' } },
            { tag: 'button', text: { content: '选项2' } }
          ]
        }
      ]
    };
    const result = extractCardTextContent(card);
    expect(result).toContain('[接下来您可以...]');
    expect(result).toContain('✅ 任务已完成');
  });

  // Issue #1711: Tests for interactive card quoted message extraction
  describe('Issue #1711: quoted interactive card messages', () => {
    it('should extract content from a typical bot-sent interactive card', () => {
      // Simulates the card content structure returned by Feishu API
      // when a user quotes/replies to a bot's interactive card message
      const cardContent = JSON.stringify({
        config: { wide_screen_mode: true },
        header: {
          title: { content: '搜索结果', tag: 'plain_text' },
          template: 'blue'
        },
        elements: [
          { tag: 'markdown', content: '找到 3 篇相关论文：' },
          { tag: 'markdown', content: '1. Paper A - 2024' },
          { tag: 'markdown', content: '2. Paper B - 2023' }
        ]
      });
      const parsed = JSON.parse(cardContent);
      const result = extractCardTextContent(parsed);
      expect(result).toContain('[搜索结果]');
      expect(result).toContain('找到 3 篇相关论文');
      expect(result).not.toBe('[Interactive Card]');
    });

    it('should handle interactive card with only header (no elements)', () => {
      const cardContent = JSON.stringify({
        header: {
          title: { content: '操作成功', tag: 'plain_text' }
        },
        elements: []
      });
      const parsed = JSON.parse(cardContent);
      const result = extractCardTextContent(parsed);
      expect(result).toContain('[操作成功]');
    });

    it('should return generic description for empty interactive card', () => {
      const cardContent = JSON.stringify({});
      const parsed = JSON.parse(cardContent);
      const result = extractCardTextContent(parsed);
      expect(result).toBe('[Interactive Card]');
    });

    it('should handle malformed card content gracefully', () => {
      const cardContent = 'not valid json';
      expect(() => JSON.parse(cardContent)).toThrow();
    });
  });
});
