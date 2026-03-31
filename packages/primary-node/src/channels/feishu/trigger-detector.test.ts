/**
 * Unit tests for TriggerDetector.
 *
 * Issue #1229: Smart session end via trigger phrase detection
 */

import { describe, it, expect } from 'vitest';
import { detectAndStripTrigger, hasTrigger } from './trigger-detector.js';

describe('TriggerDetector', () => {
  describe('detectAndStripTrigger', () => {
    describe('no trigger', () => {
      it('returns undetected for plain text', () => {
        const result = detectAndStripTrigger('Hello world');
        expect(result.detected).toBe(false);
        expect(result.cleanText).toBe('Hello world');
        expect(result.reason).toBeUndefined();
        expect(result.summary).toBeUndefined();
      });

      it('returns undetected for empty string', () => {
        const result = detectAndStripTrigger('');
        expect(result.detected).toBe(false);
        expect(result.cleanText).toBe('');
      });

      it('returns undetected for text with brackets but not trigger', () => {
        const result = detectAndStripTrigger('Check out [some link] and more');
        expect(result.detected).toBe(false);
        expect(result.cleanText).toBe('Check out [some link] and more');
      });

      it('returns undetected for partial trigger pattern', () => {
        const result = detectAndStripTrigger('[DISCUSSION]');
        expect(result.detected).toBe(false);
      });
    });

    describe('[DISCUSSION_END] - normal end', () => {
      it('detects basic trigger', () => {
        const result = detectAndStripTrigger('Discussion complete [DISCUSSION_END]');
        expect(result.detected).toBe(true);
        expect(result.cleanText).toBe('Discussion complete');
        expect(result.reason).toBe('normal');
        expect(result.summary).toBeUndefined();
      });

      it('strips trigger at the beginning', () => {
        const result = detectAndStripTrigger('[DISCUSSION_END] Goodbye!');
        expect(result.detected).toBe(true);
        expect(result.cleanText).toBe('Goodbye!');
      });

      it('strips trigger in the middle', () => {
        const result = detectAndStripTrigger('Thanks [DISCUSSION_END] for the chat');
        expect(result.detected).toBe(true);
        expect(result.cleanText).toBe('Thanks for the chat');
      });

      it('handles trigger-only message', () => {
        const result = detectAndStripTrigger('[DISCUSSION_END]');
        expect(result.detected).toBe(true);
        expect(result.cleanText).toBe('');
      });
    });

    describe('[DISCUSSION_END:timeout]', () => {
      it('detects timeout reason', () => {
        const result = detectAndStripTrigger('Time is up [DISCUSSION_END:timeout]');
        expect(result.detected).toBe(true);
        expect(result.cleanText).toBe('Time is up');
        expect(result.reason).toBe('timeout');
      });

      it('detects timeout trigger without surrounding text', () => {
        const result = detectAndStripTrigger('[DISCUSSION_END:timeout]');
        expect(result.detected).toBe(true);
        expect(result.cleanText).toBe('');
        expect(result.reason).toBe('timeout');
      });
    });

    describe('[DISCUSSION_END:abandoned]', () => {
      it('detects abandoned reason', () => {
        const result = detectAndStripTrigger('No response received [DISCUSSION_END:abandoned]');
        expect(result.detected).toBe(true);
        expect(result.cleanText).toBe('No response received');
        expect(result.reason).toBe('abandoned');
      });
    });

    describe('[DISCUSSION_END:summary=...]', () => {
      it('detects trigger with summary', () => {
        const result = detectAndStripTrigger(
          'We agreed on the plan [DISCUSSION_END:summary=Decided to use React]'
        );
        expect(result.detected).toBe(true);
        expect(result.cleanText).toBe('We agreed on the plan');
        expect(result.reason).toBe('normal');
        expect(result.summary).toBe('Decided to use React');
      });

      it('handles summary-only trigger', () => {
        const result = detectAndStripTrigger('[DISCUSSION_END:summary=Topic resolved]');
        expect(result.detected).toBe(true);
        expect(result.cleanText).toBe('');
        expect(result.summary).toBe('Topic resolved');
      });

      it('handles summary with special characters', () => {
        const result = detectAndStripTrigger(
          'Done [DISCUSSION_END:summary=Bug #123 fixed, PR pending review]'
        );
        expect(result.detected).toBe(true);
        expect(result.summary).toBe('Bug #123 fixed, PR pending review');
      });
    });

    describe('edge cases', () => {
      it('is case-insensitive', () => {
        const result = detectAndStripTrigger('End [discussion_end]');
        expect(result.detected).toBe(true);
        expect(result.cleanText).toBe('End');
      });

      it('only processes first trigger', () => {
        const result = detectAndStripTrigger(
          'Done [DISCUSSION_END] and also [DISCUSSION_END:timeout]'
        );
        expect(result.detected).toBe(true);
        expect(result.cleanText).toBe('Done and also [DISCUSSION_END:timeout]');
        expect(result.reason).toBe('normal');
      });

      it('handles unknown reason gracefully', () => {
        const result = detectAndStripTrigger('Done [DISCUSSION_END:unknown_reason]');
        expect(result.detected).toBe(true);
        expect(result.reason).toBe('normal');
      });

      it('handles multiline text', () => {
        const result = detectAndStripTrigger(
          'Summary:\n- Item 1\n- Item 2\n[DISCUSSION_END]'
        );
        expect(result.detected).toBe(true);
        expect(result.cleanText).toBe('Summary:\n- Item 1\n- Item 2');
      });
    });
  });

  describe('hasTrigger', () => {
    it('returns true for text with trigger', () => {
      expect(hasTrigger('Hello [DISCUSSION_END]')).toBe(true);
    });

    it('returns false for text without trigger', () => {
      expect(hasTrigger('Hello world')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(hasTrigger('')).toBe(false);
    });

    it('returns true for trigger-only text', () => {
      expect(hasTrigger('[DISCUSSION_END:timeout]')).toBe(true);
    });
  });
});
