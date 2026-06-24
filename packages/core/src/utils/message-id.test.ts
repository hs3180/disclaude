/**
 * Tests for isSyntheticMessageId (packages/core/src/utils/message-id.ts)
 */

import { describe, it, expect } from 'vitest';
import { isSyntheticMessageId } from './message-id.js';

describe('isSyntheticMessageId', () => {
  describe('synthetic prefixes (returns true)', () => {
    it.each([
      ['sched-', 'sched-schedule-pr-scanner-1780907400594'],
      ['push_', 'push_0638cffc-adeb-47df-a3ac-ebaaaedaee43'],
      ['http-push-', 'http-push-550e8400-e29b-41d4-a716-446655440000'],
      ['cli-', 'cli-1719123456789'],
      ['msg-', 'msg-1719123456789'],
      ['wechat_interactive_', 'wechat_interactive_abc-123'],
    ])('detects %s prefix', (_label, id) => {
      expect(isSyntheticMessageId(id)).toBe(true);
    });
  });

  describe('synthetic suffixes (returns true)', () => {
    it.each([
      ['om_real-audio', 'om_abc123-audio'],
      ['om_real-file', 'om_abc123-file'],
    ])('detects %s suffix', (_label, id) => {
      expect(isSyntheticMessageId(id)).toBe(true);
    });
  });

  describe('real message IDs (returns false)', () => {
    it.each([
      ['feishu open_message_id', 'om_5e8c7b1f2a3d4e5f'],
      ['weibo message id', '4547'], // 不同的平台 ID 格式
      ['arbitrary id', 'thread-msg-123'],
      ['plain id', 'abc123'],
      ['uuid', '550e8400-e29b-41d4-a716-446655440000'],
    ])('passes through %s', (_label, id) => {
      expect(isSyntheticMessageId(id)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns false for empty string', () => {
      expect(isSyntheticMessageId('')).toBe(false);
    });

    it('does not match prefix appearing mid-string', () => {
      // 'push_' 必须出现在开头才判定
      expect(isSyntheticMessageId('om_push_inside')).toBe(false);
    });

    it('does not match suffix appearing mid-string', () => {
      expect(isSyntheticMessageId('om_audio_inside')).toBe(false);
    });
  });
});
