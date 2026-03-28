/**
 * Unit tests for Mention Parser
 *
 * Tests parsing, checking, and normalizing @mentions from Feishu messages.
 * Issue #689: 正确处理消息中的 mention
 */

import { describe, it, expect } from 'vitest';
import {
  parseMentions,
  isUserMentioned,
  extractMentionedOpenIds,
  normalizeMentionPlaceholders,
  stripLeadingMentions,
  type ParsedMention,
} from './mention-parser.js';
import type { FeishuMessageEvent } from '../types/platform.js';

describe('Mention Parser', () => {
  // Helper to create Feishu mention objects
  function createMention(overrides: Partial<{
    key: string;
    open_id: string;
    union_id: string;
    user_id: string;
    name: string;
    tenant_key: string;
  }> = {}) {
    return {
      key: overrides.key ?? '@_user_1',
      id: {
        open_id: overrides.open_id ?? 'ou_test123',
        union_id: overrides.union_id ?? 'on_test456',
        user_id: overrides.user_id ?? 'uid_test789',
      },
      name: overrides.name ?? 'TestUser',
      tenant_key: overrides.tenant_key ?? 'tenant_1',
    };
  }

  describe('parseMentions', () => {
    it('should return empty array for undefined mentions', () => {
      expect(parseMentions(undefined)).toEqual([]);
    });

    it('should return empty array for null mentions', () => {
      expect(parseMentions(null)).toEqual([]);
    });

    it('should return empty array for empty array', () => {
      expect(parseMentions([])).toEqual([]);
    });

    it('should parse a single mention', () => {
      const mentions = [createMention()];
      const result = parseMentions(mentions);

      expect(result).toHaveLength(1);
      expect(result[0].openId).toBe('ou_test123');
      expect(result[0].unionId).toBe('on_test456');
      expect(result[0].userId).toBe('uid_test789');
      expect(result[0].name).toBe('TestUser');
      expect(result[0].key).toBe('@_user_1');
    });

    it('should parse multiple mentions', () => {
      const mentions = [
        createMention({ open_id: 'ou_1', name: 'User1', key: '@_user_1' }),
        createMention({ open_id: 'ou_2', name: 'User2', key: '@_user_2' }),
        createMention({ open_id: 'ou_3', name: 'User3', key: '@_user_3' }),
      ];
      const result = parseMentions(mentions);

      expect(result).toHaveLength(3);
      expect(result.map(m => m.openId)).toEqual(['ou_1', 'ou_2', 'ou_3']);
    });

    it('should skip mentions without open_id', () => {
      const mentions = [
        createMention({ open_id: '' }),
        createMention({ open_id: 'ou_valid' }),
      ];
      const result = parseMentions(mentions);

      expect(result).toHaveLength(1);
      expect(result[0].openId).toBe('ou_valid');
    });

    it('should skip mentions with null/undefined id', () => {
      const mentions = [
        { key: '@_user_1', id: null, name: 'User1', tenant_key: 't1' } as unknown as FeishuMessageEvent['message']['mentions'][0],
        { key: '@_user_2', id: undefined, name: 'User2', tenant_key: 't2' } as unknown as FeishuMessageEvent['message']['mentions'][0],
        createMention({ open_id: 'ou_valid' }),
      ];
      const result = parseMentions(mentions);

      expect(result).toHaveLength(1);
      expect(result[0].openId).toBe('ou_valid');
    });

    it('should handle mentions with missing optional fields', () => {
      const mentions = [
        {
          key: undefined,
          id: { open_id: 'ou_1', union_id: undefined, user_id: undefined },
          name: undefined,
          tenant_key: 't1',
        },
      ];
      const result = parseMentions(mentions);

      expect(result).toHaveLength(1);
      expect(result[0].openId).toBe('ou_1');
      expect(result[0].unionId).toBeUndefined();
      expect(result[0].userId).toBeUndefined();
      expect(result[0].name).toBeUndefined();
      expect(result[0].key).toBeUndefined();
    });
  });

  describe('isUserMentioned', () => {
    it('should return false for undefined mentions', () => {
      expect(isUserMentioned(undefined, 'ou_test')).toBe(false);
    });

    it('should return false for null mentions', () => {
      expect(isUserMentioned(null, 'ou_test')).toBe(false);
    });

    it('should return false for empty mentions array', () => {
      expect(isUserMentioned([], 'ou_test')).toBe(false);
    });

    it('should return true when user is mentioned by open_id', () => {
      const mentions = [createMention({ open_id: 'ou_target' })];
      expect(isUserMentioned(mentions, 'ou_target')).toBe(true);
    });

    it('should return true when user is mentioned by union_id', () => {
      const mentions = [createMention({ union_id: 'on_target' })];
      expect(isUserMentioned(mentions, 'on_target')).toBe(true);
    });

    it('should return true when user is mentioned by user_id', () => {
      const mentions = [createMention({ user_id: 'uid_target' })];
      expect(isUserMentioned(mentions, 'uid_target')).toBe(true);
    });

    it('should return false when user is not mentioned', () => {
      const mentions = [createMention({ open_id: 'ou_other' })];
      expect(isUserMentioned(mentions, 'ou_target')).toBe(false);
    });

    it('should check across multiple mentions', () => {
      const mentions = [
        createMention({ open_id: 'ou_1' }),
        createMention({ open_id: 'ou_2' }),
        createMention({ open_id: 'ou_3' }),
      ];
      expect(isUserMentioned(mentions, 'ou_2')).toBe(true);
      expect(isUserMentioned(mentions, 'ou_99')).toBe(false);
    });

    it('should handle mentions with null id gracefully', () => {
      const mentions = [
        { key: 'k', id: null, name: 'N', tenant_key: 't' } as unknown as FeishuMessageEvent['message']['mentions'][0],
      ];
      expect(isUserMentioned(mentions, 'ou_target')).toBe(false);
    });
  });

  describe('extractMentionedOpenIds', () => {
    it('should return empty array for undefined mentions', () => {
      expect(extractMentionedOpenIds(undefined)).toEqual([]);
    });

    it('should return empty array for null mentions', () => {
      expect(extractMentionedOpenIds(null)).toEqual([]);
    });

    it('should return empty array for empty array', () => {
      expect(extractMentionedOpenIds([])).toEqual([]);
    });

    it('should extract open_ids from mentions', () => {
      const mentions = [
        createMention({ open_id: 'ou_1' }),
        createMention({ open_id: 'ou_2' }),
        createMention({ open_id: 'ou_3' }),
      ];
      expect(extractMentionedOpenIds(mentions)).toEqual(['ou_1', 'ou_2', 'ou_3']);
    });

    it('should skip mentions without open_id', () => {
      const mentions = [
        createMention({ open_id: '' }),
        createMention({ open_id: 'ou_valid' }),
      ];
      expect(extractMentionedOpenIds(mentions)).toEqual(['ou_valid']);
    });
  });

  describe('normalizeMentionPlaceholders', () => {
    it('should return original text when no mentions', () => {
      expect(normalizeMentionPlaceholders('Hello world', undefined)).toBe('Hello world');
      expect(normalizeMentionPlaceholders('Hello world', null)).toBe('Hello world');
      expect(normalizeMentionPlaceholders('Hello world', [])).toBe('Hello world');
    });

    it('should replace ${key} placeholders with @Name', () => {
      const mentions = [createMention({ key: '@_user_1', name: 'Alice' })];
      const text = '${@_user_1} please help';

      const result = normalizeMentionPlaceholders(text, mentions);
      expect(result).toBe('@Alice please help');
    });

    it('should replace multiple different placeholders', () => {
      const mentions = [
        createMention({ key: '@_user_1', name: 'Alice' }),
        createMention({ key: '@_user_2', name: 'Bob' }),
      ];
      const text = '${@_user_1} talk to ${@_user_2}';

      const result = normalizeMentionPlaceholders(text, mentions);
      expect(result).toBe('@Alice talk to @Bob');
    });

    it('should replace all occurrences of the same placeholder', () => {
      const mentions = [createMention({ key: '@_user_1', name: 'Alice' })];
      const text = '${@_user_1} ${@_user_1} hello ${@_user_1}';

      const result = normalizeMentionPlaceholders(text, mentions);
      expect(result).toBe('@Alice @Alice hello @Alice');
    });

    it('should preserve <at> tags unchanged', () => {
      const mentions = [createMention({ key: '@_user_1', name: 'Alice' })];
      const text = '<at user_id="ou_xxx">@Alice</at> hello';

      const result = normalizeMentionPlaceholders(text, mentions);
      expect(result).toBe('<at user_id="ou_xxx">@Alice</at> hello');
    });

    it('should handle text with no placeholders', () => {
      const mentions = [createMention({ key: '@_user_1', name: 'Alice' })];
      const text = 'Just plain text';

      expect(normalizeMentionPlaceholders(text, mentions)).toBe('Just plain text');
    });

    it('should skip mentions without key or name', () => {
      const mentions = [
        { key: undefined, id: { open_id: 'ou_1', union_id: '', user_id: '' }, name: 'Alice', tenant_key: 't1' },
        { key: '@_user_2', id: { open_id: 'ou_2', union_id: '', user_id: '' }, name: undefined, tenant_key: 't2' },
      ];
      const text = '${@_user_1} ${@_user_2}';

      const result = normalizeMentionPlaceholders(text, mentions);
      expect(result).toBe('${@_user_1} ${@_user_2}');
    });

    it('should escape special regex characters in keys', () => {
      const mentions = [createMention({ key: '@_user_1$', name: 'Alice' })];
      const text = '${@_user_1$} please help';

      const result = normalizeMentionPlaceholders(text, mentions);
      expect(result).toBe('@Alice please help');
    });
  });

  describe('stripLeadingMentions', () => {
    it('should return original text when text is empty', () => {
      expect(stripLeadingMentions('', null)).toBe('');
    });

    it('should return original text when no mentions provided', () => {
      expect(stripLeadingMentions('Hello world', undefined)).toBe('Hello world');
    });

    it('should strip <at> tag format mentions', () => {
      const text = '<at user_id="ou_xxx">@Bot</at> /help';
      const result = stripLeadingMentions(text, null);

      expect(result).toBe('/help');
    });

    it('should strip ${key} placeholder format mentions', () => {
      const mentions = [createMention({ key: '@_user_1', name: 'Alice' })];
      const text = '${@_user_1} /status';
      const result = stripLeadingMentions(text, mentions);

      expect(result).toBe('/status');
    });

    it('should strip @Name simple format mentions', () => {
      const text = '@Alice /help';
      const result = stripLeadingMentions(text, null);

      expect(result).toBe('/help');
    });

    it('should strip multiple leading mentions of different formats', () => {
      const mentions = [createMention({ key: '@_user_1', name: 'Alice' })];
      const text = '<at user_id="ou_xxx">@Bot</at> ${@_user_1} @Charlie /help';
      const result = stripLeadingMentions(text, mentions);

      expect(result).toBe('/help');
    });

    it('should not strip mentions in the middle of text', () => {
      const text = '/help @Alice more text';
      const result = stripLeadingMentions(text, null);

      expect(result).toBe('/help @Alice more text');
    });

    it('should handle text with only mentions', () => {
      const text = '@Bot';
      const result = stripLeadingMentions(text, null);

      expect(result).toBe('');
    });

    it('should trim whitespace after stripping', () => {
      const text = '  @Bot   /help  ';
      const result = stripLeadingMentions(text, null);

      expect(result).toBe('/help');
    });

    it('should handle mixed format mentions with whitespace', () => {
      const mentions = [
        createMention({ key: '@_user_1', name: 'Alice' }),
        createMention({ key: '@_user_2', name: 'Bob' }),
      ];
      const text = '${@_user_1}  ${@_user_2}  /command';
      const result = stripLeadingMentions(text, mentions);

      expect(result).toBe('/command');
    });

    it('should preserve text that starts with a non-mention @', () => {
      const text = '@everyone /help';
      const result = stripLeadingMentions(text, null);

      // @everyone looks like a simple mention format, so it should be stripped
      expect(result).toBe('/help');
    });

    it('should not strip text that does not start with a mention', () => {
      const text = 'Hello @Alice /help';
      const result = stripLeadingMentions(text, null);

      expect(result).toBe('Hello @Alice /help');
    });

    it('should strip consecutive @Name mentions', () => {
      const text = '@Alice @Bob @Charlie hello world';
      const result = stripLeadingMentions(text, null);

      expect(result).toBe('hello world');
    });
  });
});
