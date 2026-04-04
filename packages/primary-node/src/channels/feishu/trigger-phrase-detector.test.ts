/**
 * Tests for TriggerPhraseDetector (Issue #1229).
 *
 * Tests cover:
 * - Normal trigger phrase detection: [DISCUSSION_END]
 * - Typed trigger phrases: [DISCUSSION_END:timeout], [DISCUSSION_END:abandoned]
 * - No false positives on regular messages
 * - Edge cases: empty text, undefined, null-like inputs
 * - Custom trigger patterns
 */

import { describe, it, expect } from 'vitest';
import { TriggerPhraseDetector } from './trigger-phrase-detector.js';

// Mock @disclaude/core logger
import { vi } from 'vitest';
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    trace: vi.fn(),
  }),
}));

describe('TriggerPhraseDetector', () => {
  describe('default pattern', () => {
    const detector = new TriggerPhraseDetector();

    it('should detect [DISCUSSION_END] trigger phrase', () => {
      const result = detector.detect('Discussion concluded. [DISCUSSION_END]');
      expect(result.detected).toBe(true);
      expect(result.type).toBeUndefined();
    });

    it('should detect [DISCUSSION_END:timeout] typed trigger', () => {
      const result = detector.detect('Time is up. [DISCUSSION_END:timeout]');
      expect(result.detected).toBe(true);
      expect(result.type).toBe('timeout');
    });

    it('should detect [DISCUSSION_END:abandoned] typed trigger', () => {
      const result = detector.detect('Moving on. [DISCUSSION_END:abandoned]');
      expect(result.detected).toBe(true);
      expect(result.type).toBe('abandoned');
    });

    it('should detect trigger in multi-line messages', () => {
      const text = `Here's a summary of our discussion:

1. We agreed on the approach
2. Next steps are defined

[DISCUSSION_END]`;

      const result = detector.detect(text);
      expect(result.detected).toBe(true);
      expect(result.type).toBeUndefined();
    });

    it('should not detect trigger in regular messages', () => {
      const result = detector.detect('This is a normal message about discussion ending.');
      expect(result.detected).toBe(false);
    });

    it('should not detect trigger in messages with partial matches', () => {
      expect(detector.detect('DISCUSSION_END without brackets').detected).toBe(false);
      expect(detector.detect('[DISCUSSION] alone').detected).toBe(false);
      expect(detector.detect('[discussion_end] lowercase').detected).toBe(false);
    });

    it('should handle empty text', () => {
      const result = detector.detect('');
      expect(result.detected).toBe(false);
    });

    it('should handle text with only whitespace', () => {
      const result = detector.detect('   ');
      expect(result.detected).toBe(false);
    });

    it('should detect custom type in trigger', () => {
      const result = detector.detect('[DISCUSSION_END:custom_reason]');
      expect(result.detected).toBe(true);
      expect(result.type).toBe('custom_reason');
    });
  });

  describe('custom pattern', () => {
    it('should use custom pattern for detection', () => {
      const customDetector = new TriggerPhraseDetector(/\[SESSION_CLOSE\]/);

      expect(customDetector.detect('[SESSION_CLOSE]').detected).toBe(true);
      expect(customDetector.detect('[DISCUSSION_END]').detected).toBe(false);
    });

    it('should support custom pattern with capture groups', () => {
      const customDetector = new TriggerPhraseDetector(/\[END:(\w+)\]/);

      const result = customDetector.detect('Done. [END:complete]');
      expect(result.detected).toBe(true);
      expect(result.type).toBe('complete');
    });
  });

  describe('edge cases', () => {
    const detector = new TriggerPhraseDetector();

    it('should detect trigger even when surrounded by other content', () => {
      const result = detector.detect('Before [DISCUSSION_END:timeout] after');
      expect(result.detected).toBe(true);
      expect(result.type).toBe('timeout');
    });

    it('should detect trigger at the start of message', () => {
      const result = detector.detect('[DISCUSSION_END] Summary here.');
      expect(result.detected).toBe(true);
    });

    it('should detect trigger at the end of message', () => {
      const result = detector.detect('Summary here. [DISCUSSION_END]');
      expect(result.detected).toBe(true);
    });

    it('should not false-positive on similar patterns', () => {
      expect(detector.detect('See [DISCUSSION_ENDING] for details').detected).toBe(false);
      expect(detector.detect('[DISCUSSION_ENDED]').detected).toBe(false);
      expect(detector.detect('[DISCUSSION_ENDS]').detected).toBe(false);
    });

    it('should handle very long messages', () => {
      const longText = 'A'.repeat(10000) + ' [DISCUSSION_END]';
      const result = detector.detect(longText);
      expect(result.detected).toBe(true);
    });

    it('should handle messages with unicode', () => {
      const result = detector.detect('讨论结束 🎉 [DISCUSSION_END]');
      expect(result.detected).toBe(true);
    });

    it('should handle messages with markdown formatting', () => {
      const result = detector.detect('**Summary:** done\n\n`[DISCUSSION_END]`');
      expect(result.detected).toBe(true);
    });
  });
});
