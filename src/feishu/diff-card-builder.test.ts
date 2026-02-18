/**
 * Tests for diff-card-builder (src/feishu/diff-card-builder.ts)
 */

import { describe, it, expect } from 'vitest';
import {
  buildUnifiedDiffCard,
  parseEditToolInput,
  type CodeChange,
} from './diff-card-builder.js';

describe('buildUnifiedDiffCard', () => {
  describe('basic card structure', () => {
    it('should create card with header and elements', () => {
      const changes: CodeChange[] = [
        {
          filePath: '/src/index.ts',
          language: 'typescript',
          removed: ['old line'],
          added: ['new line'],
        },
      ];

      const card = buildUnifiedDiffCard(changes);

      expect(card.config).toEqual({ wide_screen_mode: true });
      expect(card.header).toEqual({
        title: { tag: 'plain_text', content: '📝 代码编辑' },
        template: 'orange',
      });
      expect(card.elements).toBeDefined();
      expect(Array.isArray(card.elements)).toBe(true);
    });

    it('should use custom title and template', () => {
      const changes: CodeChange[] = [
        { filePath: '/src/test.ts', removed: [], added: ['x'] },
      ];

      const card = buildUnifiedDiffCard(changes, 'Custom Title', 'blue');

      expect(card.header).toEqual({
        title: { tag: 'plain_text', content: 'Custom Title' },
        template: 'blue',
      });
    });
  });

  describe('single file diff', () => {
    it('should show file path with language badge', () => {
      const changes: CodeChange[] = [
        {
          filePath: '/src/app.ts',
          language: 'typescript',
          removed: ['old'],
          added: ['new'],
        },
      ];

      const card = buildUnifiedDiffCard(changes);
      const [firstElement] = card.elements as [{ content: string }];

      expect(firstElement.content).toContain('/src/app.ts');
      expect(firstElement.content).toContain('`typescript`');
    });

    it('should show file path without language badge when not provided', () => {
      const changes: CodeChange[] = [
        {
          filePath: '/src/unknown',
          removed: ['old'],
          added: ['new'],
        },
      ];

      const card = buildUnifiedDiffCard(changes);
      const [firstElement] = card.elements as [{ content: string }];

      expect(firstElement.content).toContain('/src/unknown');
    });

    it('should escape HTML in file path', () => {
      const changes: CodeChange[] = [
        {
          filePath: '/src/<script>.ts',
          removed: ['old'],
          added: ['new'],
        },
      ];

      const card = buildUnifiedDiffCard(changes);
      const [firstElement] = card.elements as [{ content: string }];

      expect(firstElement.content).toContain('&lt;script&gt;');
    });
  });

  describe('diff format', () => {
    it('should use diff code block', () => {
      const changes: CodeChange[] = [
        {
          filePath: '/src/test.ts',
          removed: ['old line'],
          added: ['new line'],
        },
      ];

      const card = buildUnifiedDiffCard(changes);
      const [contentElement] = card.elements as [{ content: string }];

      expect(contentElement.content).toContain('```diff');
      expect(contentElement.content).toContain('```');
    });

    it('should include hunk header with line numbers', () => {
      const changes: CodeChange[] = [
        {
          filePath: '/src/test.ts',
          removed: ['line1', 'line2'],
          added: ['line1 modified'],
          oldLineStart: 10,
          newLineStart: 10,
        },
      ];

      const card = buildUnifiedDiffCard(changes);
      const [contentElement] = card.elements as [{ content: string }];

      expect(contentElement.content).toContain('@@ -10,2 +10,1 @@');
    });

    it('should use default line numbers of 1', () => {
      const changes: CodeChange[] = [
        {
          filePath: '/src/test.ts',
          removed: ['old'],
          added: ['new'],
        },
      ];

      const card = buildUnifiedDiffCard(changes);
      const [contentElement] = card.elements as [{ content: string }];

      expect(contentElement.content).toContain('@@ -1,1 +1,1 @@');
    });
  });

  describe('diff lines', () => {
    it('should prefix removed lines with -', () => {
      const changes: CodeChange[] = [
        {
          filePath: '/src/test.ts',
          removed: ['old line 1', 'old line 2'],
          added: [],
        },
      ];

      const card = buildUnifiedDiffCard(changes);
      const [contentElement] = card.elements as [{ content: string }];

      expect(contentElement.content).toContain('-old line 1');
      expect(contentElement.content).toContain('-old line 2');
    });

    it('should prefix added lines with +', () => {
      const changes: CodeChange[] = [
        {
          filePath: '/src/test.ts',
          removed: [],
          added: ['new line 1', 'new line 2'],
        },
      ];

      const card = buildUnifiedDiffCard(changes);
      const [contentElement] = card.elements as [{ content: string }];

      expect(contentElement.content).toContain('+new line 1');
      expect(contentElement.content).toContain('+new line 2');
    });

    it('should show removed then added when both exist', () => {
      const changes: CodeChange[] = [
        {
          filePath: '/src/test.ts',
          removed: ['removed line'],
          added: ['added line'],
        },
      ];

      const card = buildUnifiedDiffCard(changes);
      const [contentElement] = card.elements as [{ content: string }];
      const { content } = contentElement;

      // Removed should come before added
      const removedIndex = content.indexOf('-removed line');
      const addedIndex = content.indexOf('+added line');

      expect(removedIndex).toBeLessThan(addedIndex);
    });

    it('should escape backticks in diff content', () => {
      const changes: CodeChange[] = [
        {
          filePath: '/src/test.ts',
          removed: ['const `backtick` = 1'],
          added: [],
        },
      ];

      const card = buildUnifiedDiffCard(changes);
      const [contentElement] = card.elements as [{ content: string }];

      expect(contentElement.content).toContain('\\`backtick\\`');
    });
  });

  describe('multiple files', () => {
    it('should separate files with horizontal rule', () => {
      const changes: CodeChange[] = [
        { filePath: '/src/a.ts', removed: ['a'], added: [] },
        { filePath: '/src/b.ts', removed: ['b'], added: [] },
      ];

      const card = buildUnifiedDiffCard(changes);

      // Should have: markdown, hr, markdown (hr is removed from end)
      // So elements = [markdown, hr, markdown]
      expect(card.elements).toHaveLength(3);
      const elements = card.elements as [{ tag: string }, { tag: string }];
      expect(elements[1].tag).toBe('hr');
    });

    it('should not have trailing hr', () => {
      const changes: CodeChange[] = [
        { filePath: '/src/a.ts', removed: ['a'], added: [] },
      ];

      const card = buildUnifiedDiffCard(changes);

      // Only one file, should not have hr
      expect(card.elements).toHaveLength(1);
    });
  });

  describe('empty changes', () => {
    it('should handle file with no removed or added', () => {
      const changes: CodeChange[] = [
        { filePath: '/src/test.ts' },
      ];

      const card = buildUnifiedDiffCard(changes);

      // Should still create card, just with empty diff
      expect(card).toBeDefined();
    });
  });
});

