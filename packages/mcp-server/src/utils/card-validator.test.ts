/**
 * Tests for Feishu card validation utilities (packages/mcp-server/src/utils/card-validator.ts)
 */

import { describe, it, expect } from 'vitest';
import {
  isValidFeishuCard,
  getCardValidationError,
  detectMarkdownTableWarnings,
  containsGfmTable,
} from './card-validator.js';

describe('isValidFeishuCard', () => {
  describe('valid cards', () => {
    it('should return true for a valid card with config, header, and elements', () => {
      const card = {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: 'Test Title' },
        },
        elements: [
          { tag: 'div', text: { tag: 'plain_text', content: 'Content' } },
        ],
      };

      expect(isValidFeishuCard(card)).toBe(true);
    });

    it('should return true for a minimal valid card', () => {
      const card = {
        config: {},
        header: { title: 'Simple Title' },
        elements: [],
      };

      expect(isValidFeishuCard(card)).toBe(true);
    });

    it('should return true for card with complex header', () => {
      const card = {
        config: { enable_forward: true },
        header: {
          title: { tag: 'plain_text', content: 'Title' },
          subtitle: { tag: 'plain_text', content: 'Subtitle' },
          template: 'blue',
        },
        elements: [],
      };

      expect(isValidFeishuCard(card)).toBe(true);
    });
  });

  describe('invalid cards - missing required fields', () => {
    it('should return false when config is missing', () => {
      const card = {
        header: { title: 'Title' },
        elements: [],
      };

      expect(isValidFeishuCard(card)).toBe(false);
    });

    it('should return false when header is missing', () => {
      const card = {
        config: {},
        elements: [],
      };

      expect(isValidFeishuCard(card)).toBe(false);
    });

    it('should return false when elements is missing', () => {
      const card = {
        config: {},
        header: { title: 'Title' },
      };

      expect(isValidFeishuCard(card)).toBe(false);
    });

    it('should return false when header.title is missing', () => {
      const card = {
        config: {},
        header: { subtitle: 'No title' },
        elements: [],
      };

      expect(isValidFeishuCard(card)).toBe(false);
    });
  });

  describe('invalid cards - wrong types', () => {
    it('should return false when elements is not an array', () => {
      const card = {
        config: {},
        header: { title: 'Title' },
        elements: 'not-an-array',
      };

      expect(isValidFeishuCard(card)).toBe(false);
    });

    it('should return false when header is not an object', () => {
      const card = {
        config: {},
        header: 'not-an-object',
        elements: [],
      };

      expect(isValidFeishuCard(card)).toBe(false);
    });

    it('should return false when header is null', () => {
      const card = {
        config: {},
        header: null,
        elements: [],
      };

      expect(isValidFeishuCard(card)).toBe(false);
    });
  });

  describe('non-object inputs', () => {
    it('should return false for null', () => {
      expect(isValidFeishuCard(null as unknown as Record<string, unknown>)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isValidFeishuCard(undefined as unknown as Record<string, unknown>)).toBe(false);
    });

    it('should return false for string', () => {
      expect(isValidFeishuCard('not an object' as unknown as Record<string, unknown>)).toBe(false);
    });

    it('should return false for number', () => {
      expect(isValidFeishuCard(123 as unknown as Record<string, unknown>)).toBe(false);
    });

    it('should return false for array', () => {
      expect(isValidFeishuCard([] as unknown as Record<string, unknown>)).toBe(false);
    });
  });
});

