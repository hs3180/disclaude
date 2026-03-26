/**
 * Trigger Phrase Detector unit tests.
 *
 * Issue #1229: Smart session end — trigger-based discussion completion.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TriggerDetector, DEFAULT_TRIGGER_PATTERN } from './trigger-detector.js';

describe('TriggerDetector', () => {
  let detector: TriggerDetector;

  beforeEach(() => {
    detector = new TriggerDetector();
  });

  describe('detect', () => {
    it('should detect [DISCUSSION_END] trigger', () => {
      const result = detector.detect('Discussion concluded. [DISCUSSION_END]');
      expect(result.detected).toBe(true);
      expect(result.triggerMatch).toBe('[DISCUSSION_END]');
      expect(result.reason).toBeUndefined();
    });

    it('should detect [DISCUSSION_END:timeout] trigger with reason', () => {
      const result = detector.detect('Times up! [DISCUSSION_END:timeout]');
      expect(result.detected).toBe(true);
      expect(result.triggerMatch).toBe('[DISCUSSION_END:timeout]');
      expect(result.reason).toBe('timeout');
    });

    it('should detect [DISCUSSION_END:abandoned] trigger with reason', () => {
      const result = detector.detect('Nobody responded. [DISCUSSION_END:abandoned]');
      expect(result.detected).toBe(true);
      expect(result.triggerMatch).toBe('[DISCUSSION_END:abandoned]');
      expect(result.reason).toBe('abandoned');
    });

    it('should detect [DISCUSSION_END:summary=...] trigger with reason', () => {
      const result = detector.detect('Done. [DISCUSSION_END:summary=Agreed on plan A]');
      expect(result.detected).toBe(true);
      expect(result.triggerMatch).toBe('[DISCUSSION_END:summary=Agreed on plan A]');
      expect(result.reason).toBe('summary=Agreed on plan A');
    });

    it('should return detected=false for normal text', () => {
      const result = detector.detect('This is just a normal message');
      expect(result.detected).toBe(false);
    });

    it('should return detected=false for partial trigger text', () => {
      const result = detector.detect('I mentioned DISCUSSION_END in my text');
      expect(result.detected).toBe(false);
    });

    it('should return detected=false for text with DISCUSSION_END but no brackets', () => {
      const result = detector.detect('DISCUSSION_END is a keyword');
      expect(result.detected).toBe(false);
    });

    it('should detect trigger at the beginning of text', () => {
      const result = detector.detect('[DISCUSSION_END] Thank you all!');
      expect(result.detected).toBe(true);
    });

    it('should detect trigger in the middle of text', () => {
      const result = detector.detect('We agreed on this [DISCUSSION_END] Goodbye!');
      expect(result.detected).toBe(true);
    });

    it('should detect trigger on its own line', () => {
      const result = detector.detect('Final thoughts here.\n\n[DISCUSSION_END]');
      expect(result.detected).toBe(true);
    });

    it('should return detected=false for empty text', () => {
      const result = detector.detect('');
      expect(result.detected).toBe(false);
    });
  });

  describe('strip', () => {
    it('should strip [DISCUSSION_END] from text', () => {
      const result = detector.strip('Discussion concluded. [DISCUSSION_END]');
      expect(result).toBe('Discussion concluded.');
    });

    it('should strip trigger with reason from text', () => {
      const result = detector.strip('Times up! [DISCUSSION_END:timeout]');
      expect(result).toBe('Times up!');
    });

    it('should strip trigger with summary from text', () => {
      const result = detector.strip('Done. [DISCUSSION_END:summary=Agreed on plan A]');
      expect(result).toBe('Done.');
    });

    it('should collapse multiple newlines after stripping', () => {
      const result = detector.strip('Some text.\n\n\n\n\n[DISCUSSION_END]');
      expect(result).toBe('Some text.');
    });

    it('should trim whitespace after stripping', () => {
      const result = detector.strip('Text here. [DISCUSSION_END]   ');
      expect(result).toBe('Text here.');
    });

    it('should return original text when no trigger found', () => {
      const text = 'No trigger here at all';
      const result = detector.strip(text);
      expect(result).toBe(text);
    });

    it('should handle text that is only the trigger', () => {
      const result = detector.strip('[DISCUSSION_END]');
      expect(result).toBe('');
    });
  });

  describe('detectAndStrip', () => {
    it('should detect and strip trigger, returning clean text', () => {
      const result = detector.detectAndStrip('Discussion concluded. [DISCUSSION_END]');
      expect(result.detected).toBe(true);
      expect(result.cleanText).toBe('Discussion concluded.');
      expect(result.triggerMatch).toBe('[DISCUSSION_END]');
    });

    it('should return original text when no trigger detected', () => {
      const text = 'Just a normal message';
      const result = detector.detectAndStrip(text);
      expect(result.detected).toBe(false);
      expect(result.cleanText).toBe(text);
    });

    it('should preserve reason in combined result', () => {
      const result = detector.detectAndStrip('Timeout! [DISCUSSION_END:timeout]');
      expect(result.detected).toBe(true);
      expect(result.cleanText).toBe('Timeout!');
      expect(result.reason).toBe('timeout');
    });

    it('should handle multiline text with trigger at end', () => {
      const text = 'Line 1\nLine 2\nLine 3\n\n[DISCUSSION_END]';
      const result = detector.detectAndStrip(text);
      expect(result.detected).toBe(true);
      expect(result.cleanText).toBe('Line 1\nLine 2\nLine 3');
    });
  });

  describe('custom pattern', () => {
    it('should use custom pattern when provided', () => {
      const customDetector = new TriggerDetector(/\[CUSTOM_END\]/);
      const result = customDetector.detect('Ending now [CUSTOM_END]');
      expect(result.detected).toBe(true);
      expect(result.triggerMatch).toBe('[CUSTOM_END]');
    });

    it('should not detect default pattern when using custom pattern', () => {
      const customDetector = new TriggerDetector(/\[CUSTOM_END\]/);
      const result = customDetector.detect('Ending now [DISCUSSION_END]');
      expect(result.detected).toBe(false);
    });
  });

  describe('DEFAULT_TRIGGER_PATTERN', () => {
    it('should match [DISCUSSION_END]', () => {
      expect(DEFAULT_TRIGGER_PATTERN.test('[DISCUSSION_END]')).toBe(true);
    });

    it('should match [DISCUSSION_END:timeout]', () => {
      expect(DEFAULT_TRIGGER_PATTERN.test('[DISCUSSION_END:timeout]')).toBe(true);
    });

    it('should match [DISCUSSION_END:summary=Some text]', () => {
      expect(DEFAULT_TRIGGER_PATTERN.test('[DISCUSSION_END:summary=Some text]')).toBe(true);
    });

    it('should not match DISCUSSION_END without brackets', () => {
      expect(DEFAULT_TRIGGER_PATTERN.test('DISCUSSION_END')).toBe(false);
    });

    it('should not match partial bracket patterns', () => {
      expect(DEFAULT_TRIGGER_PATTERN.test('[DISCUSSION_END')).toBe(false);
      expect(DEFAULT_TRIGGER_PATTERN.test('DISCUSSION_END]')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle text with multiple triggers (strip first one)', () => {
      const result = detector.detectAndStrip('End [DISCUSSION_END] and another [DISCUSSION_END:timeout]');
      expect(result.detected).toBe(true);
      // The strip method replaces all matches via regex
      expect(result.cleanText).not.toContain('[DISCUSSION_END]');
    });

    it('should handle trigger in Chinese text', () => {
      const result = detector.detectAndStrip('讨论结束了 [DISCUSSION_END:summary=达成共识]');
      expect(result.detected).toBe(true);
      expect(result.cleanText).toBe('讨论结束了');
      expect(result.reason).toBe('summary=达成共识');
    });

    it('should handle trigger with empty reason', () => {
      const result = detector.detectAndStrip('End [DISCUSSION_END:]');
      expect(result.detected).toBe(true);
      expect(result.cleanText).toBe('End');
      // Empty reason after colon and trim becomes undefined
      expect(result.reason).toBeUndefined();
    });

    it('should handle trigger with spaces in reason', () => {
      const result = detector.detectAndStrip('End [DISCUSSION_END: timeout reached ]');
      expect(result.detected).toBe(true);
      expect(result.reason).toBe('timeout reached');
    });
  });
});