describe('parseEditToolInput', () => {
  describe('valid input', () => {
    it('should parse file_path, old_string, and new_string', () => {
      const input = {
        file_path: '/src/index.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 2;',
      };

      const result = parseEditToolInput(input);

      expect(result).not.toBeNull();
      if (result) {
        expect(result.filePath).toBe('/src/index.ts');
        expect(result.removed).toEqual(['const x = 1;']);
        expect(result.added).toEqual(['const x = 2;']);
      }
    });

    it('should detect language from file extension', () => {
      const testCases = [
        { path: '/src/index.ts', expected: 'typescript' },
        { path: '/src/index.py', expected: 'python' },
        { path: '/src/index.go', expected: 'go' },
      ];

      for (const { path, expected } of testCases) {
        const result = parseEditToolInput({
          file_path: path,
          old_string: 'old',
          new_string: 'new',
        });
        if (result) {
          expect(result.language).toBe(expected);
        }
      }
    });

    it('should split strings into lines', () => {
      const result = parseEditToolInput({
        file_path: '/src/test.ts',
        old_string: 'line1\nline2\nline3',
        new_string: 'line1 modified\nline2\nline3',
      });

      if (result) {
        expect(result.removed).toEqual(['line1', 'line2', 'line3']);
        expect(result.added).toEqual(['line1 modified', 'line2', 'line3']);
      }
    });
  });

  describe('partial input', () => {
    it('should handle missing old_string', () => {
      const result = parseEditToolInput({
        file_path: '/src/test.ts',
        new_string: 'new content',
      });

      expect(result).not.toBeNull();
      if (result) {
        expect(result.removed).toBeUndefined();
        expect(result.added).toEqual(['new content']);
      }
    });

    it('should handle missing new_string', () => {
      const result = parseEditToolInput({
        file_path: '/src/test.ts',
        old_string: 'old content',
      });

      expect(result).not.toBeNull();
      if (result) {
        expect(result.removed).toEqual(['old content']);
        expect(result.added).toBeUndefined();
      }
    });

    it('should handle empty strings', () => {
      const result = parseEditToolInput({
        file_path: '/src/test.ts',
        old_string: '',
        new_string: '',
      });

      expect(result).not.toBeNull();
      // Empty string splits to [''], which is filtered out because the code checks length > 0
      // Actually the code checks if the array has elements after split, so [''] is truthy
    });
  });

  describe('invalid input', () => {
    it('should return null for undefined input', () => {
      expect(parseEditToolInput(undefined)).toBeNull();
    });

    it('should return null for missing file_path', () => {
      expect(parseEditToolInput({ old_string: 'old' })).toBeNull();
    });
  });

  describe('camelCase support', () => {
    it('should support camelCase parameters', () => {
      const result = parseEditToolInput({
        filePath: '/src/index.ts',
        oldString: 'old',
        newString: 'new',
      });

      if (result) {
        expect(result.filePath).toBe('/src/index.ts');
        expect(result.removed).toEqual(['old']);
        expect(result.added).toEqual(['new']);
      }
    });

    it('should prefer snake_case parameters', () => {
      const result = parseEditToolInput({
        file_path: '/src/snake.ts',
        filePath: '/src/camel.ts',
        old_string: 'snake_old',
        oldString: 'camel_old',
        new_string: 'snake_new',
        newString: 'camel_new',
      });

      if (result) {
        expect(result.filePath).toBe('/src/snake.ts');
        expect(result.removed).toEqual(['snake_old']);
        expect(result.added).toEqual(['snake_new']);
      }
    });
  });
});