describe('getCardValidationError', () => {
  describe('null and non-object inputs', () => {
    it('should return error for null', () => {
      expect(getCardValidationError(null)).toBe('card is null - must be an object with config/header/elements');
    });

    it('should return error for undefined', () => {
      expect(getCardValidationError(undefined)).toBe('card is undefined - must be an object with config/header/elements');
    });

    it('should return error for string', () => {
      expect(getCardValidationError('string')).toBe('card is string - must be an object with config/header/elements');
    });

    it('should return error for number', () => {
      expect(getCardValidationError(42)).toBe('card is number - must be an object with config/header/elements');
    });

    it('should return error for boolean', () => {
      expect(getCardValidationError(true)).toBe('card is boolean - must be an object with config/header/elements');
    });

    it('should return error for array', () => {
      expect(getCardValidationError([1, 2, 3])).toBe('card is an array - must be an object with config/header/elements, not an array');
    });
  });

  describe('missing required fields', () => {
    it('should report missing config', () => {
      const card = {
        header: { title: 'Title' },
        elements: [],
      };

      expect(getCardValidationError(card)).toBe('missing required fields: config');
    });

    it('should report missing header', () => {
      const card = {
        config: {},
        elements: [],
      };

      expect(getCardValidationError(card)).toBe('missing required fields: header');
    });

    it('should report missing elements', () => {
      const card = {
        config: {},
        header: { title: 'Title' },
      };

      expect(getCardValidationError(card)).toBe('missing required fields: elements');
    });

    it('should report multiple missing fields', () => {
      const card = {
        elements: [],
      };

      expect(getCardValidationError(card)).toBe('missing required fields: config, header');
    });

    it('should report all missing fields', () => {
      const card = {};

      expect(getCardValidationError(card)).toBe('missing required fields: config, header, elements');
    });
  });

  describe('header validation', () => {
    it('should report header is not an object', () => {
      const card = {
        config: {},
        header: 'not-an-object',
        elements: [],
      };

      expect(getCardValidationError(card)).toBe('header must be an object with title');
    });

    it('should report header is null', () => {
      const card = {
        config: {},
        header: null,
        elements: [],
      };

      expect(getCardValidationError(card)).toBe('header must be an object with title');
    });

    it('should report missing header.title', () => {
      const card = {
        config: {},
        header: { subtitle: 'No title' },
        elements: [],
      };

      expect(getCardValidationError(card)).toBe('header.title is missing');
    });
  });

  describe('elements validation', () => {
    it('should report elements is not an array', () => {
      const card = {
        config: {},
        header: { title: 'Title' },
        elements: 'not-an-array',
      };

      expect(getCardValidationError(card)).toBe('elements must be an array');
    });

    it('should report elements is an object', () => {
      const card = {
        config: {},
        header: { title: 'Title' },
        elements: { 0: 'item' },
      };

      expect(getCardValidationError(card)).toBe('elements must be an array');
    });
  });

  describe('config validation', () => {
    it('should report config is not an object', () => {
      const card = {
        config: 'not-an-object',
        header: { title: 'Title' },
        elements: [],
      };

      expect(getCardValidationError(card)).toBe('config must be an object');
    });

    it('should report config is null', () => {
      const card = {
        config: null,
        header: { title: 'Title' },
        elements: [],
      };

      expect(getCardValidationError(card)).toBe('config must be an object');
    });
  });

  describe('valid cards', () => {
    it('should return generic error message for valid card (edge case)', () => {
      // When the card is actually valid, getCardValidationError returns a generic message
      const card = {
        config: {},
        header: { title: 'Title' },
        elements: [],
      };

      expect(getCardValidationError(card)).toBe('invalid card structure - ensure card has config (object), header (object with title), and elements (array)');
    });
  });
});

