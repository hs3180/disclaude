/**
 * Tests for mention-parser utility (packages/core/src/utils/mention-parser.ts)
 *
 * Validates Feishu @mention parsing, detection, placeholder normalization,
 * and leading mention stripping logic.
 */

import { describe, it, expect } from 'vitest';
import {
  parseMentions,
  isUserMentioned,
  extractMentionedOpenIds,
  normalizeMentionPlaceholders,
  stripLeadingMentions,
} from './mention-parser.js';
import type { FeishuMessageEvent } from '../types/platform.js';

type MentionsArray = FeishuMessageEvent['message']['mentions'];

/** Helper to create a mention entry */
function makeMention(overrides: Partial<NonNullable<MentionsArray>[number]> = {}) {
  return {
    key: '@_user_1',
    id: {
      open_id: 'ou_test_123',
      union_id: 'on_test_456',
      user_id: 'ut_test_789',
    },
    name: 'TestUser',
    tenant_key: 'test_tenant',
    ...overrides,
  };
}

describe('mention-parser', () => {
  describe('parseMentions', () => {
    it('should return empty array when mentions is undefined', () => {
      expect(parseMentions(undefined)).toEqual([]);
    });

    it('should return empty array when mentions is null', () => {
      expect(parseMentions(null)).toEqual([]);
    });

    it('should return empty array when mentions is empty array', () => {
      expect(parseMentions([])).toEqual([]);
    });

    it('should parse valid mention with all fields', () => {
      const mention = makeMention();
      const result = parseMentions([mention]);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        openId: 'ou_test_123',
        unionId: 'on_test_456',
        userId: 'ut_test_789',
        name: 'TestUser',
        key: '@_user_1',
      });
    });

    it('should skip mentions without open_id', () => {
      const mention = makeMention({ id: { open_id: '', union_id: 'on_x', user_id: 'ut_y' } });
      expect(parseMentions([mention])).toEqual([]);
    });

    it('should skip mentions with null id', () => {
      const mention = makeMention({ id: null as unknown as NonNullable<MentionsArray>[number]['id'] });
      expect(parseMentions([mention])).toEqual([]);
    });

    it('should skip null entries in mentions array', () => {
      const mentions = [null, makeMention(), undefined] as unknown as MentionsArray;
      const result = parseMentions(mentions);
      expect(result).toHaveLength(1);
    });

    it('should parse multiple mentions', () => {
      const mentions = [
        makeMention({ id: { open_id: 'ou_a', union_id: 'on_a', user_id: 'ut_a' }, name: 'Alice' }),
        makeMention({ id: { open_id: 'ou_b', union_id: 'on_b', user_id: 'ut_b' }, name: 'Bob' }),
      ];
      const result = parseMentions(mentions);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Alice');
      expect(result[1].name).toBe('Bob');
    });
  });

  describe('isUserMentioned', () => {
    it('should return false when mentions is undefined', () => {
      expect(isUserMentioned(undefined, 'ou_test')).toBe(false);
    });

    it('should return false when mentions is null', () => {
      expect(isUserMentioned(null, 'ou_test')).toBe(false);
    });

    it('should return false when mentions is empty', () => {
      expect(isUserMentioned([], 'ou_test')).toBe(false);
    });

    it('should return true when user open_id matches', () => {
      const mentions = [makeMention({ id: { open_id: 'ou_target', union_id: 'on_x', user_id: 'ut_y' } })];
      expect(isUserMentioned(mentions, 'ou_target')).toBe(true);
    });

    it('should return true when user union_id matches', () => {
      const mentions = [makeMention({ id: { open_id: 'ou_a', union_id: 'on_target', user_id: 'ut_y' } })];
      expect(isUserMentioned(mentions, 'on_target')).toBe(true);
    });

    it('should return true when user_id matches', () => {
      const mentions = [makeMention({ id: { open_id: 'ou_a', union_id: 'on_b', user_id: 'ut_target' } })];
      expect(isUserMentioned(mentions, 'ut_target')).toBe(true);
    });

    it('should return false when no id matches', () => {
      const mentions = [makeMention()];
      expect(isUserMentioned(mentions, 'ou_different')).toBe(false);
    });

    it('should handle mentions with null id gracefully', () => {
      const mentions = [
        null as unknown as NonNullable<MentionsArray>[number],
        makeMention({ id: null as unknown as NonNullable<MentionsArray>[number]['id'] }),
      ];
      expect(isUserMentioned(mentions, 'ou_test')).toBe(false);
    });
  });

  describe('extractMentionedOpenIds', () => {
    it('should return empty array when mentions is undefined', () => {
      expect(extractMentionedOpenIds(undefined)).toEqual([]);
    });

    it('should return empty array when mentions is null', () => {
      expect(extractMentionedOpenIds(null)).toEqual([]);
    });

    it('should return empty array when mentions is empty', () => {
      expect(extractMentionedOpenIds([])).toEqual([]);
    });

    it('should extract open_ids from valid mentions', () => {
      const mentions = [
        makeMention({ id: { open_id: 'ou_a', union_id: 'on_a', user_id: 'ut_a' } }),
        makeMention({ id: { open_id: 'ou_b', union_id: 'on_b', user_id: 'ut_b' } }),
      ];
      expect(extractMentionedOpenIds(mentions)).toEqual(['ou_a', 'ou_b']);
    });

    it('should skip mentions without open_id', () => {
      const mentions = [
        makeMention({ id: { open_id: '', union_id: 'on_a', user_id: 'ut_a' } }),
        makeMention({ id: { open_id: 'ou_b', union_id: 'on_b', user_id: 'ut_b' } }),
      ];
      expect(extractMentionedOpenIds(mentions)).toEqual(['ou_b']);
    });
  });

  describe('normalizeMentionPlaceholders', () => {
    it('should return original text when mentions is undefined', () => {
      expect(normalizeMentionPlaceholders('hello', undefined)).toBe('hello');
    });

    it('should return original text when mentions is null', () => {
      expect(normalizeMentionPlaceholders('hello', null)).toBe('hello');
    });

    it('should return original text when mentions is empty', () => {
      expect(normalizeMentionPlaceholders('hello', [])).toBe('hello');
    });

    it('should replace ${key} placeholders with @name', () => {
      const mentions = [makeMention({ key: '@_user_1', name: 'Alice' })];
      const result = normalizeMentionPlaceholders('${@_user_1} please help', mentions);
      expect(result).toBe('@Alice please help');
    });

    it('should replace multiple different placeholders', () => {
      const mentions = [
        makeMention({ key: '@_user_1', name: 'Alice' }),
        makeMention({ key: '@_user_2', name: 'Bob' }),
      ];
      const result = normalizeMentionPlaceholders('${@_user_1} talk to ${@_user_2}', mentions);
      expect(result).toBe('@Alice talk to @Bob');
    });

    it('should not replace placeholders without matching key', () => {
      const mentions = [makeMention({ key: '@_user_1', name: 'Alice' })];
      const result = normalizeMentionPlaceholders('${@_unknown} hello', mentions);
      expect(result).toBe('${@_unknown} hello');
    });

    it('should escape special regex characters in keys', () => {
      const mentions = [makeMention({ key: 'user+1', name: 'Alice' })];
      const result = normalizeMentionPlaceholders('${user+1} hello', mentions);
      expect(result).toBe('@Alice hello');
    });

    it('should handle mentions without key or name gracefully', () => {
      const mentions = [makeMention({ key: '', name: '' })];
      const result = normalizeMentionPlaceholders('hello world', mentions);
      expect(result).toBe('hello world');
    });
  });

  describe('stripLeadingMentions', () => {
    it('should return empty string when text is empty', () => {
      expect(stripLeadingMentions('', null)).toBe('');
    });

    it('should return text unchanged when no mentions present', () => {
      expect(stripLeadingMentions('hello world', [])).toBe('hello world');
    });

    it('should strip <at user_id="xxx">@Name</at> format', () => {
      const result = stripLeadingMentions(
        '<at user_id="ou_123">@Alice</at> /help',
        null
      );
      expect(result).toBe('/help');
    });

    it('should strip ${key} placeholder format', () => {
      const mentions = [makeMention({ key: '@_user_1', name: 'Alice' })];
      const result = stripLeadingMentions('${@_user_1} /help', mentions);
      expect(result).toBe('/help');
    });

    it('should strip @Name simple format', () => {
      const result = stripLeadingMentions('@Alice /help', null);
      expect(result).toBe('/help');
    });

    it('should strip multiple consecutive mentions', () => {
      const mentions = [
        makeMention({ key: '@_user_1', name: 'Alice' }),
        makeMention({ key: '@_user_2', name: 'Bob' }),
      ];
      const result = stripLeadingMentions('@Alice @Bob /help', mentions);
      expect(result).toBe('/help');
    });

    it('should strip mixed mention formats', () => {
      const result = stripLeadingMentions(
        '<at user_id="ou_1">@Alice</at> @Bob /help',
        null
      );
      expect(result).toBe('/help');
    });

    it('should trim whitespace after stripping', () => {
      const result = stripLeadingMentions('@Alice   /help  ', null);
      expect(result).toBe('/help');
    });

    it('should not strip mentions in the middle of text', () => {
      const result = stripLeadingMentions('hello @Alice world', null);
      expect(result).toBe('hello @Alice world');
    });

    it('should handle text with only mentions', () => {
      const result = stripLeadingMentions('@Alice', null);
      expect(result).toBe('');
    });
  });
});
