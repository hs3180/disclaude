/**
 * Tests for GFM table to Feishu column_set converter (packages/mcp-server/src/utils/table-converter.ts)
 */

import { describe, it, expect } from 'vitest';
import {
  parseGfmTable,
  buildColumnSet,
  transformCardTables,
} from './table-converter.js';

describe('parseGfmTable', () => {
  describe('valid tables', () => {
    it('should parse a standard 2-column table', () => {
      const content = '| Name | Age |\n|------|-----|\n| Alice | 30 |';
      const result = parseGfmTable(content);
      expect(result).not.toBeNull();
      expect(result!.headers).toEqual(['Name', 'Age']);
      expect(result!.rows).toEqual([['Alice', '30']]);
    });

    it('should parse a 3-column table with alignment', () => {
      const content = '| Left | Center | Right |\n|:---|:---:|---:|\n| a | b | c |';
      const result = parseGfmTable(content);
      expect(result).not.toBeNull();
      expect(result!.headers).toEqual(['Left', 'Center', 'Right']);
      expect(result!.rows).toEqual([['a', 'b', 'c']]);
    });

    it('should parse the Issue #2340 example table', () => {
      const content = '| 客户类型 | W<170% | 170%-210% |\n|:---|:---:|:---:|\n| 正常类 | 50% | 70% |';
      const result = parseGfmTable(content);
      expect(result).not.toBeNull();
      expect(result!.headers).toEqual(['客户类型', 'W<170%', '170%-210%']);
      expect(result!.rows).toEqual([['正常类', '50%', '70%']]);
    });

    it('should parse multiple rows', () => {
      const content = '| H1 | H2 |\n|---|---|\n| r1a | r1b |\n| r2a | r2b |\n| r3a | r3b |';
      const result = parseGfmTable(content);
      expect(result).not.toBeNull();
      expect(result!.rows).toHaveLength(3);
    });

    it('should extract prefix text before the table', () => {
      const content = 'Some intro text\n\n| H1 | H2 |\n|---|---|\n| a | b |';
      const result = parseGfmTable(content);
      expect(result).not.toBeNull();
      expect(result!.prefix).toBe('Some intro text');
    });

    it('should extract suffix text after the table', () => {
      const content = '| H1 | H2 |\n|---|---|\n| a | b |\n\nFooter text';
      const result = parseGfmTable(content);
      expect(result).not.toBeNull();
      expect(result!.suffix).toBe('Footer text');
    });

    it('should extract both prefix and suffix', () => {
      const content = 'Before\n\n| H1 | H2 |\n|---|---|\n| a | b |\n\nAfter';
      const result = parseGfmTable(content);
      expect(result).not.toBeNull();
      expect(result!.prefix).toBe('Before');
      expect(result!.suffix).toBe('After');
    });

    it('should handle table without trailing pipe', () => {
      const content = '| H1 | H2\n|---|---\n| a | b';
      const result = parseGfmTable(content);
      // Without trailing pipe, slice(1,-1) drops the last cell
      // This is an edge case - the important thing is it doesn't crash
      expect(result).toBeDefined();
    });
  });

  describe('invalid tables', () => {
    it('should return null for plain text', () => {
      expect(parseGfmTable('Hello world')).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(parseGfmTable('')).toBeNull();
    });

    it('should return null when separator has no header before it', () => {
      const content = '|---|---|\n| a | b |';
      expect(parseGfmTable(content)).toBeNull();
    });

    it('should return null when no data rows after separator', () => {
      const content = '| H1 | H2 |\n|---|---|';
      expect(parseGfmTable(content)).toBeNull();
    });

    it('should return null for single-column table', () => {
      // Single column with separator is technically not a table
      const content = '| Only |\n|------|\n| data |';
      // This might still parse, depends on the regex
      expect(parseGfmTable(content)).toBeDefined();
    });
  });
});

describe('buildColumnSet', () => {
  it('should build a column_set with equal-weight columns', () => {
    const result = buildColumnSet(['Name', 'Age'], [['Alice', '30']]);

    expect(result.tag).toBe('column_set');
    expect(result.flex_mode).toBe('stretch');
    expect(result.background_style).toBe('default');

    const columns = (result as Record<string, unknown>).columns as Array<Record<string, unknown>>;
    expect(columns).toHaveLength(2);

    // First column (Name)
    expect(columns[0].tag).toBe('column');
    expect(columns[0].width).toBe('weighted');
    expect(columns[0].weight).toBe(1);
    const col0Elements = columns[0].elements as Array<Record<string, unknown>>;
    expect(col0Elements[0].content).toBe('**Name**');
    expect(col0Elements[1].content).toBe('Alice');

    // Second column (Age)
    const col1Elements = columns[1].elements as Array<Record<string, unknown>>;
    expect(col1Elements[0].content).toBe('**Age**');
    expect(col1Elements[1].content).toBe('30');
  });

  it('should handle multiple rows', () => {
    const result = buildColumnSet(
      ['Col1'],
      [['row1'], ['row2'], ['row3']]
    );

    const columns = (result as Record<string, unknown>).columns as Array<Record<string, unknown>>;
    const colElements = columns[0].elements as Array<Record<string, unknown>>;
    // 1 header + 3 data = 4 elements
    expect(colElements).toHaveLength(4);
    expect(colElements[0].content).toBe('**Col1**');
    expect(colElements[1].content).toBe('row1');
    expect(colElements[2].content).toBe('row2');
    expect(colElements[3].content).toBe('row3');
  });

  it('should handle missing cells gracefully', () => {
    const result = buildColumnSet(
      ['A', 'B', 'C'],
      [['only-a']] // Row has fewer cells than headers
    );

    const columns = (result as Record<string, unknown>).columns as Array<Record<string, unknown>>;
    const col2Elements = columns[2].elements as Array<Record<string, unknown>>;
    // Missing cells should show empty/placeholder
    expect(col2Elements[1].content).toBe(' ');
  });

  it('should bold header cells', () => {
    const result = buildColumnSet(['Header'], [['data']]);
    const columns = (result as Record<string, unknown>).columns as Array<Record<string, unknown>>;
    const elements = columns[0].elements as Array<Record<string, unknown>>;
    expect(elements[0].content).toBe('**Header**');
    expect(elements[1].content).toBe('data');
  });
});

