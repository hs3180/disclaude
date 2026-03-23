/**
 * Tests for TriggerDetector.
 *
 * @see Issue #1229 - 智能会话结束 - 判断讨论何时可以关闭
 */

import { describe, it, expect } from 'vitest';
import { TriggerDetector, DEFAULT_TRIGGER_KEYWORD, TRIGGER_REASONS } from './trigger-detector.js';

describe('TriggerDetector', () => {
  describe('detect', () => {
    it('should detect [DISCUSSION_END] trigger', () => {
      const detector = new TriggerDetector();
      const result = detector.detect('讨论已结束 [DISCUSSION_END]');

      expect(result.detected).toBe(true);
      expect(result.rawMatch).toBe('[DISCUSSION_END]');
    });

    it('should detect trigger with reason', () => {
      const detector = new TriggerDetector();
      const result = detector.detect('超时了 [DISCUSSION_END:timeout]');

      expect(result.detected).toBe(true);
      expect(result.reason).toBe('timeout');
      expect(result.summary).toBeUndefined();
    });

    it('should detect trigger with summary', () => {
      const detector = new TriggerDetector();
      const result = detector.detect('Done [DISCUSSION_END:summary=达成共识，选择方案A]');

      expect(result.detected).toBe(true);
      expect(result.summary).toBe('达成共识，选择方案A');
      expect(result.reason).toBeUndefined();
    });

    it('should detect abandoned trigger', () => {
      const detector = new TriggerDetector();
      const result = detector.detect('[DISCUSSION_END:abandoned]');

      expect(result.detected).toBe(true);
      expect(result.reason).toBe('abandoned');
    });

    it('should not detect when no trigger present', () => {
      const detector = new TriggerDetector();
      const result = detector.detect('This is a normal message');

      expect(result.detected).toBe(false);
      expect(result.rawMatch).toBeUndefined();
    });

    it('should not false-positive on partial patterns', () => {
      const detector = new TriggerDetector();
      const result = detector.detect('The discussion end is near');

      expect(result.detected).toBe(false);
    });

    it('should not false-positive on brackets without keyword', () => {
      const detector = new TriggerDetector();
      const result = detector.detect('[OTHER_TRIGGER:timeout]');

      expect(result.detected).toBe(false);
    });

    it('should detect trigger at the beginning of message', () => {
      const detector = new TriggerDetector();
      const result = detector.detect('[DISCUSSION_END] Everything has been resolved.');

      expect(result.detected).toBe(true);
    });

    it('should detect trigger in the middle of message', () => {
      const detector = new TriggerDetector();
      const result = detector.detect('After careful consideration [DISCUSSION_END:summary=我们决定采用方案B] we can move on.');

      expect(result.detected).toBe(true);
      expect(result.summary).toBe('我们决定采用方案B');
    });
  });

  describe('stripTrigger', () => {
    it('should strip trigger phrase from text', () => {
      const detector = new TriggerDetector();
      const result = detector.detect('Final message [DISCUSSION_END]');
      const cleaned = detector.stripTrigger('Final message [DISCUSSION_END]', result);

      expect(cleaned).toBe('Final message');
    });

    it('should strip trigger with reason from text', () => {
      const detector = new TriggerDetector();
      const result = detector.detect('Time up [DISCUSSION_END:timeout]');
      const cleaned = detector.stripTrigger('Time up [DISCUSSION_END:timeout]', result);

      expect(cleaned).toBe('Time up');
    });

    it('should strip trigger with summary from text', () => {
      const detector = new TriggerDetector();
      const result = detector.detect('Done [DISCUSSION_END:summary=达成共识]');
      const cleaned = detector.stripTrigger('Done [DISCUSSION_END:summary=达成共识]', result);

      expect(cleaned).toBe('Done');
    });

    it('should clean up excess whitespace after stripping', () => {
      const detector = new TriggerDetector();
      const result = detector.detect('Message content.\n\n[DISCUSSION_END]\n\n');
      const cleaned = detector.stripTrigger('Message content.\n\n[DISCUSSION_END]\n\n', result);

      expect(cleaned).toBe('Message content.');
    });

    it('should not modify text when not detected', () => {
      const detector = new TriggerDetector();
      const result: { detected: false; rawMatch?: undefined } = { detected: false };
      const cleaned = detector.stripTrigger('Normal message', result);

      expect(cleaned).toBe('Normal message');
    });

    it('should not modify text when no rawMatch', () => {
      const detector = new TriggerDetector();
      const result = { detected: true };
      const cleaned = detector.stripTrigger('Some message', result);

      expect(cleaned).toBe('Some message');
    });
  });

  describe('detectAndStrip', () => {
    it('should detect and strip in one call', () => {
      const detector = new TriggerDetector();
      const { cleanedText, trigger } = detector.detectAndStrip(
        'Agreement reached. [DISCUSSION_END:summary=一致同意]'
      );

      expect(trigger.detected).toBe(true);
      expect(trigger.summary).toBe('一致同意');
      expect(cleanedText).toBe('Agreement reached.');
    });

    it('should return original text when no trigger', () => {
      const detector = new TriggerDetector();
      const { cleanedText, trigger } = detector.detectAndStrip('Nothing to see here');

      expect(trigger.detected).toBe(false);
      expect(cleanedText).toBe('Nothing to see here');
    });
  });

  describe('custom keyword', () => {
    it('should detect custom trigger keyword', () => {
      const detector = new TriggerDetector({ triggerKeyword: 'SESSION_CLOSE' });
      const result = detector.detect('End of session [SESSION_CLOSE]');

      expect(result.detected).toBe(true);
      expect(result.rawMatch).toBe('[SESSION_CLOSE]');
    });

    it('should not detect default keyword when using custom', () => {
      const detector = new TriggerDetector({ triggerKeyword: 'SESSION_CLOSE' });
      const result = detector.detect('[DISCUSSION_END]');

      expect(result.detected).toBe(false);
    });

    it('should handle custom keyword with payload', () => {
      const detector = new TriggerDetector({ triggerKeyword: 'SESSION_CLOSE' });
      const result = detector.detect('[SESSION_CLOSE:timeout]');

      expect(result.detected).toBe(true);
      expect(result.reason).toBe('timeout');
    });
  });

  describe('constants', () => {
    it('should export default trigger keyword', () => {
      expect(DEFAULT_TRIGGER_KEYWORD).toBe('DISCUSSION_END');
    });

    it('should export trigger reasons', () => {
      expect(TRIGGER_REASONS.NORMAL).toBeUndefined();
      expect(TRIGGER_REASONS.TIMEOUT).toBe('timeout');
      expect(TRIGGER_REASONS.ABANDONED).toBe('abandoned');
    });
  });
});
