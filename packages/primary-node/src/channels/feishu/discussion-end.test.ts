/**
 * Unit tests for DiscussionEnd detection and handling.
 *
 * @see Issue #1229 - Smart discussion ending
 */

import { describe, it, expect } from 'vitest';
import {
  detectDiscussionEnd,
  stripTriggerPhrases,
  buildEndCard,
} from './discussion-end.js';

describe('DiscussionEnd', () => {
  describe('detectDiscussionEnd', () => {
    it('should return detected: false for normal text', () => {
      const result = detectDiscussionEnd('Hello, this is a normal message');
      expect(result.detected).toBe(false);
    });

    it('should detect [DISCUSSION_END] with reason normal', () => {
      const result = detectDiscussionEnd('讨论完成 [DISCUSSION_END]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('normal');
        expect(result.rawPhrase).toBe('[DISCUSSION_END]');
        expect(result.summary).toBeUndefined();
      }
    });

    it('should detect [DISCUSSION_END:timeout]', () => {
      const result = detectDiscussionEnd('Time is up [DISCUSSION_END:timeout]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('timeout');
        expect(result.rawPhrase).toBe('[DISCUSSION_END:timeout]');
      }
    });

    it('should detect [DISCUSSION_END:abandoned]', () => {
      const result = detectDiscussionEnd('[DISCUSSION_END:abandoned]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('abandoned');
        expect(result.rawPhrase).toBe('[DISCUSSION_END:abandoned]');
      }
    });

    it('should detect [DISCUSSION_END:summary=xxx] with custom summary', () => {
      const result = detectDiscussionEnd(
        'We reached a conclusion [DISCUSSION_END:summary=The answer is 42]',
      );
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('custom');
        expect(result.summary).toBe('The answer is 42');
        expect(result.rawPhrase).toBe('[DISCUSSION_END:summary=The answer is 42]');
      }
    });

    it('should detect trigger phrase in the middle of text', () => {
      const result = detectDiscussionEnd(
        'Great discussion! [DISCUSSION_END:summary=Agreed on the plan] See you next time.',
      );
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.summary).toBe('Agreed on the plan');
      }
    });

    it('should detect trigger phrase with Chinese summary', () => {
      const result = detectDiscussionEnd(
        '[DISCUSSION_END:summary=结论：采用方案B]',
      );
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.summary).toBe('结论：采用方案B');
      }
    });

    it('should detect trigger phrase with empty summary', () => {
      const result = detectDiscussionEnd('[DISCUSSION_END:summary=]');
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('custom');
        expect(result.summary).toBe('');
      }
    });

    it('should handle text with no trigger phrase (edge case)', () => {
      expect(detectDiscussionEnd('')).toMatchObject({ detected: false });
      expect(detectDiscussionEnd('[DISCUSSION]')).toMatchObject({ detected: false });
      expect(detectDiscussionEnd('[discussion_end]')).toMatchObject({ detected: false });
    });

    it('should be case-sensitive (lowercase should not match)', () => {
      const result = detectDiscussionEnd('[discussion_end]');
      expect(result.detected).toBe(false);
    });

    it('should return the first match when multiple triggers exist', () => {
      const result = detectDiscussionEnd(
        '[DISCUSSION_END:timeout] and [DISCUSSION_END:abandoned]',
      );
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.reason).toBe('timeout');
      }
    });
  });

  describe('stripTriggerPhrases', () => {
    it('should remove trigger phrase from text', () => {
      const result = stripTriggerPhrases('讨论完成 [DISCUSSION_END]');
      expect(result).toBe('讨论完成');
    });

    it('should remove trigger phrase with modifier', () => {
      const result = stripTriggerPhrases(
        '结论已达成 [DISCUSSION_END:summary=我们选择了方案A]',
      );
      expect(result).toBe('结论已达成');
    });

    it('should remove multiple trigger phrases', () => {
      const result = stripTriggerPhrases(
        'First [DISCUSSION_END:timeout] and [DISCUSSION_END:abandoned]',
      );
      expect(result).toBe('First  and');
    });

    it('should return empty string if only trigger phrase', () => {
      const result = stripTriggerPhrases('[DISCUSSION_END]');
      expect(result).toBe('');
    });

    it('should leave normal text unchanged', () => {
      const result = stripTriggerPhrases('Hello world');
      expect(result).toBe('Hello world');
    });

    it('should trim whitespace after stripping', () => {
      const result = stripTriggerPhrases('  [DISCUSSION_END]  ');
      expect(result).toBe('');
    });
  });

  describe('buildEndCard', () => {
    it('should build a card with normal reason', () => {
      const result = detectDiscussionEnd('[DISCUSSION_END]') as { detected: true; reason: string; rawPhrase: string };
      const card = buildEndCard(result);
      expect(card.config).toEqual({ wide_screen_mode: true });
      expect(card.header).toMatchObject({
        title: { tag: 'plain_text', content: '📋 讨论总结' },
        template: 'purple',
      });
      // Should have markdown elements
      const elements = card.elements as Array<Record<string, unknown>>;
      expect(elements[0]).toMatchObject({
        tag: 'markdown',
        content: '**讨论结束**',
      });
    });

    it('should build a card with timeout reason', () => {
      const result = detectDiscussionEnd('[DISCUSSION_END:timeout]') as { detected: true; reason: string; rawPhrase: string };
      const card = buildEndCard(result);
      const elements = card.elements as Array<Record<string, unknown>>;
      expect(elements[0]).toMatchObject({
        tag: 'markdown',
        content: '**讨论超时**',
      });
    });

    it('should build a card with abandoned reason', () => {
      const result = detectDiscussionEnd('[DISCUSSION_END:abandoned]') as { detected: true; reason: string; rawPhrase: string };
      const card = buildEndCard(result);
      const elements = card.elements as Array<Record<string, unknown>>;
      expect(elements[0]).toMatchObject({
        tag: 'markdown',
        content: '**讨论已放弃**',
      });
    });

    it('should use custom summary when provided', () => {
      const result = detectDiscussionEnd('[DISCUSSION_END:summary=结论：采用方案B]') as { detected: true; reason: string; summary?: string; rawPhrase: string };
      const card = buildEndCard(result);
      const elements = card.elements as Array<Record<string, unknown>>;
      expect(elements[2]).toMatchObject({
        tag: 'markdown',
        content: '结论：采用方案B',
      });
    });

    it('should use remaining text as summary when no custom summary', () => {
      const result = detectDiscussionEnd('[DISCUSSION_END]') as { detected: true; reason: string; rawPhrase: string };
      const card = buildEndCard(result, '我们讨论了三个方案，最终选择了第一个。');
      const elements = card.elements as Array<Record<string, unknown>>;
      expect(elements[2]).toMatchObject({
        tag: 'markdown',
        content: '我们讨论了三个方案，最终选择了第一个。',
      });
    });

    it('should use default text when no summary and no remaining text', () => {
      const result = detectDiscussionEnd('[DISCUSSION_END]') as { detected: true; reason: string; rawPhrase: string };
      const card = buildEndCard(result);
      const elements = card.elements as Array<Record<string, unknown>>;
      expect(elements[2]).toMatchObject({
        tag: 'markdown',
        content: '讨论已完成，群聊即将解散。',
      });
    });

    it('should prefer custom summary over remaining text', () => {
      const result = detectDiscussionEnd('[DISCUSSION_END:summary=Custom summary]') as { detected: true; reason: string; summary?: string; rawPhrase: string };
      const card = buildEndCard(result, 'Remaining text');
      const elements = card.elements as Array<Record<string, unknown>>;
      expect(elements[2]).toMatchObject({
        tag: 'markdown',
        content: 'Custom summary',
      });
    });

    it('should always include the auto-dissolve notice', () => {
      const result = detectDiscussionEnd('[DISCUSSION_END]') as { detected: true; reason: string; rawPhrase: string };
      const card = buildEndCard(result);
      const elements = card.elements as Array<Record<string, unknown>>;
      const lastElement = elements[elements.length - 1];
      expect(lastElement).toMatchObject({
        tag: 'markdown',
      });
      expect((lastElement.content as string)).toContain('自动解散');
    });
  });
});
