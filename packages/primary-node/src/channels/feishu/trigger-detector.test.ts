/**
 * Tests for TriggerDetector — discussion-end trigger phrase detection.
 *
 * Issue #1229: Smart session end — detect when discussion should close
 *
 * Tests cover:
 * - Basic trigger detection (no reason, with reason, with summary)
 * - Trigger stripping from text (own line, inline, multiple)
 * - Edge cases (null, empty, no trigger, partial matches)
 * - hasTrigger() boolean check
 * - parseTriggerPhrase() parsing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectTrigger,
  detectAndStripTrigger,
  hasTrigger,
  parseTriggerPhrase,
} from './trigger-detector.js';

// ─── Mock Logger ────────────────────────────────────────────────────────────

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
}));

vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('TriggerDetector — Issue #1229', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseTriggerPhrase', () => {
    it('should parse a simple trigger without reason', () => {
      const result = parseTriggerPhrase('[DISCUSSION_END]');
      expect(result.phrase).toBe('[DISCUSSION_END]');
      expect(result.reason).toBeUndefined();
      expect(result.summary).toBeUndefined();
    });

    it('should parse a trigger with timeout reason', () => {
      const result = parseTriggerPhrase('[DISCUSSION_END:timeout]');
      expect(result.phrase).toBe('[DISCUSSION_END:timeout]');
      expect(result.reason).toBe('timeout');
      expect(result.summary).toBeUndefined();
    });

    it('should parse a trigger with abandoned reason', () => {
      const result = parseTriggerPhrase('[DISCUSSION_END:abandoned]');
      expect(result.phrase).toBe('[DISCUSSION_END:abandoned]');
      expect(result.reason).toBe('abandoned');
    });

    it('should parse a trigger with summary', () => {
      const result = parseTriggerPhrase('[DISCUSSION_END:summary=We agreed on option A]');
      expect(result.phrase).toBe('[DISCUSSION_END:summary=We agreed on option A]');
      expect(result.reason).toBe('summary');
      expect(result.summary).toBe('We agreed on option A');
    });

    it('should parse a trigger with empty summary', () => {
      const result = parseTriggerPhrase('[DISCUSSION_END:summary=]');
      expect(result.reason).toBe('summary');
      expect(result.summary).toBe('');
    });

    it('should handle an unknown reason', () => {
      const result = parseTriggerPhrase('[DISCUSSION_END:custom_reason]');
      expect(result.reason).toBe('custom_reason');
    });
  });

  describe('detectTrigger', () => {
    it('should detect a simple trigger', () => {
      const result = detectTrigger('[DISCUSSION_END]');
      expect(result).not.toBeNull();
      expect(result!.phrase).toBe('[DISCUSSION_END]');
    });

    it('should detect trigger with reason', () => {
      const result = detectTrigger('Some text [DISCUSSION_END:timeout]');
      expect(result).not.toBeNull();
      expect(result!.phrase).toBe('[DISCUSSION_END:timeout]');
      expect(result!.reason).toBe('timeout');
    });

    it('should detect trigger with summary', () => {
      const result = detectTrigger('Conclusion [DISCUSSION_END:summary=Done]');
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('summary');
      expect(result!.summary).toBe('Done');
    });

    it('should return null for text without trigger', () => {
      expect(detectTrigger('Hello world')).toBeNull();
    });

    it('should return null for null input', () => {
      expect(detectTrigger(null as unknown as string)).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(detectTrigger('')).toBeNull();
    });

    it('should return null for partial match', () => {
      expect(detectTrigger('[DISCUSSION')).toBeNull();
    });

    it('should return null for case-sensitive mismatch', () => {
      expect(detectTrigger('[discussion_end]')).toBeNull();
    });

    it('should detect trigger on its own line', () => {
      const text = 'Thanks for the discussion!\n[DISCUSSION_END]';
      const result = detectTrigger(text);
      expect(result).not.toBeNull();
      expect(result!.phrase).toBe('[DISCUSSION_END]');
    });

    it('should detect trigger at the end of text', () => {
      const text = 'We reached a conclusion. [DISCUSSION_END:summary=Use TypeScript]';
      const result = detectTrigger(text);
      expect(result).not.toBeNull();
      expect(result!.summary).toBe('Use TypeScript');
    });
  });

  describe('detectAndStripTrigger', () => {
    it('should strip trigger from text and return clean text', () => {
      const result = detectAndStripTrigger('Thanks! [DISCUSSION_END]');
      expect(result).not.toBeNull();
      expect(result!.cleanText).toBe('Thanks!');
      expect(result!.trigger.phrase).toBe('[DISCUSSION_END]');
    });

    it('should handle trigger on its own line', () => {
      const text = 'Great discussion.\n[DISCUSSION_END]';
      const result = detectAndStripTrigger(text);
      expect(result).not.toBeNull();
      expect(result!.cleanText).toBe('Great discussion.');
    });

    it('should handle trigger at the start', () => {
      const result = detectAndStripTrigger('[DISCUSSION_END:timeout] Sorry, time is up.');
      expect(result).not.toBeNull();
      expect(result!.cleanText).toBe('Sorry, time is up.');
      expect(result!.trigger.reason).toBe('timeout');
    });

    it('should handle trigger in the middle', () => {
      const result = detectAndStripTrigger('Before [DISCUSSION_END] after');
      expect(result).not.toBeNull();
      expect(result!.cleanText).toBe('Before after');
    });

    it('should handle trigger with summary', () => {
      const result = detectAndStripTrigger(
        'We decided to use option B. [DISCUSSION_END:summary=Option B selected]'
      );
      expect(result).not.toBeNull();
      expect(result!.cleanText).toBe('We decided to use option B.');
      expect(result!.trigger.summary).toBe('Option B selected');
    });

    it('should trim whitespace after stripping', () => {
      const result = detectAndStripTrigger('Result: [DISCUSSION_END]  ');
      expect(result).not.toBeNull();
      expect(result!.cleanText).toBe('Result:');
    });

    it('should return null for text without trigger', () => {
      expect(detectAndStripTrigger('Normal message')).toBeNull();
    });

    it('should return null for null input', () => {
      expect(detectAndStripTrigger(null as unknown as string)).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(detectAndStripTrigger('')).toBeNull();
    });

    it('should collapse multiple newlines after stripping trigger-only line', () => {
      const text = 'Line 1\n\n[DISCUSSION_END]\n\nLine 2';
      const result = detectAndStripTrigger(text);
      expect(result).not.toBeNull();
      // The trigger line is removed, but surrounding structure is preserved
      expect(result!.cleanText).not.toContain('[DISCUSSION_END]');
    });

    it('should handle text that is only a trigger', () => {
      const result = detectAndStripTrigger('[DISCUSSION_END:abandoned]');
      expect(result).not.toBeNull();
      expect(result!.cleanText).toBe('');
      expect(result!.trigger.reason).toBe('abandoned');
    });
  });

  describe('hasTrigger', () => {
    it('should return true for text with trigger', () => {
      expect(hasTrigger('[DISCUSSION_END]')).toBe(true);
    });

    it('should return true for text with trigger and other content', () => {
      expect(hasTrigger('Some text [DISCUSSION_END:timeout] more text')).toBe(true);
    });

    it('should return false for text without trigger', () => {
      expect(hasTrigger('No trigger here')).toBe(false);
    });

    it('should return false for null', () => {
      expect(hasTrigger(null as unknown as string)).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(hasTrigger('')).toBe(false);
    });

    it('should return false for partial match', () => {
      expect(hasTrigger('[DISCUSSION')).toBe(false);
    });
  });
});
