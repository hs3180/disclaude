/**
 * Unit tests for mention-parser.ts
 *
 * Tests mention parsing utilities:
 * - parseMentions: extract structured mention data from Feishu messages
 * - isUserMentioned: check if a specific user is mentioned
 * - extractMentionedOpenIds: get all mentioned open_ids
 * - normalizeMentionPlaceholders: replace placeholders with @DisplayName
 * - stripLeadingMentions: remove leading @mentions to detect commands
 */

import { describe, it, expect } from 'vitest';
import {
  parseMentions,
  isUserMentioned,
  extractMentionedOpenIds,
  normalizeMentionPlaceholders,
  stripLeadingMentions,
} from './mention-parser.js';

// ============================================================================
// Helpers
// ============================================================================

type MentionEntry = {
  key?: string;
  id?: {
    open_id?: string;
    union_id?: string;
    user_id?: string;
  };
  name?: string;
  tenant_key?: string;
};

function createMention(overrides: Partial<MentionEntry> = {}): MentionEntry {
  return {
    key: '@_user_1',
    id: { open_id: 'ou_abc123', union_id: 'on_xyz', user_id: 'uid_1' },
    name: 'TestUser',
    tenant_key: 'test_tenant',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('parseMentions', () => {
  it('should return empty array for undefined mentions', () => {
    expect(parseMentions(undefined)).toEqual([]);
  });

  it('should return empty array for null mentions', () => {
    expect(parseMentions(null)).toEqual([]);
  });

  it('should return empty array for empty mentions array', () => {
    expect(parseMentions([])).toEqual([]);
  });

  it('should parse valid mention with all fields', () => {
    const mentions = [createMention()];
    const result = parseMentions(mentions);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      openId: 'ou_abc123',
      unionId: 'on_xyz',
      userId: 'uid_1',
      name: 'TestUser',
      key: '@_user_1',
    });
  });

  it('should skip mention without id', () => {
    const mentions = [{ key: 'test', name: 'NoId' }];
    const result = parseMentions(mentions as any);

    expect(result).toEqual([]);
  });

  it('should skip mention without open_id', () => {
    const mentions = [{ id: { union_id: 'on_x' }, name: 'NoOpenId' }];
    const result = parseMentions(mentions as any);

    expect(result).toEqual([]);
  });

  it('should skip mention with null id', () => {
    const mentions = [{ id: null, name: 'NullId' }];
    const result = parseMentions(mentions as any);

    expect(result).toEqual([]);
  });

  it('should parse multiple mentions', () => {
    const mentions = [
      createMention({ id: { open_id: 'ou_1' }, name: 'User1', key: '@_u1' }),
      createMention({ id: { open_id: 'ou_2' }, name: 'User2', key: '@_u2' }),
      createMention({ id: { open_id: 'ou_3' }, name: 'User3', key: '@_u3' }),
    ];
    const result = parseMentions(mentions as any);

    expect(result).toHaveLength(3);
    expect(result.map(m => m.openId)).toEqual(['ou_1', 'ou_2', 'ou_3']);
  });

  it('should handle mention with only open_id (no optional fields)', () => {
    const mentions = [{ id: { open_id: 'ou_minimal' } }];
    const result = parseMentions(mentions as any);

    expect(result).toHaveLength(1);
    expect(result[0].openId).toBe('ou_minimal');
    expect(result[0].unionId).toBeUndefined();
    expect(result[0].userId).toBeUndefined();
    expect(result[0].name).toBeUndefined();
    expect(result[0].key).toBeUndefined();
  });
});

describe('isUserMentioned', () => {
  it('should return false for undefined mentions', () => {
    expect(isUserMentioned(undefined, 'ou_123')).toBe(false);
  });

  it('should return false for null mentions', () => {
    expect(isUserMentioned(null, 'ou_123')).toBe(false);
  });

  it('should return false for empty mentions array', () => {
    expect(isUserMentioned([], 'ou_123')).toBe(false);
  });

  it('should return true when user is mentioned by open_id', () => {
    const mentions = [createMention({ id: { open_id: 'ou_target' } })];
    expect(isUserMentioned(mentions as any, 'ou_target')).toBe(true);
  });

  it('should return true when user is mentioned by union_id', () => {
    const mentions = [createMention({ id: { open_id: 'ou_other', union_id: 'on_target' } })];
    expect(isUserMentioned(mentions as any, 'on_target')).toBe(true);
  });

  it('should return true when user is mentioned by user_id', () => {
    const mentions = [createMention({ id: { open_id: 'ou_other', user_id: 'uid_target' } })];
    expect(isUserMentioned(mentions as any, 'uid_target')).toBe(true);
  });

  it('should return false when user is not mentioned', () => {
    const mentions = [createMention({ id: { open_id: 'ou_other' } })];
    expect(isUserMentioned(mentions as any, 'ou_not_found')).toBe(false);
  });

  it('should return false for mention without id', () => {
    const mentions = [{ key: 'test' }];
    expect(isUserMentioned(mentions as any, 'ou_123')).toBe(false);
  });

  it('should check across multiple mentions', () => {
    const mentions = [
      createMention({ id: { open_id: 'ou_1' } }),
      createMention({ id: { open_id: 'ou_2' } }),
      createMention({ id: { open_id: 'ou_3' } }),
    ];
    expect(isUserMentioned(mentions as any, 'ou_2')).toBe(true);
  });
});

