/**
 * Tests for diff card builder (src/feishu/diff-card-builder.ts)
 *
 * Tests the following functionality:
 * - Building unified diff cards
 * - Parsing Edit tool input
 * - Language detection from file extensions
 * - HTML and code block escaping
 */

import { describe, it, expect } from 'vitest';
import {
  buildUnifiedDiffCard,
  parseEditToolInput,
  type CodeChange,
} from './diff-card-builder.js';

describe('buildUnifiedDiffCard', () => {
  it('should build card with default title and template', () => {
    const changes: CodeChange[] = [
      {
        filePath: '/path/to/file.ts',
        language: 'typescript',
        removed: ['old line'],
        added: ['new line'],
      },
    ];

    const card = buildUnifiedDiffCard(changes);

    expect(card.config).toEqual({ wide_screen_mode: true });
    expect((card.header as any).title.content).toBe('📝 代码编辑');
    expect((card.header as any).template).toBe('orange');
  });

  it('should build card with custom title and template', () => {
    const changes: CodeChange[] = [
      {
        filePath: '/path/to/file.ts',
        removed: ['old'],
        added: ['new'],
      },
    ];

    const card = buildUnifiedDiffCard(changes, 'Custom Title', 'blue');

    expect((card.header as any).title.content).toBe('Custom Title');
    expect((card.header as any).template).toBe('blue');
  });

  it('should include file path in elements', () => {
    const changes: CodeChange[] = [
      {
        filePath: '/path/to/file.ts',
        removed: ['old'],
        added: ['new'],
      },
    ];

    const card = buildUnifiedDiffCard(changes);
    const elements = card.elements as any[];

    expect(elements[0].content).toContain('/path/to/file.ts');
  });

  it('should include language badge when language is specified', () => {
    const changes: CodeChange[] = [
      {
        filePath: '/path/to/file.ts',
        language: 'typescript',
        removed: ['old'],
        added: ['new'],
      },
    ];

    const card = buildUnifiedDiffCard(changes);
    const elements = card.elements as any[];

    expect(elements[0].content).toContain('`typescript`');
  });

  it('should not include language badge when language is not specified', () => {
    const changes: CodeChange[] = [
      {
        filePath: '/path/to/file.txt',
        removed: ['old'],
        added: ['new'],
      },
    ];

    const card = buildUnifiedDiffCard(changes);
    const elements = card.elements as any[];

    expect(elements[0].content).not.toContain('`text`');
  });

  it('should include diff code block', () => {
    const changes: CodeChange[] = [
      {
        filePath: '/path/to/file.ts',
        removed: ['old line 1', 'old line 2'],
        added: ['new line 1', 'new line 2'],
      },
    ];

    const card = buildUnifiedDiffCard(changes);
    const elements = card.elements as any[];

    expect(elements[0].content).toContain('```diff');
    expect(elements[0].content).toContain('```');
  });

  it('should show removed lines with - prefix', () => {
    const changes: CodeChange[] = [
      {
        filePath: '/path/to/file.ts',
        removed: ['line 1', 'line 2'],
        added: [],
      },
    ];

    const card = buildUnifiedDiffCard(changes);
    const elements = card.elements as any[];

    expect(elements[0].content).toContain('-line 1');
    expect(elements[0].content).toContain('-line 2');
  });

  it('should show added lines with + prefix', () => {
    const changes: CodeChange[] = [
      {
        filePath: '/path/to/file.ts',
        removed: [],
        added: ['line 1', 'line 2'],
      },
    ];

    const card = buildUnifiedDiffCard(changes);
    const elements = card.elements as any[];

    expect(elements[0].content).toContain('+line 1');
    expect(elements[0].content).toContain('+line 2');
  });

  it('should include diff header with line numbers', () => {
    const changes: CodeChange[] = [
      {
        filePath: '/path/to/file.ts',
        removed: ['old'],
        added: ['new'],
        oldLineStart: 10,
        newLineStart: 15,
      },
    ];

    const card = buildUnifiedDiffCard(changes);
    const elements = card.elements as any[];

    expect(elements[0].content).toContain('@@ -10,1 +15,1 @@');
  });

  it('should handle empty removed and added arrays', () => {
    const changes: CodeChange[] = [
      {
        filePath: '/path/to/file.ts',
        removed: [],
        added: [],
      },
    ];

    const card = buildUnifiedDiffCard(changes);

    expect(card.elements).toHaveLength(1);
  });

  it('should handle multiple changes', () => {
    const changes: CodeChange[] = [
      {
        filePath: '/path/to/file1.ts',
        removed: ['old1'],
        added: ['new1'],
      },
      {
        filePath: '/path/to/file2.ts',
        removed: ['old2'],
        added: ['new2'],
      },
    ];

    const card = buildUnifiedDiffCard(changes);
    const elements = card.elements as any[];

    // Should have 2 markdown elements + 1 hr (not 2 because last hr is removed)
    expect(elements.length).toBeGreaterThanOrEqual(2);
  });

  it('should escape HTML in file path', () => {
    const changes: CodeChange[] = [
      {
        filePath: '/path/to/<script>.ts',
        removed: ['old'],
        added: ['new'],
      },
    ];

    const card = buildUnifiedDiffCard(changes);
    const elements = card.elements as any[];

    expect(elements[0].content).toContain('&lt;script&gt;');
  });
});

