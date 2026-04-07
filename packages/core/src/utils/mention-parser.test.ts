/**
 * Tests for mention-parser utility (packages/core/src/utils/mention-parser.ts)
 *
 * Tests Feishu @mention parsing functionality:
 * - parseMentions: Extract structured mention data from Feishu message events
 * - isUserMentioned: Check if a specific user is mentioned
 * - extractMentionedOpenIds: Get all mentioned open_ids
 * - normalizeMentionPlaceholders: Replace ${key} placeholders with @Name
 * - stripLeadingMentions: Remove leading @mentions for command detection
 *
 * Issue #689: 正确处理消息中的 mention
 * Issue #698: Commands should be detected after stripping leading mentions
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

// Helper to create a mention entry matching FeishuMessageEvent structure
function createMention(overrides: Partial<FeishuMessageEvent['message']['mentions'][0]> = {}) {
  return {
    key: '@_user_1',
    id: {
      open_id: 'ou_xxxxxxxxxxxxxxxx',
      union_id: 'on_xxxxxxxxxxxxxxxx',
      user_id: 'xxxxxxxxxxxxxxxx',
    },
    name: 'TestUser',
    tenant_key: 'test_tenant',
    ...overrides,
  };
}

function createMentionsArray(mentions: FeishuMessageEvent['message']['mentions']) {
  return mentions;
}

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

  it('should parse a single mention with all fields', () => {
    const mentions = createMentionsArray([createMention()]);

    const result = parseMentions(mentions);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual<ParsedMention>({
      openId: 'ou_xxxxxxxxxxxxxxxx',
      unionId: 'on_xxxxxxxxxxxxxxxx',
      userId: 'xxxxxxxxxxxxxxxx',
      name: 'TestUser',
      key: '@_user_1',
    });
  });

  it('should parse multiple mentions', () => {
    const mentions = createMentionsArray([
      createMention({ key: '@_user_1', id: { open_id: 'ou_1', union_id: 'on_1', user_id: 'u_1' }, name: 'Alice' }),
      createMention({ key: '@_user_2', id: { open_id: 'ou_2', union_id: 'on_2', user_id: 'u_2' }, name: 'Bob' }),
    ]);

    const result = parseMentions(mentions);

    expect(result).toHaveLength(2);
    expect(result[0].openId).toBe('ou_1');
    expect(result[0].name).toBe('Alice');
    expect(result[1].openId).toBe('ou_2');
    expect(result[1].name).toBe('Bob');
  });

  it('should skip mentions without open_id', () => {
    const mentions = createMentionsArray([
      createMention({ id: { open_id: '', union_id: 'on_1', user_id: 'u_1' } }),
    ]);

    const result = parseMentions(mentions);

    expect(result).toHaveLength(0);
  });

  it('should skip mentions with null/undefined id', () => {
    const mentions = createMentionsArray([
      { key: '@_user_1', id: null, name: 'Ghost', tenant_key: 't' } as any,
      { key: '@_user_2', id: undefined, name: 'Nobody', tenant_key: 't' } as any,
    ]);

    const result = parseMentions(mentions);

    expect(result).toHaveLength(0);
  });

  it('should skip null entries in mentions array', () => {
    const mentions = createMentionsArray([
      null as any,
      createMention(),
      undefined as any,
    ]);

    const result = parseMentions(mentions);

    expect(result).toHaveLength(1);
  });

  it('should handle mentions with only open_id (optional fields missing)', () => {
    const mentions = createMentionsArray([
      { key: '@_user_1', id: { open_id: 'ou_only', union_id: '', user_id: '' }, name: 'Minimal', tenant_key: 't' },
    ]);

    const result = parseMentions(mentions);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual<ParsedMention>({
      openId: 'ou_only',
      unionId: '',
      userId: '',
      name: 'Minimal',
      key: '@_user_1',
    });
  });
});

describe('isUserMentioned', () => {
  it('should return false when mentions is undefined', () => {
    expect(isUserMentioned(undefined, 'ou_123')).toBe(false);
  });

  it('should return false when mentions is null', () => {
    expect(isUserMentioned(null, 'ou_123')).toBe(false);
  });

  it('should return false when mentions is empty', () => {
    expect(isUserMentioned([], 'ou_123')).toBe(false);
  });

  it('should return true when user is mentioned by open_id', () => {
    const mentions = createMentionsArray([
      createMention({ id: { open_id: 'ou_target', union_id: 'on_1', user_id: 'u_1' } }),
    ]);

    expect(isUserMentioned(mentions, 'ou_target')).toBe(true);
  });

  it('should return true when user is mentioned by union_id', () => {
    const mentions = createMentionsArray([
      createMention({ id: { open_id: 'ou_1', union_id: 'on_target', user_id: 'u_1' } }),
    ]);

    expect(isUserMentioned(mentions, 'on_target')).toBe(true);
  });

  it('should return true when user is mentioned by user_id', () => {
    const mentions = createMentionsArray([
      createMention({ id: { open_id: 'ou_1', union_id: 'on_1', user_id: 'u_target' } }),
    ]);

    expect(isUserMentioned(mentions, 'u_target')).toBe(true);
  });

  it('should return false when user is not mentioned', () => {
    const mentions = createMentionsArray([
      createMention({ id: { open_id: 'ou_other', union_id: 'on_other', user_id: 'u_other' } }),
    ]);

    expect(isUserMentioned(mentions, 'ou_not_here')).toBe(false);
  });

  it('should handle mentions with null id gracefully', () => {
    const mentions = createMentionsArray([
      { key: '@_x', id: null, name: 'Ghost', tenant_key: 't' } as any,
    ]);

    expect(isUserMentioned(mentions, 'ou_123')).toBe(false);
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

  it('should extract all open_ids', () => {
    const mentions = createMentionsArray([
      createMention({ id: { open_id: 'ou_1', union_id: 'on_1', user_id: 'u_1' } }),
      createMention({ id: { open_id: 'ou_2', union_id: 'on_2', user_id: 'u_2' } }),
      createMention({ id: { open_id: 'ou_3', union_id: 'on_3', user_id: 'u_3' } }),
    ]);

    expect(extractMentionedOpenIds(mentions)).toEqual(['ou_1', 'ou_2', 'ou_3']);
  });

  it('should filter out entries without open_id', () => {
    const mentions = createMentionsArray([
      createMention({ id: { open_id: 'ou_valid', union_id: '', user_id: '' } }),
      { key: '@_x', id: { open_id: '', union_id: '', user_id: '' }, name: 'Empty', tenant_key: 't' },
    ]);

    expect(extractMentionedOpenIds(mentions)).toEqual(['ou_valid']);
  });
});

describe('normalizeMentionPlaceholders', () => {
  it('should return text unchanged when mentions is undefined', () => {
    expect(normalizeMentionPlaceholders('hello world', undefined)).toBe('hello world');
  });

  it('should return text unchanged when mentions is null', () => {
    expect(normalizeMentionPlaceholders('hello world', null)).toBe('hello world');
  });

  it('should return text unchanged when mentions is empty', () => {
    expect(normalizeMentionPlaceholders('hello world', [])).toBe('hello world');
  });

  it('should replace ${key} placeholder with @Name', () => {
    const mentions = createMentionsArray([
      createMention({ key: '@_user_1', name: 'Alice' }),
    ]);

    const result = normalizeMentionPlaceholders('${@_user_1} hello', mentions);

    expect(result).toBe('@Alice hello');
  });

  it('should replace multiple different placeholders', () => {
    const mentions = createMentionsArray([
      createMention({ key: '@_user_1', name: 'Alice' }),
      createMention({ key: '@_user_2', name: 'Bob' }),
    ]);

    const result = normalizeMentionPlaceholders('${@_user_1} says hi to ${@_user_2}', mentions);

    expect(result).toBe('@Alice says hi to @Bob');
  });

  it('should replace all occurrences of the same placeholder', () => {
    const mentions = createMentionsArray([
      createMention({ key: '@_user_1', name: 'Alice' }),
    ]);

    const result = normalizeMentionPlaceholders('${@_user_1} and ${@_user_1} again', mentions);

    expect(result).toBe('@Alice and @Alice again');
  });

  it('should not replace placeholders without matching key', () => {
    const mentions = createMentionsArray([
      createMention({ key: '@_user_1', name: 'Alice' }),
    ]);

    const result = normalizeMentionPlaceholders('${@_nonexistent} hello', mentions);

    expect(result).toBe('${@_nonexistent} hello');
  });

  it('should skip mentions without key or name', () => {
    const mentions = createMentionsArray([
      { key: '', id: { open_id: 'ou_1', union_id: '', user_id: '' }, name: 'NoKey', tenant_key: 't' },
      { key: '@_no_name', id: { open_id: 'ou_2', union_id: '', user_id: '' }, name: '', tenant_key: 't' },
    ]);

    const text = '${@_user_1} hello';
    expect(normalizeMentionPlaceholders(text, mentions)).toBe(text);
  });

  it('should escape special regex characters in keys', () => {
    const mentions = createMentionsArray([
      createMention({ key: '@_user.1', name: 'Dot' }),
    ]);

    const result = normalizeMentionPlaceholders('${@_user.1} hello', mentions);

    expect(result).toBe('@Dot hello');
  });
});

describe('stripLeadingMentions', () => {
  it('should return text unchanged when text is empty', () => {
    expect(stripLeadingMentions('', null)).toBe('');
  });

  it('should return text unchanged when no leading mentions', () => {
    expect(stripLeadingMentions('hello world', null)).toBe('hello world');
  });

  it('should strip <at user_id="xxx">@Name</at> format', () => {
    const text = '<at user_id="ou_123">@Alice</at> /help';
    const result = stripLeadingMentions(text, null);

    expect(result).toBe('/help');
  });

  it('should strip multiple <at> tags', () => {
    const text = '<at user_id="ou_1">@Alice</at><at user_id="ou_2">@Bob</at> /help';
    const result = stripLeadingMentions(text, null);

    expect(result).toBe('/help');
  });

  it('should strip ${key} placeholder format', () => {
    const mentions = createMentionsArray([
      createMention({ key: '@_user_1', name: 'Alice' }),
    ]);
    const text = '${@_user_1} /help';
    const result = stripLeadingMentions(text, mentions);

    expect(result).toBe('/help');
  });

  it('should strip @Name simple format', () => {
    const text = '@Alice /help';
    const result = stripLeadingMentions(text, null);

    expect(result).toBe('/help');
  });

  it('should strip mixed format mentions', () => {
    const mentions = createMentionsArray([
      createMention({ key: '@_user_1', name: 'Bob' }),
    ]);
    const text = '<at user_id="ou_1">@Alice</at> ${@_user_1} @Charlie /help';
    const result = stripLeadingMentions(text, mentions);

    expect(result).toBe('/help');
  });

  it('should not strip mentions in the middle of text', () => {
    const text = 'hello <at user_id="ou_1">@Alice</at> world';
    const result = stripLeadingMentions(text, null);

    // After stripping nothing from the start, the @Alice tag is in the middle
    // But wait - "hello" starts with 'h', not '@' or '<at', so nothing is stripped
    expect(result).toBe('hello <at user_id="ou_1">@Alice</at> world');
  });

  it('should handle text with only mentions', () => {
    const text = '@Alice';
    const result = stripLeadingMentions(text, null);

    expect(result).toBe('');
  });

  it('should trim whitespace after stripping', () => {
    const text = '<at user_id="ou_1">@Alice</at>   /help   ';
    const result = stripLeadingMentions(text, null);

    expect(result).toBe('/help');
  });

  it('should handle @mention followed by non-command text', () => {
    const text = '@Alice hello world';
    const result = stripLeadingMentions(text, null);

    expect(result).toBe('hello world');
  });
});
