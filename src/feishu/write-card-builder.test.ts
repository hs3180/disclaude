/**
 * Tests for write-card-builder (src/feishu/write-card-builder.ts)
 */

import { describe, it, expect } from 'vitest';
import {
  buildWriteContentCard,
  parseWriteToolInput,
  type WriteContent,
} from './write-card-builder.js';

describe('buildWriteContentCard', () => {
  describe('basic card structure', () => {
    it('should create card with header and elements', () => {
      const content: WriteContent = {
        filePath: '/src/index.ts',
        language: 'typescript',
        content: 'const x = 1;',
        totalLines: 1,
        isTruncated: false,
        previewLines: ['const x = 1;'],
      };

      const card = buildWriteContentCard(content);

      expect(card.config).toEqual({ wide_screen_mode: true });
      expect(card.header).toEqual({
        title: { tag: 'plain_text', content: '✍️ 文件写入' },
        template: 'green',
      });
      expect(card.elements).toBeDefined();
      expect(Array.isArray(card.elements)).toBe(true);
    });

    it('should use custom title and template', () => {
      const content: WriteContent = {
        filePath: '/test.py',
        language: 'python',
        content: 'x = 1',
        totalLines: 1,
        isTruncated: false,
        previewLines: ['x = 1'],
      };

      const card = buildWriteContentCard(content, 'Custom Title', 'blue');

      expect(card.header).toEqual({
        title: { tag: 'plain_text', content: 'Custom Title' },
        template: 'blue',
      });
    });
  });

  describe('file header', () => {
    it('should include file path with escaped HTML', () => {
      const content: WriteContent = {
        filePath: '/src/<script>.ts',
        content: 'x',
        totalLines: 1,
        isTruncated: false,
        previewLines: ['x'],
      };

      const card = buildWriteContentCard(content);
      const [headerElement] = card.elements as [{ content: string }];

      expect(headerElement.content).toContain('&lt;script&gt;');
    });

    it('should include language badge when provided', () => {
      const content: WriteContent = {
        filePath: '/src/app.ts',
        language: 'typescript',
        content: 'x',
        totalLines: 1,
        isTruncated: false,
        previewLines: ['x'],
      };

      const card = buildWriteContentCard(content);
      const [headerElement] = card.elements as [{ content: string }];

      expect(headerElement.content).toContain('`typescript`');
    });

    it('should not include language badge when not provided', () => {
      const content: WriteContent = {
        filePath: '/src/unknown',
        content: 'x',
        totalLines: 1,
        isTruncated: false,
        previewLines: ['x'],
      };

      const card = buildWriteContentCard(content);
      const [headerElement] = card.elements as [{ content: string }];

      expect(headerElement.content).not.toContain('`undefined`');
    });

    it('should include line count', () => {
      const content: WriteContent = {
        filePath: '/src/file.ts',
        content: 'line1\nline2\nline3',
        totalLines: 3,
        isTruncated: false,
        previewLines: ['line1', 'line2', 'line3'],
      };

      const card = buildWriteContentCard(content);
      const [headerElement] = card.elements as [{ content: string }];

      expect(headerElement.content).toContain('3 行');
    });

    it('should include truncated badge when truncated', () => {
      const content: WriteContent = {
        filePath: '/src/large.ts',
        content: 'many lines...',
        totalLines: 100,
        isTruncated: true,
        previewLines: ['line1', 'line100'],
      };

      const card = buildWriteContentCard(content);
      const [headerElement] = card.elements as [{ content: string }];

      expect(headerElement.content).toContain('*(已截断)*');
    });
  });

  describe('content preview', () => {
    it('should show full content when not truncated', () => {
      const content: WriteContent = {
        filePath: '/src/small.ts',
        language: 'typescript',
        content: 'const a = 1;\nconst b = 2;',
        totalLines: 2,
        isTruncated: false,
        previewLines: ['const a = 1;', 'const b = 2;'],
      };

      const card = buildWriteContentCard(content);
      const [, contentElement] = card.elements as [{ content: string }, { content: string }];

      expect(contentElement.content).toContain('```typescript');
      expect(contentElement.content).toContain('const a = 1;');
      expect(contentElement.content).toContain('const b = 2;');
    });

    it('should show line numbers', () => {
      const content: WriteContent = {
        filePath: '/src/file.ts',
        language: 'typescript',
        content: 'line1\nline2',
        totalLines: 2,
        isTruncated: false,
        previewLines: ['line1', 'line2'],
      };

      const card = buildWriteContentCard(content);
      const [, contentElement] = card.elements as [{ content: string }, { content: string }];

      expect(contentElement.content).toContain('   1 | line1');
      expect(contentElement.content).toContain('   2 | line2');
    });

    it('should show truncation notice when truncated', () => {
      const content: WriteContent = {
        filePath: '/src/large.ts',
        language: 'typescript',
        content: 'many lines',
        totalLines: 100,
        isTruncated: true,
        previewLines: ['line1', 'line100'],
      };

      const card = buildWriteContentCard(content);

      // Should have 3 elements: header, content, truncation notice
      expect(card.elements).toHaveLength(3);

      const [, , noticeElement] = card.elements as [{ content: string }, { content: string }, { content: string }];
      expect(noticeElement.content).toContain('已省略中间');
      expect(noticeElement.content).toContain('98 行'); // 100 - 2 = 98
    });
  });

  describe('long line truncation', () => {
    it('should truncate long lines', () => {
      const longLine = 'x'.repeat(300);
      const content: WriteContent = {
        filePath: '/src/file.ts',
        language: 'typescript',
        content: longLine,
        totalLines: 1,
        isTruncated: false,
        previewLines: [longLine],
      };

      const card = buildWriteContentCard(content, '✍️ 文件写入', 'green', {
        maxCharsPerLine: 200,
      });
      const [, contentElement] = card.elements as [{ content: string }, { content: string }];

      // Line should be truncated with ellipsis
      expect(contentElement.content).toContain('...');
    });
  });

  describe('custom config', () => {
    it('should use custom maxLines', () => {
      const lines = Array(100).fill('line');
      const content: WriteContent = {
        filePath: '/src/file.ts',
        content: lines.join('\n'),
        totalLines: 100,
        isTruncated: true,
        previewLines: lines.slice(0, 5),
      };

      // Custom config shouldn't affect already-parsed content
      const card = buildWriteContentCard(content, '✍️ 文件写入', 'green', {
        maxLines: 10,
      });

      expect(card).toBeDefined();
    });
  });
});

