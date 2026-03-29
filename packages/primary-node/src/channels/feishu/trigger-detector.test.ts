/**
 * Unit tests for TriggerDetector (Issue #1229).
 *
 * Tests cover:
 * - Detection of all trigger phrase formats
 * - Reason and summary extraction
 * - Stripping trigger phrases from text
 * - Edge cases (empty input, null, multiple triggers)
 * - hasTrigger fast-path
 * - stripTrigger utility
 */

import { describe, it, expect } from 'vitest';
import { TriggerDetector, TRIGGER_PHRASES } from './trigger-detector.js';

describe('TriggerDetector', () => {
  let detector: TriggerDetector;

  beforeEach(() => {
    detector = new TriggerDetector();
  });

  describe('detect — basic detection', () => {
    it('should detect [DISCUSSION_END] trigger', () => {
      const result = detector.detect('讨论已结束 [DISCUSSION_END]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBeUndefined();
        expect(result.summary).toBeUndefined();
        expect(result.raw).toBe('[DISCUSSION_END]');
        expect(result.cleanText).toBe('讨论已结束');
      }
    });

    it('should return no trigger for normal text', () => {
      const result = detector.detect('这是一条普通消息');
      expect(result.detected).toBe(false);
      if (!result.detected) {
        expect(result.text).toBe('这是一条普通消息');
      }
    });

    it('should return no trigger for empty string', () => {
      const result = detector.detect('');
      expect(result.detected).toBe(false);
    });

    it('should return no trigger for null-ish input', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(detector.detect(null as any).detected).toBe(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(detector.detect(undefined as any).detected).toBe(false);
    });
  });

  describe('detect — reason extraction', () => {
    it('should detect [DISCUSSION_END:timeout]', () => {
      const result = detector.detect('讨论超时 [DISCUSSION_END:timeout]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('timeout');
        expect(result.summary).toBeUndefined();
      }
    });

    it('should detect [DISCUSSION_END:abandoned]', () => {
      const result = detector.detect('[DISCUSSION_END:abandoned]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('abandoned');
      }
    });

    it('should detect custom reason', () => {
      const result = detector.detect('结束 [DISCUSSION_END:custom_reason]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('custom_reason');
      }
    });

    it('should normalize reason to lowercase when it is a known reason', () => {
      const result = detector.detect('[DISCUSSION_END:TIMEOUT]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('timeout');
      }
    });
  });

  describe('detect — summary extraction', () => {
    it('should detect [DISCUSSION_END:summary=text]', () => {
      const result = detector.detect('达成共识 [DISCUSSION_END:summary=大家同意方案A]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.summary).toBe('大家同意方案A');
        expect(result.reason).toBeUndefined();
      }
    });

    it('should detect [DISCUSSION_END=text] without colon part', () => {
      const result = detector.detect('[DISCUSSION_END=简短总结]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.summary).toBe('简短总结');
      }
    });

    it('should detect reason + summary combo', () => {
      const result = detector.detect('结束 [DISCUSSION_END:timeout=超时未回复]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('timeout');
        expect(result.summary).toBe('超时未回复');
      }
    });

    it('should treat "summary" as keyword not reason', () => {
      const result = detector.detect('[DISCUSSION_END:summary=测试]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBeUndefined();
        expect(result.summary).toBe('测试');
      }
    });

    it('should treat colon+summary with non-summary colon as reason', () => {
      const result = detector.detect('[DISCUSSION_END:abandoned=无响应]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('abandoned');
        expect(result.summary).toBe('无响应');
      }
    });
  });

  describe('detect — clean text extraction', () => {
    it('should strip trigger from surrounding text', () => {
      const result = detector.detect('这是总结 [DISCUSSION_END]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.cleanText).toBe('这是总结');
      }
    });

    it('should return empty string when trigger is the only content', () => {
      const result = detector.detect('[DISCUSSION_END]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.cleanText).toBe('');
      }
    });

    it('should handle trigger at the beginning', () => {
      const result = detector.detect('[DISCUSSION_END] 然后是一些话');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.cleanText).toBe('然后是一些话');
      }
    });

    it('should strip multiple trigger phrases', () => {
      const result = detector.detect('讨论 [DISCUSSION_END] 中间文字 [DISCUSSION_END:timeout]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.cleanText).toBe('讨论 中间文字');
      }
    });
  });

  describe('hasTrigger — fast boolean check', () => {
    it('should return true when trigger is present', () => {
      expect(detector.hasTrigger('讨论结束 [DISCUSSION_END]')).toBe(true);
    });

    it('should return false when no trigger', () => {
      expect(detector.hasTrigger('普通消息')).toBe(false);
    });

    it('should return false for empty/null input', () => {
      expect(detector.hasTrigger('')).toBe(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(detector.hasTrigger(null as any)).toBe(false);
    });

    it('should detect all trigger formats', () => {
      expect(detector.hasTrigger('[DISCUSSION_END:timeout]')).toBe(true);
      expect(detector.hasTrigger('[DISCUSSION_END:abandoned]')).toBe(true);
      expect(detector.hasTrigger('[DISCUSSION_END:summary=test]')).toBe(true);
    });
  });

  describe('stripTrigger — text cleaning', () => {
    it('should remove trigger phrase from text', () => {
      expect(detector.stripTrigger('总结 [DISCUSSION_END]')).toBe('总结');
    });

    it('should return original text if no trigger', () => {
      expect(detector.stripTrigger('普通消息')).toBe('普通消息');
    });

    it('should handle empty string', () => {
      expect(detector.stripTrigger('')).toBe('');
    });

    it('should handle null input', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(detector.stripTrigger(null as any)).toBe('');
    });

    it('should strip multiple triggers', () => {
      const result = detector.stripTrigger('A [DISCUSSION_END] B [DISCUSSION_END:timeout] C');
      expect(result).toBe('A B C');
    });
  });

  describe('detect — regex state reset', () => {
    it('should work correctly on repeated calls', () => {
      // First call — should detect
      const result1 = detector.detect('[DISCUSSION_END]');
      expect(result1.detected).toBe(true);

      // Second call — should also detect (regex state must be reset)
      const result2 = detector.detect('[DISCUSSION_END]');
      expect(result2.detected).toBe(true);

      // Third call — should not detect
      const result3 = detector.detect('普通消息');
      expect(result3.detected).toBe(false);

      // Fourth call — should detect again
      const result4 = detector.detect('[DISCUSSION_END:timeout]');
      expect(result4.detected).toBe(true);
    });
  });

  describe('TRIGGER_PHRASES constants', () => {
    it('should export all expected trigger phrases', () => {
      expect(TRIGGER_PHRASES.NORMAL).toBe('[DISCUSSION_END]');
      expect(TRIGGER_PHRASES.TIMEOUT).toBe('[DISCUSSION_END:timeout]');
      expect(TRIGGER_PHRASES.ABANDONED).toBe('[DISCUSSION_END:abandoned]');
      expect(TRIGGER_PHRASES.SUMMARY).toContain('[DISCUSSION_END:summary=');
    });

    it('should detect exported trigger phrases', () => {
      expect(detector.hasTrigger(TRIGGER_PHRASES.NORMAL)).toBe(true);
      expect(detector.hasTrigger(TRIGGER_PHRASES.TIMEOUT)).toBe(true);
      expect(detector.hasTrigger(TRIGGER_PHRASES.ABANDONED)).toBe(true);
      // SUMMARY template needs a value to be detected
      expect(detector.hasTrigger(TRIGGER_PHRASES.SUMMARY.replace('<summary>', 'test'))).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should not detect partial matches', () => {
      expect(detector.hasTrigger('[DISCUSSION_END')).toBe(false);
      expect(detector.hasTrigger('DISCUSSION_END]')).toBe(false);
      expect(detector.hasTrigger('[DISCUSSION_ENDED]')).toBe(false);
    });

    it('should handle trigger embedded in a word (no match expected)', () => {
      expect(detector.hasTrigger('some[DISCUSSION_END]text')).toBe(true);
      // The regex doesn't require whitespace boundaries — this is intentional
      // as the trigger should be detected regardless of surrounding text
    });

    it('should handle multiline text', () => {
      const text = '第一行\n第二行\n[DISCUSSION_END:summary=讨论完成]';
      const result = detector.detect(text);
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.summary).toBe('讨论完成');
      }
    });

    it('should handle trigger with special characters in summary', () => {
      const result = detector.detect('[DISCUSSION_END:summary=使用 C++ 和 Java]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.summary).toBe('使用 C++ 和 Java');
      }
    });
  });
});
