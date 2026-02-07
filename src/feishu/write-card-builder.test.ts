/**
 * Tests for write card builder (src/feishu/write-card-builder.ts)
 *
 * Tests the following functionality:
 * - Building content preview cards for Write tool use
 * - Parsing Write tool input into WriteContent format
 * - Content truncation for large files
 * - Language detection from file extensions
 * - HTML escaping for Feishu markdown
 */

import { describe, it, expect } from 'vitest';
import {
  buildWriteContentCard,
  parseWriteToolInput,
  type WriteContent,
} from './write-card-builder.js';

describe('buildWriteContentCard', () => {
  const mockWriteContent: WriteContent = {
    filePath: '/path/to/file.ts',
    language: 'typescript',
    content: 'console.log("Hello");\nconsole.log("World");',
    totalLines: 2,
    isTruncated: false,
    previewLines: ['console.log("Hello");', 'console.log("World");'],
  };

  it('should build basic card with default title and template', () => {
    const result = buildWriteContentCard(mockWriteContent);

    expect(result).toHaveProperty('config');
    expect(result).toHaveProperty('header');
    expect(result).toHaveProperty('elements');
    expect(result.config).toEqual({ wide_screen_mode: true });
    expect((result.header as Record<string, unknown>).title).toHaveProperty('content');
    expect((result.header as Record<string, unknown>).template).toBe('green');
  });

  it('should include file path in header', () => {
    const result = buildWriteContentCard(mockWriteContent);
    const elements = result.elements as any[];

    expect(elements[0].content).toContain('/path/to/file.ts');
  });

  it('should include language badge when language is specified', () => {
    const result = buildWriteContentCard(mockWriteContent);
    const elements = result.elements as any[];

    expect(elements[0].content).toContain('`typescript`');
  });

  it('should show line count', () => {
    const result = buildWriteContentCard(mockWriteContent);
    const elements = result.elements as any[];

    expect(elements[0].content).toContain('2 行');
  });

  it('should show truncation badge when content is truncated', () => {
    const truncatedContent: WriteContent = {
      ...mockWriteContent,
      isTruncated: true,
      totalLines: 100,
    };

    const result = buildWriteContentCard(truncatedContent);
    const elements = result.elements as any[];

    expect(elements[0].content).toContain('*(已截断)*');
  });

  it('should include code block with content', () => {
    const result = buildWriteContentCard(mockWriteContent);
    const elements = result.elements as any[];

    expect(elements[1].content).toContain('```');
    expect(elements[1].content).toContain('typescript');
  });

  it('should include line numbers in code block', () => {
    const result = buildWriteContentCard(mockWriteContent);
    const elements = result.elements as any[];

    expect(elements[1].content).toContain('1 |');
    expect(elements[1].content).toContain('2 |');
  });

  it('should show truncation notice for large files', () => {
    const largeContent: WriteContent = {
      filePath: '/path/to/file.ts',
      language: 'typescript',
      content: 'line 1\nline 2\nline 3',
      totalLines: 100,
      isTruncated: true,
      previewLines: ['line 1', '__TRUNCATION__', 'line 3'],
    };

    const result = buildWriteContentCard(largeContent);
    const elements = result.elements as any[];

    expect(elements[2].content).toContain('已省略中间 97 行');
  });

  it('should handle files without language', () => {
    const noLanguageContent: WriteContent = {
      ...mockWriteContent,
      language: undefined,
    };

    const result = buildWriteContentCard(noLanguageContent);
    const elements = result.elements as any[];

    expect(elements[0].content).not.toContain('`typescript`');
  });

  it('should use custom title and template', () => {
    const result = buildWriteContentCard(
      mockWriteContent,
      'Custom Title',
      'red'
    );

    expect((result.header as Record<string, unknown>).title).toHaveProperty('content');
    expect((result.header as Record<string, unknown>).template).toBe('red');
  });

  it('should use custom config', () => {
    const result = buildWriteContentCard(mockWriteContent, '✍️ 文件写入', 'green', {
      maxLines: 100,
      maxCharsPerLine: 300,
      contextLines: 20,
    });

    // Should not throw
    expect(result).toBeDefined();
  });
});

