/**
 * Tests for Feishu card validation utilities (src/mcp/utils/card-validator.ts)
 */

import { describe, it, expect } from 'vitest';
import {
  isValidFeishuCard,
  getCardValidationError,
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
      expect(getCardValidationError(null)).toBe('content is null');
    });

    it('should return error for undefined', () => {
      expect(getCardValidationError(undefined)).toBe('content is undefined, expected object');
    });

    it('should return error for string', () => {
      expect(getCardValidationError('string')).toBe('content is string, expected object');
    });

    it('should return error for number', () => {
      expect(getCardValidationError(42)).toBe('content is number, expected object');
    });

    it('should return error for boolean', () => {
      expect(getCardValidationError(true)).toBe('content is boolean, expected object');
    });

    it('should return error for array', () => {
      expect(getCardValidationError([1, 2, 3])).toBe('content is array, expected object with config/header/elements');
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

      expect(getCardValidationError(card)).toBe('header must be an object');
    });

    it('should report header is null', () => {
      const card = {
        config: {},
        header: null,
        elements: [],
      };

      expect(getCardValidationError(card)).toBe('header must be an object');
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

  describe('valid cards', () => {
    it('should return unknown error for valid card (edge case)', () => {
      // The function returns 'unknown validation error' when all checks pass
      // This happens because the validation logic in isValidFeishuCard
      // and getCardValidationError are slightly different
      const card = {
        config: {},
        header: { title: 'Title' },
        elements: [],
      };

      // When the card is actually valid, getCardValidationError returns 'unknown validation error'
      expect(getCardValidationError(card)).toBe('unknown validation error');
    });
  });
});
