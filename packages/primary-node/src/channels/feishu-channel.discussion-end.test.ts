/**
 * Unit tests for FeishuChannel Discussion End feature (Issue #1229).
 *
 * Tests the trigger phrase regex pattern and text transformation logic
 * for the smart discussion end mechanism.
 *
 * The regex is defined in feishu-channel.ts as DISCUSSION_END_TRIGGER.
 * This test file duplicates the regex to avoid pulling in heavy dependencies
 * (@disclaude/core, @larksuiteoapi/node-sdk, etc.) required by FeishuChannel.
 *
 * NOTE: If the regex in feishu-channel.ts changes, it MUST be updated here too.
 */

import { describe, it, expect } from 'vitest';

/**
 * Regex to match discussion end trigger phrases in outgoing text messages.
 * Must be kept in sync with DISCUSSION_END_TRIGGER in feishu-channel.ts.
 */
const DISCUSSION_END_TRIGGER = /\[DISCUSSION_END(?::[a-zA-Z_]+)?\]/;

describe('DISCUSSION_END_TRIGGER pattern (Issue #1229)', () => {
  describe('should match valid trigger phrases', () => {
    const validTriggers = [
      { input: '[DISCUSSION_END]', expected: '[DISCUSSION_END]' },
      { input: '[DISCUSSION_END:timeout]', expected: '[DISCUSSION_END:timeout]' },
      { input: '[DISCUSSION_END:abandoned]', expected: '[DISCUSSION_END:abandoned]' },
      { input: '[DISCUSSION_END:resolved]', expected: '[DISCUSSION_END:resolved]' },
      { input: '[DISCUSSION_END:custom_reason]', expected: '[DISCUSSION_END:custom_reason]' },
    ];

    for (const { input, expected } of validTriggers) {
      it(`should match "${input}"`, () => {
        const match = input.match(DISCUSSION_END_TRIGGER);
        expect(match).not.toBeNull();
        expect(match?.[0]).toBe(expected);
      });
    }
  });

  describe('should not match invalid patterns', () => {
    const invalidPatterns = [
      '[discussion_end]',
      '[DISCUSSION END]',
      '[DISCUSSION_END:',
      'DISCUSSION_END]',
      '[DISCUSSION_END:123]',
      '[DISCUSSION_END:]',
      'DISCUSSION_END',
      '[discussion_end:timeout]',
    ];

    for (const pattern of invalidPatterns) {
      it(`should not match "${pattern}"`, () => {
        expect(pattern).not.toMatch(DISCUSSION_END_TRIGGER);
      });
    }
  });

  describe('should match when embedded in text', () => {
    it('should match trigger at the end of a message', () => {
      const text = 'Thanks for the discussion! [DISCUSSION_END]';
      expect(text).toMatch(DISCUSSION_END_TRIGGER);
    });

    it('should match trigger at the start of a message', () => {
      const text = '[DISCUSSION_END] Goodbye everyone.';
      expect(text).toMatch(DISCUSSION_END_TRIGGER);
    });

    it('should match trigger in the middle of a message', () => {
      const text = 'We reached a conclusion [DISCUSSION_END:resolved] and here is the summary.';
      expect(text).toMatch(DISCUSSION_END_TRIGGER);
    });

    it('should extract the matched trigger from embedded text', () => {
      const text = 'Done [DISCUSSION_END:timeout] see you later';
      const match = text.match(DISCUSSION_END_TRIGGER);
      expect(match?.[0]).toBe('[DISCUSSION_END:timeout]');
    });

    it('should match in multi-line text', () => {
      const text = 'Summary:\n- Point A\n- Point B\n\n[DISCUSSION_END]';
      expect(text).toMatch(DISCUSSION_END_TRIGGER);
    });
  });

  describe('trigger stripping', () => {
    it('should strip trigger from the end of text', () => {
      const text = 'Summary of discussion [DISCUSSION_END]';
      const cleaned = text.replace(DISCUSSION_END_TRIGGER, '').trim();
      expect(cleaned).toBe('Summary of discussion');
    });

    it('should strip trigger from the beginning of text', () => {
      const text = '[DISCUSSION_END] Final message';
      const cleaned = text.replace(DISCUSSION_END_TRIGGER, '').trim();
      expect(cleaned).toBe('Final message');
    });

    it('should strip trigger with variant from the middle of text', () => {
      const text = 'Conclusion [DISCUSSION_END:resolved] Thanks all!';
      const cleaned = text.replace(DISCUSSION_END_TRIGGER, '').trim();
      expect(cleaned).toBe('Conclusion  Thanks all!');
    });

    it('should leave text unchanged when no trigger is present', () => {
      const text = 'Normal message without any trigger';
      const cleaned = text.replace(DISCUSSION_END_TRIGGER, '').trim();
      expect(cleaned).toBe('Normal message without any trigger');
    });

    it('should handle text that is only the trigger', () => {
      const text = '[DISCUSSION_END]';
      const cleaned = text.replace(DISCUSSION_END_TRIGGER, '').trim();
      expect(cleaned).toBe('');
    });

    it('should handle empty string', () => {
      const text = '';
      const cleaned = text.replace(DISCUSSION_END_TRIGGER, '').trim();
      expect(cleaned).toBe('');
    });
  });
});
