/**
 * Tests for mention-parser (packages/core/src/utils/mention-parser.ts)
 *
 * Issue #1617 Phase 2: Tests for Feishu @mention parsing utilities.
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

// ============================================================================
// Helpers
// ============================================================================

/** Create a mock mentions array from the FeishuMessageEvent type. */
function createMention(overrides: Partial<FeishuMessageEvent['message']['mentions'][number]> = {}) {
  return {
    key: '@_user_1',
    id: {
      open_id: 'ou_abc123',
      union_id: 'on_xyz789',
      user_id: 'uid_001',
      ...overrides.id,
    },
    name: 'Test User',
    tenant_key: 'tenant_001',
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

  it('should parse a single mention', () => {
    const mentions = [createMention()];
    const result = parseMentions(mentions);

    expect(result).toHaveLength(1);
    expect(result[0].openId).toBe('ou_abc123');
    expect(result[0].unionId).toBe('on_xyz789');
    expect(result[0].userId).toBe('uid_001');
    expect(result[0].name).toBe('Test User');
    expect(result[0].key).toBe('@_user_1');
  });

  it('should parse multiple mentions', () => {
    const mentions = [
      createMention({ id: { open_id: 'ou_1', union_id: 'on_1', user_id: 'uid_1' }, name: 'User 1', key: '@_u1' }),
      createMention({ id: { open_id: 'ou_2', union_id: 'on_2', user_id: 'uid_2' }, name: 'User 2', key: '@_u2' }),
    ];
    const result = parseMentions(mentions);

    expect(result).toHaveLength(2);
    expect(result[0].openId).toBe('ou_1');
    expect(result[1].openId).toBe('ou_2');
  });

  it('should skip mentions without open_id', () => {
    const mentions = [
      createMention({ id: { open_id: '', union_id: 'on_1', user_id: 'uid_1' } }),
      createMention({ id: { open_id: 'ou_valid', union_id: 'on_2', user_id: 'uid_2' } }),
    ];
    const result = parseMentions(mentions);

    expect(result).toHaveLength(1);
    expect(result[0].openId).toBe('ou_valid');
  });

  it('should skip mentions with null/undefined id', () => {
    const mentions = [
      { key: 'k1', name: 'No ID', tenant_key: 't1', id: null } as any,
      { key: 'k2', name: 'No ID 2', tenant_key: 't2', id: undefined } as any,
      createMention({ id: { open_id: 'ou_valid' } }),
    ];
    const result = parseMentions(mentions);

    expect(result).toHaveLength(1);
    expect(result[0].openId).toBe('ou_valid');
  });

  it('should handle mentions with partial id fields', () => {
    const mentions = [
      createMention({
        id: { open_id: 'ou_partial' },
        name: 'Partial',
        key: '@_partial',
      }),
    ];
    const result = parseMentions(mentions);

    expect(result).toHaveLength(1);
    expect(result[0].openId).toBe('ou_partial');
    expect(result[0].unionId).toBeUndefined();
    expect(result[0].userId).toBeUndefined();
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

  it('should return true when open_id matches', () => {
    const mentions = [createMention({ id: { open_id: 'ou_target' } })];
    expect(isUserMentioned(mentions, 'ou_target')).toBe(true);
  });

  it('should return true when union_id matches', () => {
    const mentions = [createMention({ id: { open_id: 'ou_abc', union_id: 'on_target' } })];
    expect(isUserMentioned(mentions, 'on_target')).toBe(true);
  });

  it('should return true when user_id matches', () => {
    const mentions = [createMention({ id: { open_id: 'ou_abc', user_id: 'uid_target' } })];
    expect(isUserMentioned(mentions, 'uid_target')).toBe(true);
  });

  it('should return false when no id matches', () => {
    const mentions = [createMention({ id: { open_id: 'ou_other', union_id: 'on_other' } })];
    expect(isUserMentioned(mentions, 'ou_different')).toBe(false);
  });

  it('should handle mentions with null id gracefully', () => {
    const mentions = [
      { key: 'k1', name: 'No ID', id: null, tenant_key: 't1' } as any,
    ];
    expect(isUserMentioned(mentions, 'anything')).toBe(false);
  });

  it('should check all mentions in array', () => {
    const mentions = [
      createMention({ id: { open_id: 'ou_1' } }),
      createMention({ id: { open_id: 'ou_2' } }),
      createMention({ id: { open_id: 'ou_target' } }),
    ];
    expect(isUserMentioned(mentions, 'ou_target')).toBe(true);
  });
});

describe('extractMentionedOpenIds', () => {
  it('should return empty array for undefined mentions', () => {
    expect(extractMentionedOpenIds(undefined)).toEqual([]);
  });

  it('should return empty array for null mentions', () => {
    expect(extractMentionedOpenIds(null)).toEqual([]);
  });

  it('should return empty array for empty mentions', () => {
    expect(extractMentionedOpenIds([])).toEqual([]);
  });

  it('should extract open_ids from mentions', () => {
    const mentions = [
      createMention({ id: { open_id: 'ou_1' } }),
      createMention({ id: { open_id: 'ou_2' } }),
      createMention({ id: { open_id: 'ou_3' } }),
    ];
    const result = extractMentionedOpenIds(mentions);

    expect(result).toEqual(['ou_1', 'ou_2', 'ou_3']);
  });

  it('should skip mentions without open_id', () => {
    const mentions = [
      createMention({ id: { open_id: '' } }),
      createMention({ id: { open_id: 'ou_valid' } }),
      { key: 'k', name: 'N', id: null, tenant_key: 't' } as any,
    ];
    const result = extractMentionedOpenIds(mentions);

    expect(result).toEqual(['ou_valid']);
  });
});

describe('normalizeMentionPlaceholders', () => {
  it('should return original text when no mentions provided', () => {
    expect(normalizeMentionPlaceholders('hello world', undefined)).toBe('hello world');
    expect(normalizeMentionPlaceholders('hello world', null)).toBe('hello world');
    expect(normalizeMentionPlaceholders('hello world', [])).toBe('hello world');
  });

  it('should replace ${key} placeholders with @Name', () => {
    const mentions = [
      createMention({ key: '@_user_1', name: 'Alice' }),
    ];
    const result = normalizeMentionPlaceholders('${@_user_1} hello', mentions);

    expect(result).toBe('@Alice hello');
  });

  it('should handle multiple placeholders', () => {
    const mentions = [
      createMention({ key: '@_u1', name: 'Alice' }),
      createMention({ key: '@_u2', name: 'Bob' }),
    ];
    const result = normalizeMentionPlaceholders('${@_u1} says hi to ${@_u2}', mentions);

    expect(result).toBe('@Alice says hi to @Bob');
  });

  it('should not modify text without placeholders', () => {
    const mentions = [createMention({ key: '@_u1', name: 'Alice' })];
    const result = normalizeMentionPlaceholders('hello world', mentions);

    expect(result).toBe('hello world');
  });

  it('should preserve <at> tags as-is', () => {
    const mentions = [createMention({ key: '@_u1', name: 'Alice' })];
    const result = normalizeMentionPlaceholders('<at user_id="ou_123">@Alice</at> hello', mentions);

    expect(result).toBe('<at user_id="ou_123">@Alice</at> hello');
  });

  it('should skip mentions without key or name', () => {
    const mentions = [
      { key: '', name: 'Alice', id: { open_id: 'ou_1' }, tenant_key: 't1' } as any,
      { key: '@_u1', name: '', id: { open_id: 'ou_2' }, tenant_key: 't2' } as any,
    ];
    const result = normalizeMentionPlaceholders('${@_u1} hello', mentions);

    // No replacement should occur since the mention with key has no name
    expect(result).toBe('${@_u1} hello');
  });

  it('should handle special regex characters in keys', () => {
    const mentions = [
      createMention({ key: '@_user$1', name: 'Special' }),
    ];
    const result = normalizeMentionPlaceholders('${@_user$1} text', mentions);

    expect(result).toBe('@Special text');
  });
});

describe('stripLeadingMentions', () => {
  it('should return original text for empty/undefined text', () => {
    expect(stripLeadingMentions('', null)).toBe('');
    expect(stripLeadingMentions('  ', undefined)).toBe('');
  });

  it('should strip <at> tag mentions from start', () => {
    const text = '<at user_id="ou_123">@Bot</at> /help';
    const result = stripLeadingMentions(text, null);

    expect(result).toBe('/help');
  });

  it('should strip ${key} placeholder mentions from start', () => {
    const mentions = [createMention({ key: '@_bot', name: 'Bot' })];
    const result = stripLeadingMentions('${@_bot} /help', mentions);

    expect(result).toBe('/help');
  });

  it('should strip simple @Name mentions from start', () => {
    const result = stripLeadingMentions('@Bot /help', null);

    expect(result).toBe('/help');
  });

  it('should strip multiple leading mentions', () => {
    const mentions = [
      createMention({ key: '@_u1', name: 'Alice' }),
      createMention({ key: '@_u2', name: 'Bob' }),
    ];
    const result = stripLeadingMentions('${@_u1} ${@_u2} /command arg', mentions);

    expect(result).toBe('/command arg');
  });

  it('should strip mixed mention formats from start', () => {
    const mentions = [createMention({ key: '@_bot', name: 'Bot' })];
    const result = stripLeadingMentions('<at user_id="ou_123">@Bot</at> ${@_bot} @Bot /help', mentions);

    expect(result).toBe('/help');
  });

  it('should not strip mentions in the middle of text', () => {
    const result = stripLeadingMentions('hello @Bot world', null);

    expect(result).toBe('hello @Bot world');
  });

  it('should handle text with only mentions', () => {
    const result = stripLeadingMentions('@Bot @User', null);

    expect(result).toBe('');
  });

  it('should preserve text after mentions with trimming', () => {
    const result = stripLeadingMentions('@Bot   /status  ', null);

    expect(result).toBe('/status');
  });

  it('should not strip non-mention text from start', () => {
    const result = stripLeadingMentions('hello world', null);

    expect(result).toBe('hello world');
  });

  it('should handle <at> tags with various attributes', () => {
    const text = '<at user_id="ou_1" tenant_key="t1">@User</at> message';
    const result = stripLeadingMentions(text, null);

    expect(result).toBe('message');
  });
});
