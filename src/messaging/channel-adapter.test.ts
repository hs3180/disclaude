/**
 * Tests for Channel Adapter interface and utilities.
 *
 * Issue #515: Universal Message Format + Channel Adapters (Phase 2)
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CAPABILITIES,
  FEISHU_CAPABILITIES,
  CLI_CAPABILITIES,
  REST_CAPABILITIES,
  cardToText,
  truncateText,
  isContentTypeSupported,
  getFallbackContentType,
  negotiateContentType,
} from './channel-adapter.js';
import type { CardContent } from './universal-message.js';

describe('Channel Adapter', () => {
  describe('Capabilities', () => {
    it('should have correct default capabilities', () => {
      expect(DEFAULT_CAPABILITIES.supportsCard).toBe(false);
      expect(DEFAULT_CAPABILITIES.supportsThread).toBe(false);
      expect(DEFAULT_CAPABILITIES.supportsMarkdown).toBe(false);
      expect(DEFAULT_CAPABILITIES.maxMessageLength).toBe(4096);
    });

    it('should have correct Feishu capabilities', () => {
      expect(FEISHU_CAPABILITIES.supportsCard).toBe(true);
      expect(FEISHU_CAPABILITIES.supportsThread).toBe(true);
      expect(FEISHU_CAPABILITIES.supportsMarkdown).toBe(true);
      expect(FEISHU_CAPABILITIES.supportedContentTypes).toContain('card');
    });

    it('should have correct CLI capabilities', () => {
      expect(CLI_CAPABILITIES.supportsCard).toBe(false);
      expect(CLI_CAPABILITIES.supportsMarkdown).toBe(true);
      expect(CLI_CAPABILITIES.maxMessageLength).toBe(Infinity);
    });

    it('should have correct REST capabilities', () => {
      expect(REST_CAPABILITIES.supportsCard).toBe(true);
      expect(REST_CAPABILITIES.supportedContentTypes).toContain('done');
    });
  });

  describe('cardToText', () => {
    it('should convert a simple card to text', () => {
      const card: CardContent = {
        type: 'card',
        title: 'Task Complete',
        sections: [{ type: 'text', content: 'All done!' }],
      };
      const text = cardToText(card);
      expect(text).toContain('**Task Complete**');
      expect(text).toContain('All done!');
    });

    it('should include subtitle in text', () => {
      const card: CardContent = {
        type: 'card',
        title: 'Title',
        subtitle: 'Subtitle',
        sections: [],
      };
      const text = cardToText(card);
      expect(text).toContain('Subtitle');
    });

    it('should convert divider sections', () => {
      const card: CardContent = {
        type: 'card',
        title: 'Title',
        sections: [
          { type: 'text', content: 'Before' },
          { type: 'divider' },
          { type: 'text', content: 'After' },
        ],
      };
      const text = cardToText(card);
      expect(text).toContain('---');
    });

    it('should convert field sections', () => {
      const card: CardContent = {
        type: 'card',
        title: 'Title',
        sections: [
          {
            type: 'fields',
            fields: [
              { label: 'Name', value: 'John' },
              { label: 'Age', value: '30' },
            ],
          },
        ],
      };
      const text = cardToText(card);
      expect(text).toContain('**Name**: John');
      expect(text).toContain('**Age**: 30');
    });

    it('should convert actions', () => {
      const card: CardContent = {
        type: 'card',
        title: 'Title',
        sections: [],
        actions: [
          { type: 'button', label: 'OK', value: 'ok' },
          { type: 'button', label: 'Cancel', value: 'cancel' },
        ],
      };
      const text = cardToText(card);
      expect(text).toContain('[OK]');
      expect(text).toContain('[Cancel]');
    });

    it('should handle image sections', () => {
      const card: CardContent = {
        type: 'card',
        title: 'Title',
        sections: [{ type: 'image', imageUrl: 'https://example.com/image.png' }],
      };
      const text = cardToText(card);
      expect(text).toContain('[Image: https://example.com/image.png]');
    });
  });

  describe('truncateText', () => {
    it('should not truncate short text', () => {
      const text = 'Hello World';
      expect(truncateText(text, 100)).toBe(text);
    });

    it('should truncate long text with default suffix', () => {
      const text = 'This is a very long text that needs to be truncated';
      expect(truncateText(text, 20)).toBe('This is a very lo...');
    });

    it('should truncate with custom suffix', () => {
      const text = 'This is a very long text';
      expect(truncateText(text, 15, '…')).toBe('This is a very…');
    });
  });

  describe('isContentTypeSupported', () => {
    it('should return true for supported types', () => {
      expect(isContentTypeSupported(FEISHU_CAPABILITIES, 'card')).toBe(true);
      expect(isContentTypeSupported(CLI_CAPABILITIES, 'text')).toBe(true);
    });

    it('should return false for unsupported types', () => {
      expect(isContentTypeSupported(CLI_CAPABILITIES, 'card')).toBe(false);
      expect(isContentTypeSupported(DEFAULT_CAPABILITIES, 'markdown')).toBe(false);
    });
  });

  describe('getFallbackContentType', () => {
    it('should return same type if supported', () => {
      expect(getFallbackContentType(FEISHU_CAPABILITIES, 'card')).toBe('card');
    });

    it('should fallback card to markdown then text', () => {
      expect(getFallbackContentType(CLI_CAPABILITIES, 'card')).toBe('markdown');
    });

    it('should fallback markdown to text', () => {
      const caps = { ...DEFAULT_CAPABILITIES, supportedContentTypes: ['text'] };
      expect(getFallbackContentType(caps, 'markdown')).toBe('text');
    });

    it('should return null if no fallback available', () => {
      const caps = { ...DEFAULT_CAPABILITIES, supportedContentTypes: [] };
      expect(getFallbackContentType(caps, 'card')).toBeNull();
    });
  });

  describe('negotiateContentType', () => {
    it('should return first supported type', () => {
      const result = negotiateContentType(FEISHU_CAPABILITIES, ['card', 'text']);
      expect(result).toBe('card');
    });

    it('should skip unsupported types', () => {
      const result = negotiateContentType(CLI_CAPABILITIES, ['card', 'markdown', 'text']);
      expect(result).toBe('markdown');
    });

    it('should return null if no type is supported', () => {
      const caps = { ...DEFAULT_CAPABILITIES, supportedContentTypes: [] };
      const result = negotiateContentType(caps, ['card', 'markdown']);
      expect(result).toBeNull();
    });
  });
});