describe('containsGfmTable', () => {
  describe('tables with separator rows', () => {
    it('should detect a standard GFM table with separator', () => {
      const content = '| Header 1 | Header 2 |\n|:---|:---:|\n| data 1 | data 2 |';
      expect(containsGfmTable(content)).toBe(true);
    });

    it('should detect a table with dashed separator (no colons)', () => {
      const content = '| Name | Age |\n|------|-----|\n| Alice | 30 |';
      expect(containsGfmTable(content)).toBe(true);
    });

    it('should detect a table with centered alignment', () => {
      const content = '| col1 | col2 | col3 |\n|:---:|:---:|:---:|';
      expect(containsGfmTable(content)).toBe(true);
    });

    it('should detect table from Issue #2340 example', () => {
      const content = '| 客户类型 | W<170% | 170%-210% |\n|:---|:---:|:---:|\n| 正常类 | 50% | 70% |';
      expect(containsGfmTable(content)).toBe(true);
    });
  });

  describe('tables without separator rows (consecutive pipe rows)', () => {
    it('should detect 3+ consecutive pipe-delimited rows', () => {
      const content = '| row1 col1 | row1 col2 |\n| row2 col1 | row2 col2 |\n| row3 col1 | row3 col2 |';
      expect(containsGfmTable(content)).toBe(true);
    });

    it('should NOT detect 2 consecutive pipe-delimited rows', () => {
      const content = '| row1 col1 | row1 col2 |\n| row2 col1 | row2 col2 |';
      expect(containsGfmTable(content)).toBe(false);
    });
  });

  describe('non-table content', () => {
    it('should return false for plain text', () => {
      expect(containsGfmTable('Hello, world!')).toBe(false);
    });

    it('should return false for markdown with pipes in code blocks', () => {
      // A single code line with pipe is not a table
      expect(containsGfmTable('Use `|` for pipes in shell')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(containsGfmTable('')).toBe(false);
    });

    it('should return false for a single pipe line', () => {
      expect(containsGfmTable('| just | one | line |')).toBe(false);
    });
  });
});

describe('detectMarkdownTableWarnings', () => {
  const baseCard = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'Test' } },
    elements: [] as Array<Record<string, unknown>>,
  };

  it('should return empty array when no markdown elements exist', () => {
    const card = {
      ...baseCard,
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: 'Content' } },
      ],
    };
    expect(detectMarkdownTableWarnings(card)).toEqual([]);
  });

  it('should return empty array for markdown without tables', () => {
    const card = {
      ...baseCard,
      elements: [
        { tag: 'markdown', content: '**Bold** and *italic* text' },
      ],
    };
    expect(detectMarkdownTableWarnings(card)).toEqual([]);
  });

  it('should return warning for markdown element with GFM table', () => {
    const card = {
      ...baseCard,
      elements: [
        { tag: 'markdown', content: '| H1 | H2 |\n|---|---|\n| d1 | d2 |' },
      ],
    };
    const warnings = detectMarkdownTableWarnings(card);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('GFM table syntax');
    expect(warnings[0]).toContain('NOT supported');
    expect(warnings[0]).toContain('column_set');
  });

  it('should return warning for the exact Issue #2340 example', () => {
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '贷款成数' } },
      elements: [
        { tag: 'markdown', content: '| 客户类型 | W<170% | 170%-210% |\n|:---|:---:|:---:|\n| 正常类 | 50% | 70% |' },
      ],
    };
    const warnings = detectMarkdownTableWarnings(card);
    expect(warnings).toHaveLength(1);
  });

  it('should return multiple warnings for multiple markdown tables', () => {
    const card = {
      ...baseCard,
      elements: [
        { tag: 'markdown', content: '| A | B |\n|---|---|\n| 1 | 2 |' },
        { tag: 'div', text: { tag: 'plain_text', content: 'separator' } },
        { tag: 'markdown', content: '| X | Y |\n|---|---|\n| 3 | 4 |' },
      ],
    };
    expect(detectMarkdownTableWarnings(card)).toHaveLength(2);
  });

  it('should return empty array when elements is not an array', () => {
    const card = {
      ...baseCard,
      elements: 'not-an-array' as unknown as Array<Record<string, unknown>>,
    };
    expect(detectMarkdownTableWarnings(card)).toEqual([]);
  });

  it('should handle markdown element with non-string content', () => {
    const card = {
      ...baseCard,
      elements: [
        { tag: 'markdown', content: 42 },
      ],
    };
    expect(detectMarkdownTableWarnings(card)).toEqual([]);
  });

  it('should handle markdown element with undefined content', () => {
    const card = {
      ...baseCard,
      elements: [
        { tag: 'markdown' },
      ],
    };
    expect(detectMarkdownTableWarnings(card)).toEqual([]);
  });
});