describe('extractMentionedOpenIds', () => {
  it('should return empty array for undefined mentions', () => {
    expect(extractMentionedOpenIds(undefined)).toEqual([]);
  });

  it('should return empty array for null mentions', () => {
    expect(extractMentionedOpenIds(null)).toEqual([]);
  });

  it('should return empty array for empty mentions array', () => {
    expect(extractMentionedOpenIds([])).toEqual([]);
  });

  it('should extract all open_ids', () => {
    const mentions = [
      createMention({ id: { open_id: 'ou_1' } }),
      createMention({ id: { open_id: 'ou_2' } }),
      createMention({ id: { open_id: 'ou_3' } }),
    ];
    expect(extractMentionedOpenIds(mentions as any)).toEqual(['ou_1', 'ou_2', 'ou_3']);
  });

  it('should skip mentions without open_id', () => {
    const mentions = [
      createMention({ id: { open_id: 'ou_valid' } }),
      { id: { union_id: 'on_x' }, name: 'NoOpenId' },
    ];
    expect(extractMentionedOpenIds(mentions as any)).toEqual(['ou_valid']);
  });
});

describe('normalizeMentionPlaceholders', () => {
  it('should return original text when no mentions', () => {
    expect(normalizeMentionPlaceholders('hello world', undefined)).toBe('hello world');
  });

  it('should return original text when mentions array is empty', () => {
    expect(normalizeMentionPlaceholders('hello world', [])).toBe('hello world');
  });

  it('should replace ${key} placeholders with @Name', () => {
    const text = 'Hello ${@_user_1}, please help';
    const mentions = [createMention({ key: '@_user_1', name: 'Alice' })];

    const result = normalizeMentionPlaceholders(text, mentions as any);
    expect(result).toBe('Hello @Alice, please help');
  });

  it('should replace multiple placeholders', () => {
    const text = '${@_u1} and ${@_u2} are here';
    const mentions = [
      createMention({ key: '@_u1', name: 'Alice' }),
      createMention({ key: '@_u2', name: 'Bob' }),
    ];

    const result = normalizeMentionPlaceholders(text, mentions as any);
    expect(result).toBe('@Alice and @Bob are here');
  });

  it('should skip mentions without key or name', () => {
    const text = 'Hello ${@_u1}';
    const mentions = [createMention({ key: undefined, name: 'Alice' })];

    const result = normalizeMentionPlaceholders(text, mentions as any);
    expect(result).toBe('Hello ${@_u1}');
  });

  it('should handle special regex characters in key', () => {
    const text = 'Hello ${@_user.1}';
    const mentions = [createMention({ key: '@_user.1', name: 'DotUser' })];

    const result = normalizeMentionPlaceholders(text, mentions as any);
    expect(result).toBe('Hello @DotUser');
  });
});

describe('stripLeadingMentions', () => {
  it('should return original text when text is empty', () => {
    expect(stripLeadingMentions('', [])).toBe('');
  });

  it('should return original text when no leading mention', () => {
    expect(stripLeadingMentions('hello world', [])).toBe('hello world');
  });

  it('should strip <at> tag format from start', () => {
    const text = '<at user_id="ou_123">@Bot</at> /help';
    const result = stripLeadingMentions(text, null);
    expect(result).toBe('/help');
  });

  it('should strip ${key} placeholder from start', () => {
    const text = '${@_user_1} /help me';
    const mentions = [createMention({ key: '@_user_1', name: 'Bot' })];
    const result = stripLeadingMentions(text, mentions as any);
    expect(result).toBe('/help me');
  });

  it('should strip simple @Name format from start', () => {
    const text = '@Bot /help me';
    const result = stripLeadingMentions(text, null);
    expect(result).toBe('/help me');
  });

  it('should strip multiple leading mentions', () => {
    const text = '<at user_id="ou_1">@Alice</at> <at user_id="ou_2">@Bob</at> hello';
    const result = stripLeadingMentions(text, null);
    expect(result).toBe('hello');
  });

  it('should handle text with only mentions', () => {
    const text = '<at user_id="ou_1">@Alice</at>';
    const result = stripLeadingMentions(text, null);
    expect(result).toBe('');
  });

  it('should not strip mentions from middle of text', () => {
    const text = 'hello <at user_id="ou_1">@Alice</at> world';
    const result = stripLeadingMentions(text, null);
    expect(result).toBe('hello <at user_id="ou_1">@Alice</at> world');
  });

  it('should trim whitespace after stripping', () => {
    const text = '<at user_id="ou_1">@Bot</at>   /help';
    const result = stripLeadingMentions(text, null);
    expect(result).toBe('/help');
  });

  it('should handle mixed mention formats in sequence', () => {
    const text = '@Bot1 ${@_u2} /command';
    const mentions = [createMention({ key: '@_u2', name: 'Bot2' })];
    const result = stripLeadingMentions(text, mentions as any);
    expect(result).toBe('/command');
  });
});
