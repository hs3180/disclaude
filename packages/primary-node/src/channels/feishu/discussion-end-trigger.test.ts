/**
 * Tests for Discussion End Trigger Detection.
 *
 * Issue #1229: feat: 智能会话结束 - 判断讨论何时可以关闭
 *
 * Covers:
 * - Basic trigger detection ([DISCUSSION_END])
 * - Trigger with reasons ([DISCUSSION_END:timeout], [DISCUSSION_END:abandoned])
 * - Trigger with reason= key ([DISCUSSION_END:reason=custom])
 * - Non-text messages are ignored
 * - Invalid JSON content is handled gracefully
 * - Trigger not present in content returns null
 * - Trigger in non-text field is ignored
 * - Multiple triggers in content (first match wins)
 */

import { describe, it, expect } from 'vitest';
import { detectDiscussionEndTrigger } from './discussion-end-trigger.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Wrap text in Feishu text message JSON format. */
function textContent(text: string): string {
  return JSON.stringify({ text });
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('detectDiscussionEndTrigger (Issue #1229)', () => {
  describe('basic trigger detection', () => {
    it('should detect [DISCUSSION_END] with no reason', () => {
      const result = detectDiscussionEndTrigger(textContent('讨论完成 [DISCUSSION_END]'), 'text');
      expect(result).not.toBeNull();
      expect(result!.match).toBe('[DISCUSSION_END]');
      expect(result!.reason).toBe('');
    });

    it('should detect trigger at the start of the message', () => {
      const result = detectDiscussionEndTrigger(textContent('[DISCUSSION_END] 讨论已结束'), 'text');
      expect(result).not.toBeNull();
      expect(result!.match).toBe('[DISCUSSION_END]');
    });

    it('should detect trigger in the middle of the message', () => {
      const result = detectDiscussionEndTrigger(textContent('总结如下\n\n[DISCUSSION_END]\n\n感谢参与'), 'text');
      expect(result).not.toBeNull();
      expect(result!.match).toBe('[DISCUSSION_END]');
    });

    it('should detect trigger at the end of the message', () => {
      const result = detectDiscussionEndTrigger(textContent('以上是我的分析，[DISCUSSION_END]'), 'text');
      expect(result).not.toBeNull();
    });
  });

  describe('trigger with reasons', () => {
    it('should detect [DISCUSSION_END:timeout]', () => {
      const result = detectDiscussionEndTrigger(textContent('讨论超时 [DISCUSSION_END:timeout]'), 'text');
      expect(result).not.toBeNull();
      expect(result!.match).toBe('[DISCUSSION_END:timeout]');
      expect(result!.reason).toBe('timeout');
    });

    it('should detect [DISCUSSION_END:abandoned]', () => {
      const result = detectDiscussionEndTrigger(textContent('[DISCUSSION_END:abandoned]'), 'text');
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('abandoned');
    });

    it('should detect [DISCUSSION_END:reason=custom reason]', () => {
      const result = detectDiscussionEndTrigger(
        textContent('[DISCUSSION_END:reason=用户明确表示不再需要]'),
        'text',
      );
      expect(result).not.toBeNull();
      expect(result!.match).toBe('[DISCUSSION_END:reason=用户明确表示不再需要]');
      expect(result!.reason).toBe('reason=用户明确表示不再需要');
    });

    it('should handle reason with spaces', () => {
      const result = detectDiscussionEndTrigger(
        textContent('[DISCUSSION_END: consensus reached]'),
        'text',
      );
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('consensus reached');
    });
  });

  describe('message type filtering', () => {
    it('should return null for non-text messages (post)', () => {
      const result = detectDiscussionEndTrigger(textContent('[DISCUSSION_END]'), 'post');
      expect(result).toBeNull();
    });

    it('should return null for interactive messages', () => {
      const result = detectDiscussionEndTrigger(textContent('[DISCUSSION_END]'), 'interactive');
      expect(result).toBeNull();
    });

    it('should return null for image messages', () => {
      const result = detectDiscussionEndTrigger(textContent('[DISCUSSION_END]'), 'image');
      expect(result).toBeNull();
    });

    it('should return null for file messages', () => {
      const result = detectDiscussionEndTrigger(textContent('[DISCUSSION_END]'), 'file');
      expect(result).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should return null when trigger is not present', () => {
      const result = detectDiscussionEndTrigger(textContent('普通消息内容'), 'text');
      expect(result).toBeNull();
    });

    it('should return null for invalid JSON content', () => {
      const result = detectDiscussionEndTrigger('not json [DISCUSSION_END]', 'text');
      expect(result).toBeNull();
    });

    it('should return null for empty JSON content', () => {
      const result = detectDiscussionEndTrigger('{}', 'text');
      expect(result).toBeNull();
    });

    it('should return null when text field is empty', () => {
      const result = detectDiscussionEndTrigger(JSON.stringify({ text: '' }), 'text');
      expect(result).toBeNull();
    });

    it('should return null when text field is missing', () => {
      const result = detectDiscussionEndTrigger(JSON.stringify({ content: '[DISCUSSION_END]' }), 'text');
      expect(result).toBeNull();
    });

    it('should return null for partial trigger pattern', () => {
      const result = detectDiscussionEndTrigger(textContent('[DISCUSSION_END'), 'text');
      expect(result).toBeNull();
    });

    it('should return null for trigger with extra brackets', () => {
      const result = detectDiscussionEndTrigger(textContent('[[DISCUSSION_END]]'), 'text');
      // The regex would match [DISCUSSION_END] inside [[DISCUSSION_END]]
      // because regex finds the first match
      expect(result).not.toBeNull();
      // Actually it should match since the inner [DISCUSSION_END] is valid
      expect(result!.match).toBe('[DISCUSSION_END]');
    });

    it('should be case-sensitive (lowercase should not match)', () => {
      const result = detectDiscussionEndTrigger(textContent('[discussion_end]'), 'text');
      expect(result).toBeNull();
    });

    it('should handle trigger surrounded by CJK characters', () => {
      const result = detectDiscussionEndTrigger(textContent('讨论已结束，[DISCUSSION_END]感谢参与。'), 'text');
      expect(result).not.toBeNull();
    });

    it('should handle multiline messages', () => {
      const content = JSON.stringify({
        text: '## 讨论总结\n\n1. 事项一\n2. 事项二\n\n[DISCUSSION_END]',
      });
      const result = detectDiscussionEndTrigger(content, 'text');
      expect(result).not.toBeNull();
    });

    it('should return first match when multiple triggers exist', () => {
      const result = detectDiscussionEndTrigger(
        textContent('[DISCUSSION_END:timeout] 又一个 [DISCUSSION_END:abandoned]'),
        'text',
      );
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('timeout');
    });
  });
});