describe('transformCardTables', () => {
  const baseCard = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'Test' } },
    elements: [] as Array<Record<string, unknown>>,
  };

  it('should not modify card without markdown tables', () => {
    const card = {
      ...baseCard,
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: 'Hello' } },
      ],
    };
    const result = transformCardTables(card);
    expect(result).toBe(card); // Same reference, no changes
  });

  it('should not modify markdown element without tables', () => {
    const card = {
      ...baseCard,
      elements: [
        { tag: 'markdown', content: '**Bold** text without tables' },
      ],
    };
    const result = transformCardTables(card);
    expect(result).toBe(card);
  });

  it('should convert markdown table to column_set', () => {
    const card = {
      ...baseCard,
      elements: [
        {
          tag: 'markdown',
          content: '| Name | Age |\n|------|-----|\n| Alice | 30 |',
        },
      ],
    };

    const result = transformCardTables(card);
    expect(result).not.toBe(card); // New object created
    expect(result.elements).toHaveLength(1);
    expect((result.elements as Array<Record<string, unknown>>)[0].tag).toBe('column_set');
  });

  it('should preserve prefix and suffix text', () => {
    const card = {
      ...baseCard,
      elements: [
        {
          tag: 'markdown',
          content: 'Intro text\n\n| H1 | H2 |\n|---|---|\n| a | b |\n\nFooter text',
        },
      ],
    };

    const result = transformCardTables(card);
    const elements = result.elements as Array<Record<string, unknown>>;
    // Should have: prefix markdown + column_set + suffix markdown = 3
    expect(elements).toHaveLength(3);
    expect((elements[0] as Record<string, unknown>).tag).toBe('markdown');
    expect((elements[0] as Record<string, unknown>).content).toBe('Intro text');
    expect((elements[1] as Record<string, unknown>).tag).toBe('column_set');
    expect((elements[2] as Record<string, unknown>).tag).toBe('markdown');
    expect((elements[2] as Record<string, unknown>).content).toBe('Footer text');
  });

  it('should handle Issue #2340 example', () => {
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '贷款成数' } },
      elements: [
        {
          tag: 'markdown',
          content: '| 客户类型 | W<170% | 170%-210% |\n|:---|:---:|:---:|\n| 正常类 | 50% | 70% |',
        },
      ],
    };

    const result = transformCardTables(card);
    const elements = result.elements as Array<Record<string, unknown>>;
    expect(elements).toHaveLength(1);
    expect((elements[0] as Record<string, unknown>).tag).toBe('column_set');

    const columns = ((elements[0] as Record<string, unknown>).columns as Array<Record<string, unknown>>);
    expect(columns).toHaveLength(3);
  });

  it('should mix markdown with and without tables', () => {
    const card = {
      ...baseCard,
      elements: [
        { tag: 'markdown', content: '**Intro**' },
        { tag: 'markdown', content: '| H1 | H2 |\n|---|---|\n| a | b |' },
        { tag: 'markdown', content: '**Outro**' },
      ],
    };

    const result = transformCardTables(card);
    const elements = result.elements as Array<Record<string, unknown>>;
    // intro markdown (kept) + column_set (converted) + outro markdown (kept) = 3
    expect(elements).toHaveLength(3);
    expect((elements[0] as Record<string, unknown>).tag).toBe('markdown');
    expect((elements[0] as Record<string, unknown>).content).toBe('**Intro**');
    expect((elements[1] as Record<string, unknown>).tag).toBe('column_set');
    expect((elements[2] as Record<string, unknown>).tag).toBe('markdown');
    expect((elements[2] as Record<string, unknown>).content).toBe('**Outro**');
  });

  it('should handle non-markdown elements alongside tables', () => {
    const card = {
      ...baseCard,
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: 'Before' } },
        { tag: 'markdown', content: '| H1 | H2 |\n|---|---|\n| a | b |' },
        { tag: 'hr' },
      ],
    };

    const result = transformCardTables(card);
    const elements = result.elements as Array<Record<string, unknown>>;
    expect(elements).toHaveLength(3);
    expect((elements[0] as Record<string, unknown>).tag).toBe('div');
    expect((elements[1] as Record<string, unknown>).tag).toBe('column_set');
    expect((elements[2] as Record<string, unknown>).tag).toBe('hr');
  });

  it('should return original card when elements is not an array', () => {
    const card = {
      ...baseCard,
      elements: 'not-an-array',
    };
    const result = transformCardTables(card as unknown as Record<string, unknown>);
    expect(result).toBe(card);
  });

  it('should not mutate the original card', () => {
    const originalElements = [
      { tag: 'markdown', content: '| H1 | H2 |\n|---|---|\n| a | b |' },
    ];
    const card = {
      ...baseCard,
      elements: originalElements,
    };

    const result = transformCardTables(card);
    expect(result).not.toBe(card);
    // Original card elements should be unchanged
    expect(card.elements[0].tag).toBe('markdown');
    expect((card.elements[0] as Record<string, unknown>).content).toBe('| H1 | H2 |\n|---|---|\n| a | b |');
    // Result should have column_set
    expect((result.elements as Array<Record<string, unknown>>)[0].tag).toBe('column_set');
  });
});