describe('parseEditToolInput', () => {
  it('should parse valid Edit tool input with snake_case', () => {
    const input = {
      file_path: '/path/to/file.ts',
      old_string: 'old content',
      new_string: 'new content',
    };

    const result = parseEditToolInput(input);

    expect(result).not.toBeNull();
    expect(result?.filePath).toBe('/path/to/file.ts');
    expect(result?.removed).toEqual(['old content']);
    expect(result?.added).toEqual(['new content']);
  });

  it('should parse valid Edit tool input with camelCase', () => {
    const input = {
      filePath: '/path/to/file.ts',
      oldString: 'old content',
      newString: 'new content',
    };

    const result = parseEditToolInput(input);

    expect(result).not.toBeNull();
    expect(result?.filePath).toBe('/path/to/file.ts');
    expect(result?.removed).toEqual(['old content']);
    expect(result?.added).toEqual(['new content']);
  });

  it('should detect language from file extension', () => {
    const input = {
      file_path: '/path/to/file.ts',
      old_string: 'old',
      new_string: 'new',
    };

    const result = parseEditToolInput(input);

    expect(result?.language).toBe('typescript');
  });

  it('should return null for undefined input', () => {
    const result = parseEditToolInput(undefined);

    expect(result).toBeNull();
  });

  it('should return null for input without file_path', () => {
    const input = {
      old_string: 'old',
      new_string: 'new',
    };

    const result = parseEditToolInput(input);

    expect(result).toBeNull();
  });

  it('should handle missing old_string', () => {
    const input = {
      file_path: '/path/to/file.ts',
      new_string: 'new',
    };

    const result = parseEditToolInput(input);

    expect(result?.removed).toBeUndefined();
    expect(result?.added).toEqual(['new']);
  });

  it('should handle missing new_string', () => {
    const input = {
      file_path: '/path/to/file.ts',
      old_string: 'old',
    };

    const result = parseEditToolInput(input);

    expect(result?.removed).toEqual(['old']);
    expect(result?.added).toBeUndefined();
  });

  it('should split multiline strings into arrays', () => {
    const input = {
      file_path: '/path/to/file.ts',
      old_string: 'line 1\nline 2\nline 3',
      new_string: 'new 1\nnew 2\nnew 3',
    };

    const result = parseEditToolInput(input);

    expect(result?.removed).toEqual(['line 1', 'line 2', 'line 3']);
    expect(result?.added).toEqual(['new 1', 'new 2', 'new 3']);
  });

  it('should detect various file extensions', () => {
    const testCases = [
      { file: 'test.js', expected: 'javascript' },
      { file: 'test.ts', expected: 'typescript' },
      { file: 'test.py', expected: 'python' },
      { file: 'test.go', expected: 'go' },
      { file: 'test.rs', expected: 'rust' },
      { file: 'test.java', expected: 'java' },
      { file: 'test.cpp', expected: 'cpp' },
      { file: 'test.c', expected: 'c' },
      { file: 'test.sh', expected: 'bash' },
      { file: 'test.yaml', expected: 'yaml' },
      { file: 'test.yml', expected: 'yaml' },
      { file: 'test.json', expected: 'json' },
      { file: 'test.md', expected: 'markdown' },
      { file: 'test.html', expected: 'html' },
      { file: 'test.css', expected: 'css' },
      { file: 'test.vue', expected: 'vue' },
      { file: 'test.txt', expected: 'text' },
      { file: 'test.unknown', expected: 'text' },
    ];

    for (const testCase of testCases) {
      const input = {
        file_path: `/path/to/${testCase.file}`,
        old_string: 'old',
        new_string: 'new',
      };

      const result = parseEditToolInput(input);
      expect(result?.language).toBe(testCase.expected);
    }
  });
});