describe('parseWriteToolInput', () => {
  describe('valid input', () => {
    it('should parse file_path and content', () => {
      const input = {
        file_path: '/src/index.ts',
        content: 'const x = 1;',
      };

      const result = parseWriteToolInput(input);

      expect(result).not.toBeNull();
      if (result) {
        expect(result.filePath).toBe('/src/index.ts');
        expect(result.content).toBe('const x = 1;');
        expect(result.language).toBe('typescript');
        expect(result.totalLines).toBe(1);
      }
    });

    it('should detect language from file extension', () => {
      const testCases = [
        { path: '/src/index.ts', expected: 'typescript' },
        { path: '/src/index.js', expected: 'javascript' },
        { path: '/src/index.py', expected: 'python' },
        { path: '/src/index.go', expected: 'go' },
        { path: '/src/index.rs', expected: 'rust' },
        { path: '/src/index.java', expected: 'java' },
        { path: '/src/index.rb', expected: 'ruby' },
        { path: '/src/index.php', expected: 'php' },
        { path: '/src/index.css', expected: 'css' },
        { path: '/src/index.html', expected: 'html' },
        { path: '/src/index.json', expected: 'json' },
        { path: '/src/index.yaml', expected: 'yaml' },
        { path: '/src/index.md', expected: 'markdown' },
        { path: '/src/index.sh', expected: 'bash' },
        { path: '/src/index.sql', expected: 'sql' },
      ];

      for (const { path, expected } of testCases) {
        const result = parseWriteToolInput({
          file_path: path,
          content: 'x',
        });
        if (result) {
          expect(result.language).toBe(expected);
        }
      }
    });

    it('should return text for unknown extensions', () => {
      const result = parseWriteToolInput({
        file_path: '/src/index.xyz',
        content: 'content',
      });

      if (result) {
        expect(result.language).toBe('text');
      }
    });

    it('should count total lines correctly', () => {
      const result = parseWriteToolInput({
        file_path: '/src/test.ts',
        content: 'line1\nline2\nline3\n',
      });

      if (result) {
        expect(result.totalLines).toBe(4); // 3 content lines + 1 empty line after final newline
      }
    });
  });

  describe('truncation logic', () => {
    it('should not truncate when under maxLines', () => {
      const lines = Array(10).fill('line').join('\n');
      const result = parseWriteToolInput(
        {
          file_path: '/src/test.ts',
          content: lines,
        },
        { maxLines: 50 }
      );

      if (result) {
        expect(result.isTruncated).toBe(false);
        expect(result.previewLines).toHaveLength(10);
      }
    });

    it('should truncate when over maxLines', () => {
      const lines = Array(100).fill('line').join('\n');
      const result = parseWriteToolInput(
        {
          file_path: '/src/test.ts',
          content: lines,
        },
        { maxLines: 50, contextLines: 10 }
      );

      if (result) {
        expect(result.isTruncated).toBe(true);
        // Should have 10 start + 1 marker + 10 end = 21 items
        expect(result.previewLines).toHaveLength(21);
      }
    });

    it('should include context lines at start and end', () => {
      const lines = Array(100)
        .fill(0)
        .map((_, i) => `line${i + 1}`)
        .join('\n');

      const result = parseWriteToolInput(
        {
          file_path: '/src/test.ts',
          content: lines,
        },
        { maxLines: 50, contextLines: 5 }
      );

      if (result) {
        expect(result.isTruncated).toBe(true);
        // First 5 lines
        expect(result.previewLines[0]).toBe('line1');
        expect(result.previewLines[4]).toBe('line5');
        // Truncation marker
        expect(result.previewLines[5]).toBe('__TRUNCATION__');
        // Last 5 lines
        expect(result.previewLines[6]).toBe('line96');
        expect(result.previewLines[10]).toBe('line100');
      }
    });
  });

  describe('invalid input', () => {
    it('should return null for undefined input', () => {
      expect(parseWriteToolInput(undefined)).toBeNull();
    });

    it('should return null for missing file_path', () => {
      expect(
        parseWriteToolInput({ content: 'test' })
      ).toBeNull();
    });

    it('should return null for missing content', () => {
      expect(
        parseWriteToolInput({ file_path: '/test.ts' })
      ).toBeNull();
    });

    it('should return null for undefined content', () => {
      expect(
        parseWriteToolInput({ file_path: '/test.ts', content: undefined })
      ).toBeNull();
    });
  });

  describe('camelCase support', () => {
    it('should support camelCase filePath', () => {
      const result = parseWriteToolInput({
        filePath: '/src/index.ts',
        content: 'x',
      });

      if (result) {
        expect(result.filePath).toBe('/src/index.ts');
      }
    });

    it('should prefer snake_case file_path over filePath', () => {
      const result = parseWriteToolInput({
        file_path: '/src/snake.ts',
        filePath: '/src/camel.ts',
        content: 'x',
      });

      if (result) {
        expect(result.filePath).toBe('/src/snake.ts');
      }
    });
  });
});
