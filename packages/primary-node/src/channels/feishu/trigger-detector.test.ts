/**
 * Tests for TriggerDetector (Issue #1229).
 *
 * Tests cover:
 * - Basic trigger detection ([DISCUSSION_END])
 * - Trigger with reasons (timeout, abandoned)
 * - Trigger with summary parameter
 * - Stripping triggers from text
 * - Combined detectAndStrip
 * - Edge cases (empty, null, no trigger)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TriggerDetector } from './trigger-detector.js';

describe('TriggerDetector', () => {
  let detector: TriggerDetector;

  beforeEach(() => {
    detector = new TriggerDetector();
  });

  describe('detectAndStrip', () => {
    it('should detect [DISCUSSION_END] trigger', () => {
      const result = detector.detectAndStrip('讨论结束 [DISCUSSION_END]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('normal');
        expect(result.cleanText).toBe('讨论结束');
      }
    });

    it('should detect [DISCUSSION_END:timeout] trigger', () => {
      const result = detector.detectAndStrip('讨论超时 [DISCUSSION_END:timeout]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('timeout');
        expect(result.cleanText).toBe('讨论超时');
      }
    });

    it('should detect [DISCUSSION_END:abandoned] trigger', () => {
      const result = detector.detectAndStrip('[DISCUSSION_END:abandoned]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('abandoned');
        expect(result.cleanText).toBe('');
      }
    });

    it('should extract summary from [DISCUSSION_END:summary=...]', () => {
      const result = detector.detectAndStrip('结论如下 [DISCUSSION_END:summary=讨论达成共识]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('normal');
        expect(result.summary).toBe('讨论达成共识');
        expect(result.cleanText).toBe('结论如下');
      }
    });

    it('should not detect trigger in normal text', () => {
      const result = detector.detectAndStrip('这是一条普通消息');
      expect(result.detected).toBe(false);
      expect(result.cleanText).toBe('这是一条普通消息');
    });

    it('should not detect trigger when bracket content is different', () => {
      const result = detector.detectAndStrip('[SOME_OTHER_TAG]');
      expect(result.detected).toBe(false);
      expect(result.cleanText).toBe('[SOME_OTHER_TAG]');
    });

    it('should handle text with trigger at the beginning', () => {
      const result = detector.detectAndStrip('[DISCUSSION_END] 讨论完成');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.cleanText).toBe('讨论完成');
      }
    });

    it('should handle text with trigger in the middle', () => {
      const result = detector.detectAndStrip('讨论已经 [DISCUSSION_END] 完成了');
      expect(result.detected).toBe(true);
      if (result.detected) {
        // Trigger removal leaves spaces intact (no whitespace collapsing)
        expect(result.cleanText).toBe('讨论已经  完成了');
      }
    });

    it('should handle multiple triggers (use last one)', () => {
      const result = detector.detectAndStrip('[DISCUSSION_END] 重试 [DISCUSSION_END:timeout]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('timeout');
        expect(result.cleanText).toBe('重试');
      }
    });

    it('should return empty string when text is only trigger', () => {
      const result = detector.detectAndStrip('[DISCUSSION_END]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.cleanText).toBe('');
      }
    });

    it('should handle empty string', () => {
      const result = detector.detectAndStrip('');
      expect(result.detected).toBe(false);
      expect(result.cleanText).toBe('');
    });

    it('should handle null/undefined input', () => {
      const result1 = detector.detectAndStrip(null as unknown as string);
      expect(result1.detected).toBe(false);
      expect(result1.cleanText).toBe('');

      const result2 = detector.detectAndStrip(undefined as unknown as string);
      expect(result2.detected).toBe(false);
      expect(result2.cleanText).toBe('');
    });

    it('should handle whitespace-only text with trigger', () => {
      const result = detector.detectAndStrip('   [DISCUSSION_END]   ');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.cleanText).toBe('');
      }
    });

    it('should preserve clean text whitespace properly', () => {
      const result = detector.detectAndStrip('Hello [DISCUSSION_END] World');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.cleanText).toBe('Hello  World');
      }
    });
  });

  describe('hasTrigger', () => {
    it('should return true for text with trigger', () => {
      expect(detector.hasTrigger('讨论 [DISCUSSION_END]')).toBe(true);
    });

    it('should return true for text with trigger and reason', () => {
      expect(detector.hasTrigger('[DISCUSSION_END:timeout]')).toBe(true);
    });

    it('should return false for text without trigger', () => {
      expect(detector.hasTrigger('普通消息')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(detector.hasTrigger('')).toBe(false);
    });

    it('should return false for null input', () => {
      expect(detector.hasTrigger(null as unknown as string)).toBe(false);
    });

    it('should handle repeated calls correctly', () => {
      // Regex with global flag maintains lastIndex state
      // Make sure our implementation handles this
      expect(detector.hasTrigger('[DISCUSSION_END]')).toBe(true);
      expect(detector.hasTrigger('普通消息')).toBe(false);
      expect(detector.hasTrigger('[DISCUSSION_END:abandoned]')).toBe(true);
    });
  });
});