describe('parseWriteToolInput', () => {
  it('should parse valid Write tool input with snake_case', () => {
    const input = {
      file_path: '/path/to/file.ts',
      content: 'line 1\nline 2\nline 3',
    };

    const result = parseWriteToolInput(input);

    expect(result).not.toBeNull();
    expect(result?.filePath).toBe('/path/to/file.ts');
    expect(result?.content).toBe('line 1\nline 2\nline 3');
  });

  it('should parse valid Write tool input with camelCase', () => {
    const input = {
      filePath: '/path/to/file.js',
      content: 'content here',
    };

    const result = parseWriteToolInput(input);

    expect(result).not.toBeNull();
    expect(result?.filePath).toBe('/path/to/file.js');
  });

  it('should detect language from file extension', () => {
    const testCases = [
      { file: 'test.ts', expected: 'typescript' },
      { file: 'test.js', expected: 'javascript' },
      { file: 'test.py', expected: 'python' },
      { file: 'test.go', expected: 'go' },
      { file: 'test.rs', expected: 'rust' },
      { file: 'test.java', expected: 'java' },
      { file: 'test.cpp', expected: 'cpp' },
      { file: 'test.sh', expected: 'bash' },
      { file: 'test.yaml', expected: 'yaml' },
      { file: 'test.json', expected: 'json' },
      { file: 'test.md', expected: 'markdown' },
      { file: 'test.unknown', expected: 'text' },
      { file: 'test', expected: 'text' },
    ];

    for (const { file, expected } of testCases) {
      const input = {
        file_path: `/path/to/${file}`,
        content: 'content',
      };

      const result = parseWriteToolInput(input);
      expect(result?.language).toBe(expected);
    }
  });

  it('should set isTruncated to false for small files', () => {
    const input = {
      file_path: '/path/to/file.ts',
      content: 'line 1\nline 2',
    };

    const result = parseWriteToolInput(input);

    expect(result?.isTruncated).toBe(false);
    expect(result?.totalLines).toBe(2);
  });

  it('should set isTruncated to true for large files', () => {
    const lines = Array(100).fill('line content');
    const input = {
      file_path: '/path/to/file.ts',
      content: lines.join('\n'),
    };

    const result = parseWriteToolInput(input);

    expect(result?.isTruncated).toBe(true);
    expect(result?.totalLines).toBe(100);
  });

  it('should use custom maxLines config', () => {
    const lines = Array(60).fill('line');
    const input = {
      file_path: '/path/to/file.ts',
      content: lines.join('\n'),
    };

    const result = parseWriteToolInput(input, { maxLines: 100 });

    expect(result?.isTruncated).toBe(false);
  });

  it('should include preview lines for small files', () => {
    const input = {
      file_path: '/path/to/file.ts',
      content: 'line 1\nline 2\nline 3',
    };

    const result = parseWriteToolInput(input);

    expect(result?.previewLines).toEqual(['line 1', 'line 2', 'line 3']);
  });

  it('should include truncated preview lines for large files', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const input = {
      file_path: '/path/to/file.ts',
      content: lines.join('\n'),
    };

    const result = parseWriteToolInput(input);

    expect(result?.previewLines.length).toBeLessThan(100);
    expect(result?.previewLines).toContain('__TRUNCATION__');
  });

  it('should return null when input is undefined', () => {
    const result = parseWriteToolInput(undefined);
    expect(result).toBeNull();
  });

  it('should return null when file_path is missing', () => {
    const input = {
      content: 'some content',
    };

    const result = parseWriteToolInput(input as any);
    expect(result).toBeNull();
  });

  it('should return null when content is missing', () => {
    const input = {
      file_path: '/path/to/file.ts',
    };

    const result = parseWriteToolInput(input as any);
    expect(result).toBeNull();
  });

  it('should handle empty content', () => {
    const input = {
      file_path: '/path/to/file.ts',
      content: '',
    };

    const result = parseWriteToolInput(input);

    expect(result).not.toBeNull();
    expect(result?.totalLines).toBe(1); // Empty string splits to 1 line
    expect(result?.isTruncated).toBe(false);
  });

  it('should handle single line content', () => {
    const input = {
      file_path: '/path/to/file.ts',
      content: 'single line',
    };

    const result = parseWriteToolInput(input);

    expect(result?.totalLines).toBe(1);
    expect(result?.previewLines).toEqual(['single line']);
  });

  it('should handle content with different line endings', () => {
    const input = {
      file_path: '/path/to/file.ts',
      content: 'line 1\r\nline 2\nline 3\rline 4',
    };

    const result = parseWriteToolInput(input);

    expect(result?.totalLines).toBeGreaterThanOrEqual(1);
  });
});

describe('write card builder edge cases', () => {
  it('should handle very long file paths', () => {
    const longPath = '/a'.repeat(1000) + '/file.ts';
    const mockContent: WriteContent = {
      filePath: longPath,
      content: 'content',
      totalLines: 1,
      isTruncated: false,
      previewLines: ['content'],
    };

    const result = buildWriteContentCard(mockContent);
    expect(result).toBeDefined();
  });

  it('should handle special characters in file path', () => {
    const specialPath = '/path/to/file with spaces & special-chars_123.ts';
    const mockContent: WriteContent = {
      filePath: specialPath,
      content: 'content',
      totalLines: 1,
      isTruncated: false,
      previewLines: ['content'],
    };

    const result = buildWriteContentCard(mockContent);
    expect(result).toBeDefined();
  });

  it('should handle very long lines in content', () => {
    const longLine = 'a'.repeat(10000);
    const mockContent: WriteContent = {
      filePath: '/path/to/file.ts',
      content: longLine,
      totalLines: 1,
      isTruncated: false,
      previewLines: [longLine],
    };

    const result = buildWriteContentCard(mockContent);
    expect(result).toBeDefined();
  });

  it('should handle empty preview lines', () => {
    const mockContent: WriteContent = {
      filePath: '/path/to/file.ts',
      content: '',
      totalLines: 0,
      isTruncated: false,
      previewLines: [],
    };

    const result = buildWriteContentCard(mockContent);
    expect(result).toBeDefined();
  });

  it('should handle content with only truncation marker', () => {
    const mockContent: WriteContent = {
      filePath: '/path/to/file.ts',
      content: '',
      totalLines: 100,
      isTruncated: true,
      previewLines: ['__TRUNCATION__'],
    };

    const result = buildWriteContentCard(mockContent);
    expect(result).toBeDefined();
  });
});
