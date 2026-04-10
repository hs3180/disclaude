/**
 * Tests for channel-adapter utilities
 *
 * Covers:
 * - cardToText(): card content to text conversion
 * - truncateText(): text truncation
 * - isContentTypeSupported(): content type checking
 * - getFallbackContentType(): fallback type selection
 * - negotiateContentType(): best type negotiation
 *
 * @see Issue #1617 Phase 4
 */

import { describe, it, expect } from 'vitest';
import {
  cardToText,
  truncateText,
  isContentTypeSupported,
  getFallbackContentType,
  negotiateContentType,
  DEFAULT_CAPABILITIES,
  FEISHU_CAPABILITIES,
  CLI_CAPABILITIES,
  REST_CAPABILITIES as _REST_CAPABILITIES,
} from './channel-adapter.js';
import type { CardContent } from '@disclaude/core';

describe('cardToText', () => {
  it('should convert card with title and text section', () => {
    const card: CardContent = {
      type: 'card',
      title: 'Test Card',
      sections: [{ type: 'text', content: 'Hello world' }],
    };

    const text = cardToText(card);
    expect(text).toContain('**Test Card**');
    expect(text).toContain('Hello world');
  });

  it('should include subtitle when present', () => {
    const card: CardContent = {
      type: 'card',
      title: 'Card',
      subtitle: 'A subtitle',
      sections: [],
    };

    const text = cardToText(card);
    expect(text).toContain('A subtitle');
  });

  it('should handle markdown sections', () => {
    const card: CardContent = {
      type: 'card',
      title: 'Card',
      sections: [{ type: 'markdown', content: '**bold** text' }],
    };

    const text = cardToText(card);
    expect(text).toContain('**bold** text');
  });

  it('should handle divider sections', () => {
    const card: CardContent = {
      type: 'card',
      title: 'Card',
      sections: [{ type: 'divider' }],
    };

    const text = cardToText(card);
    expect(text).toContain('---');
  });

  it('should handle field sections', () => {
    const card: CardContent = {
      type: 'card',
      title: 'Card',
      sections: [{
        type: 'fields',
        fields: [
          { label: 'Name', value: 'Test' },
          { label: 'Status', value: 'OK' },
        ],
      }],
    };

    const text = cardToText(card);
    expect(text).toContain('**Name**: Test');
    expect(text).toContain('**Status**: OK');
  });

  it('should handle image sections', () => {
    const card: CardContent = {
      type: 'card',
      title: 'Card',
      sections: [{ type: 'image', imageUrl: 'https://example.com/img.png' }],
    };

    const text = cardToText(card);
    expect(text).toContain('[Image: https://example.com/img.png]');
  });

  it('should handle actions', () => {
    const card: CardContent = {
      type: 'card',
      title: 'Card',
      sections: [],
      actions: [
        { type: 'button', label: 'Approve', value: 'approve' },
        { type: 'button', label: 'Reject', value: 'reject' },
      ],
    };

    const text = cardToText(card);
    expect(text).toContain('[Approve]');
    expect(text).toContain('[Reject]');
    expect(text).toContain('**Actions:**');
  });

  it('should handle empty card', () => {
    const card: CardContent = {
      type: 'card',
      title: 'Empty',
      sections: [],
    };

    const text = cardToText(card);
    expect(text).toContain('**Empty**');
  });
});

describe('truncateText', () => {
  it('should not truncate short text', () => {
    expect(truncateText('Hello', 10)).toBe('Hello');
  });

  it('should truncate long text with default suffix', () => {
    const result = truncateText('Hello World', 8);
    expect(result).toBe('Hello...');
    expect(result.length).toBe(8);
  });

  it('should truncate with custom suffix', () => {
    const result = truncateText('Hello World', 9, '…');
    expect(result).toBe('Hello Wo…');
  });

  it('should handle exact length text', () => {
    expect(truncateText('Hello', 5)).toBe('Hello');
  });
});

describe('isContentTypeSupported', () => {
  it('should return true for supported content type', () => {
    expect(isContentTypeSupported(FEISHU_CAPABILITIES, 'text')).toBe(true);
    expect(isContentTypeSupported(FEISHU_CAPABILITIES, 'card')).toBe(true);
  });

  it('should return false for unsupported content type', () => {
    expect(isContentTypeSupported(DEFAULT_CAPABILITIES, 'card')).toBe(false);
  });
});

describe('getFallbackContentType', () => {
  it('should return original type when supported', () => {
    expect(getFallbackContentType(FEISHU_CAPABILITIES, 'text')).toBe('text');
    expect(getFallbackContentType(FEISHU_CAPABILITIES, 'card')).toBe('card');
  });

  it('should fallback card to markdown then text', () => {
    const caps = { ...CLI_CAPABILITIES }; // supports text, markdown
    expect(getFallbackContentType(caps, 'card')).toBe('markdown');
  });

  it('should fallback card to text when markdown not supported', () => {
    expect(getFallbackContentType(DEFAULT_CAPABILITIES, 'card')).toBe('text');
  });

  it('should fallback markdown to text', () => {
    expect(getFallbackContentType(DEFAULT_CAPABILITIES, 'markdown')).toBe('text');
  });

  it('should fallback file to text', () => {
    expect(getFallbackContentType(DEFAULT_CAPABILITIES, 'file')).toBe('text');
  });

  it('should return text for unknown content types', () => {
    expect(getFallbackContentType(DEFAULT_CAPABILITIES, 'unknown')).toBe('text');
  });

  it('should return null when no fallback available', () => {
    const noCaps = {
      ...DEFAULT_CAPABILITIES,
      supportedContentTypes: [],
    };
    expect(getFallbackContentType(noCaps, 'text')).toBeNull();
  });
});

describe('negotiateContentType', () => {
  it('should return first supported type', () => {
    expect(negotiateContentType(FEISHU_CAPABILITIES, ['card', 'text'])).toBe('card');
  });

  it('should fallback when preferred not supported', () => {
    expect(negotiateContentType(DEFAULT_CAPABILITIES, ['card'])).toBe('text');
  });

  it('should return null when nothing is supported', () => {
    const noCaps = {
      ...DEFAULT_CAPABILITIES,
      supportedContentTypes: [],
    };
    expect(negotiateContentType(noCaps, ['card'])).toBeNull();
  });
});
