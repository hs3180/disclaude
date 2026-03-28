/**
 * Tests for TriggerDetector (Issue #1229).
 *
 * Tests cover:
 * - Trigger detection for all supported formats
 * - Trigger stripping from text
 * - Combined detectAndStrip operation
 * - Edge cases (no trigger, multiple triggers, empty text)
 * - Whitespace cleanup after stripping
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TriggerDetector } from './trigger-detector.js';

describe('TriggerDetector', () => {
  let detector: TriggerDetector;

  beforeEach(() => {
    detector = new TriggerDetector();
  });

  // ─── detect() ────────────────────────────────────────────────────────

  describe('detect()', () => {
    it('should detect [DISCUSSION_END] trigger with normal reason', () => {
      const result = detector.detect('讨论结束 [DISCUSSION_END]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('normal');
        expect(result.summary).toBeUndefined();
        expect(result.rawTrigger).toBe('[DISCUSSION_END]');
        expect(result.cleanText).toBe('讨论结束 [DISCUSSION_END]');
      }
    });

    it('should detect [DISCUSSION_END:timeout] trigger', () => {
      const result = detector.detect('抱歉超时了 [DISCUSSION_END:timeout]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('timeout');
        expect(result.rawTrigger).toBe('[DISCUSSION_END:timeout]');
      }
    });

    it('should detect [DISCUSSION_END:abandoned] trigger', () => {
      const result = detector.detect('[DISCUSSION_END:abandoned]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('abandoned');
      }
    });

    it('should detect [DISCUSSION_END:summary=...] trigger', () => {
      const result = detector.detect(
        '已达成共识 [DISCUSSION_END:summary=同意使用 Prettier 格式化]'
      );
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('normal');
        expect(result.summary).toBe('同意使用 Prettier 格式化');
        expect(result.rawTrigger).toBe('[DISCUSSION_END:summary=同意使用 Prettier 格式化]');
      }
    });

    it('should detect [DISCUSSION_END:timeout=...] with both reason and summary', () => {
      const result = detector.detect(
        '[DISCUSSION_END:timeout=讨论超时，未达成共识]'
      );
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('timeout');
        expect(result.summary).toBe('讨论超时，未达成共识');
      }
    });

    it('should detect trigger with custom reason', () => {
      const result = detector.detect('[DISCUSSION_END:resolved]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('resolved');
      }
    });

    it('should return detected=false when no trigger is present', () => {
      const result = detector.detect('普通消息内容');
      expect(result.detected).toBe(false);
      if (!result.detected) {
        expect(result.reason).toBeUndefined();
        expect(result.summary).toBeUndefined();
        expect(result.cleanText).toBe('普通消息内容');
      }
    });

    it('should return detected=false for partial matches', () => {
      const result = detector.detect('[DISCUSSION');
      expect(result.detected).toBe(false);
    });

    it('should return detected=false for similar but different tags', () => {
      const result = detector.detect('[DISCUSSION_PAUSE]');
      expect(result.detected).toBe(false);
    });

    it('should detect trigger at the beginning of text', () => {
      const result = detector.detect('[DISCUSSION_END] 这是我们讨论的结论。');
      expect(result.detected).toBe(true);
    });

    it('should detect trigger in the middle of text', () => {
      const result = detector.detect('经过讨论，[DISCUSSION_END:summary=达成一致]谢谢参与。');
      expect(result.detected).toBe(true);
    });

    it('should handle empty summary value', () => {
      const result = detector.detect('[DISCUSSION_END:summary=]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.summary).toBeUndefined();
      }
    });

    it('should handle summary with special characters', () => {
      const result = detector.detect(
        '[DISCUSSION_END:summary=结论：使用 TypeScript + ESLint]'
      );
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.summary).toBe('结论：使用 TypeScript + ESLint');
      }
    });

    it('should handle empty text', () => {
      const result = detector.detect('');
      expect(result.detected).toBe(false);
    });
  });

  // ─── strip() ─────────────────────────────────────────────────────────

  describe('strip()', () => {
    it('should strip [DISCUSSION_END] from end of text', () => {
      const result = detector.strip('讨论完成 [DISCUSSION_END]');
      expect(result).toBe('讨论完成');
    });

    it('should strip [DISCUSSION_END:timeout] from text', () => {
      const result = detector.strip('超时了 [DISCUSSION_END:timeout]');
      expect(result).toBe('超时了');
    });

    it('should strip [DISCUSSION_END:summary=...] from text', () => {
      const result = detector.strip(
        '讨论结束 [DISCUSSION_END:summary=同意自动格式化]'
      );
      expect(result).toBe('讨论结束');
    });

    it('should strip trigger from beginning of text', () => {
      const result = detector.strip('[DISCUSSION_END] 讨论结束');
      expect(result).toBe('讨论结束');
    });

    it('should strip trigger from middle of text', () => {
      const result = detector.strip('讨论中 [DISCUSSION_END] 继续');
      expect(result).toBe('讨论中 继续');
    });

    it('should return original text if no trigger', () => {
      const result = detector.strip('普通消息');
      expect(result).toBe('普通消息');
    });

    it('should collapse multiple newlines after stripping', () => {
      const result = detector.strip('内容\n\n\n[DISCUSSION_END]');
      expect(result).toBe('内容');
    });

    it('should remove trailing whitespace per line after stripping', () => {
      const result = detector.strip('line1  \nline2  [DISCUSSION_END]  ');
      expect(result).toBe('line1\nline2');
    });

    it('should trim final result', () => {
      const result = detector.strip('  [DISCUSSION_END]  ');
      expect(result).toBe('');
    });

    it('should handle text that is only a trigger', () => {
      const result = detector.strip('[DISCUSSION_END:timeout]');
      expect(result).toBe('');
    });
  });

  // ─── detectAndStrip() ────────────────────────────────────────────────

  describe('detectAndStrip()', () => {
    it('should detect and strip in one operation', () => {
      const result = detector.detectAndStrip(
        '讨论结束 [DISCUSSION_END:summary=使用 Prettier]'
      );
      expect(result.detected).toBe(true);
      expect(result.cleanText).toBe('讨论结束');
      if (result.detected) {
        expect(result.reason).toBe('normal');
        expect(result.summary).toBe('使用 Prettier');
      }
    });

    it('should return cleanText unchanged when no trigger', () => {
      const result = detector.detectAndStrip('普通消息');
      expect(result.detected).toBe(false);
      expect(result.cleanText).toBe('普通消息');
    });

    it('should preserve multiline content while stripping trigger', () => {
      const result = detector.detectAndStrip(
        '总结：\n1. 使用 TypeScript\n2. 使用 ESLint\n[DISCUSSION_END]'
      );
      expect(result.detected).toBe(true);
      expect(result.cleanText).toBe('总结：\n1. 使用 TypeScript\n2. 使用 ESLint');
    });
  });
});
