/**
 * Tests for bot-to-bot @mention support (Issue #1742).
 *
 * Tests cover:
 * - MentionDetector.isBotMentioned with bot messages
 * - Bot messages are filtered when they don't mention our bot
 * - Bot messages are allowed through when they @mention our bot
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MentionDetector } from './mention-detector.js';
import type { FeishuMessageEvent } from '@disclaude/core';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a properly typed mention object matching FeishuMessageEvent.mentions */
function createMention(overrides: {
  openId: string;
  key?: string;
  name?: string;
  tenantKey?: string;
  unionId?: string;
  userId?: string;
}): NonNullable<FeishuMessageEvent['message']['mentions']>[number] {
  return {
    key: overrides.key ?? `@_user_${overrides.openId}`,
    id: {
      open_id: overrides.openId,
      union_id: overrides.unionId ?? `on_${overrides.openId}`,
      user_id: overrides.userId ?? `uid_${overrides.openId}`,
    },
    name: overrides.name ?? `User ${overrides.openId}`,
    tenant_key: overrides.tenantKey ?? 'tenant_001',
  };
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('MentionDetector -- bot-to-bot @mention support (Issue #1742)', () => {
  let detector: MentionDetector;

  beforeEach(() => {
    detector = new MentionDetector();
  });

  describe('isBotMentioned', () => {
    it('should return false when mentions is undefined', () => {
      expect(detector.isBotMentioned(undefined)).toBe(false);
    });

    it('should return false when mentions is empty array', () => {
      expect(detector.isBotMentioned([])).toBe(false);
    });

    it('should return true when bot open_id matches a mention', () => {
      detector.setClient({} as any);
      // Simulate having fetched bot info by accessing private field
      (detector as any).botInfo = { open_id: 'ou_bot_self', app_id: 'cli_abc123' };

      const mentions = [createMention({ openId: 'ou_bot_self' })];
      expect(detector.isBotMentioned(mentions)).toBe(true);
    });

    it('should return true when bot app_id matches a mention', () => {
      detector.setClient({} as any);
      (detector as any).botInfo = { open_id: 'ou_bot_self', app_id: 'cli_abc123' };

      const mentions = [createMention({ openId: 'cli_abc123' })];
      expect(detector.isBotMentioned(mentions)).toBe(true);
    });

    it('should return false when no mention matches bot', () => {
      detector.setClient({} as any);
      (detector as any).botInfo = { open_id: 'ou_bot_self', app_id: 'cli_abc123' };

      const mentions = [createMention({ openId: 'ou_other_user' })];
      expect(detector.isBotMentioned(mentions)).toBe(false);
    });

    it('should return false when mention has different open_id', () => {
      detector.setClient({} as any);
      (detector as any).botInfo = { open_id: 'ou_bot_self', app_id: 'cli_abc123' };

      const mentions = [createMention({ openId: 'ou_another_bot' })];
      expect(detector.isBotMentioned(mentions)).toBe(false);
    });

    it('should check all mentions for a match', () => {
      detector.setClient({} as any);
      (detector as any).botInfo = { open_id: 'ou_bot_self', app_id: 'cli_abc123' };

      const mentions = [
        createMention({ openId: 'ou_user_1' }),
        createMention({ openId: 'ou_bot_self' }),
        createMention({ openId: 'ou_user_3' }),
      ];
      expect(detector.isBotMentioned(mentions)).toBe(true);
    });

    it('should handle mentions with missing id field gracefully', () => {
      detector.setClient({} as any);
      (detector as any).botInfo = { open_id: 'ou_bot_self', app_id: 'cli_abc123' };

      const mentions = [
        { key: '@_user_1', id: { open_id: '', union_id: '', user_id: '' }, name: '', tenant_key: '' },
      ];
      expect(detector.isBotMentioned(mentions)).toBe(false);
    });

    describe('fallback without bot info', () => {
      it('should match cli_ prefix open_ids in fallback mode', () => {
        // No botInfo set -- fallback heuristic
        const mentions = [createMention({ openId: 'cli_some_bot' })];
        expect(detector.isBotMentioned(mentions)).toBe(true);
      });

      it('should match key containing "bot" in fallback mode', () => {
        const mentions = [createMention({ openId: 'ou_something', key: '@_bot_1' })];
        expect(detector.isBotMentioned(mentions)).toBe(true);
      });

      it('should not match regular user open_ids in fallback mode', () => {
        const mentions = [createMention({ openId: 'ou_regular_user' })];
        expect(detector.isBotMentioned(mentions)).toBe(false);
      });
    });
  });

  describe('getBotInfo', () => {
    it('should return undefined when bot info not fetched', () => {
      expect(detector.getBotInfo()).toBeUndefined();
    });

    it('should return bot info after setting it', () => {
      (detector as any).botInfo = { open_id: 'ou_test', app_id: 'cli_test' };
      expect(detector.getBotInfo()).toEqual({ open_id: 'ou_test', app_id: 'cli_test' });
    });
  });
});
