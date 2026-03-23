/**
 * Tests for mention parser utilities (packages/core/src/utils/mention-parser.ts)
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

// Helper to create a mention object
function createMention(overrides: Partial<NonNullable<MentionsArray>[number]> = {}): NonNullable<MentionsArray>[number] {
  return {
    key: '@_user_1',
    id: {
      open_id: 'ou_abc123',
      union_id: 'on_xyz789',
      user_id: 'uid_001',
    },
    name: 'TestUser',
    tenant_key: 'tk_default',
    ...overrides,
  };
}

describe('parseMentions', () => {
  describe('null and undefined input', () => {
    it('should return empty array for undefined mentions', () => {
      expect(parseMentions(undefined)).toEqual([]);
    });

    it('should return empty array for null mentions', () => {
      expect(parseMentions(null)).toEqual([]);
    });
  });

  describe('empty mentions array', () => {
    it('should return empty array for empty mentions', () => {
      expect(parseMentions([])).toEqual([]);
    });
  });

  describe('valid mentions with all fields', () => {
    it('should parse a single valid mention', () => {
      const mentions: MentionsArray = [createMention()];
      const result = parseMentions(mentions);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        openId: 'ou_abc123',
        unionId: 'on_xyz789',
        userId: 'uid_001',
        name: 'TestUser',
        key: '@_user_1',
      });
    });

    it('should parse multiple valid mentions', () => {
      const mentions: MentionsArray = [
        createMention({
          key: '@_user_1',
          id: { open_id: 'ou_1', union_id: 'on_1', user_id: 'uid_1' },
          name: 'Alice',
        }),
        createMention({
          key: '@_user_2',
          id: { open_id: 'ou_2', union_id: 'on_2', user_id: 'uid_2' },
          name: 'Bob',
        }),
      ];
      const result = parseMentions(mentions);

      expect(result).toHaveLength(2);
      expect(result[0].openId).toBe('ou_1');
      expect(result[0].name).toBe('Alice');
      expect(result[1].openId).toBe('ou_2');
      expect(result[1].name).toBe('Bob');
    });

    it('should include all fields from a mention', () => {
      const mentions: MentionsArray = [
        createMention({
          key: '@_user_special',
          id: { open_id: 'ou_special', union_id: 'on_special', user_id: 'uid_special' },
          name: 'Special User',
          tenant_key: 'tk_custom',
        }),
      ];
      const result = parseMentions(mentions);

      expect(result[0]).toEqual({
        openId: 'ou_special',
        unionId: 'on_special',
        userId: 'uid_special',
        name: 'Special User',
        key: '@_user_special',
      });
    });
  });

  describe('mentions without open_id', () => {
    it('should skip mention with empty open_id', () => {
      const mentions: MentionsArray = [
        createMention({ id: { open_id: '', union_id: 'on_1', user_id: 'uid_1' } }),
      ];
      const result = parseMentions(mentions);

      expect(result).toHaveLength(0);
    });

    it('should skip mention with missing id object', () => {
      const mentions = [
        { key: '@_user_1', name: 'TestUser', tenant_key: 'tk_1' },
      ] as unknown as MentionsArray;
      const result = parseMentions(mentions);

      expect(result).toHaveLength(0);
    });

    it('should skip mention with null id', () => {
      const mentions = [
        { key: '@_user_1', id: null, name: 'TestUser', tenant_key: 'tk_1' },
      ] as unknown as MentionsArray;
      const result = parseMentions(mentions);

      expect(result).toHaveLength(0);
    });

    it('should skip mention with undefined id', () => {
      const mentions = [
        { key: '@_user_1', id: undefined, name: 'TestUser', tenant_key: 'tk_1' },
      ] as unknown as MentionsArray;
      const result = parseMentions(mentions);

      expect(result).toHaveLength(0);
    });

    it('should skip null entries in the array', () => {
      const mentions = [null, createMention()] as unknown as MentionsArray;
      const result = parseMentions(mentions);

      expect(result).toHaveLength(1);
      expect(result[0].openId).toBe('ou_abc123');
    });

    it('should keep valid mentions while skipping invalid ones', () => {
      const mentions: MentionsArray = [
        createMention({ id: { open_id: 'ou_valid', union_id: '', user_id: '' } }),
        createMention({ id: { open_id: '', union_id: '', user_id: '' } }),
        createMention({ id: { open_id: 'ou_also_valid', union_id: '', user_id: '' } }),
      ];
      const result = parseMentions(mentions);

      expect(result).toHaveLength(2);
      expect(result[0].openId).toBe('ou_valid');
      expect(result[1].openId).toBe('ou_also_valid');
    });
  });

  describe('optional fields', () => {
    it('should handle mention with only open_id in id', () => {
      const mentions: MentionsArray = [
        createMention({
          id: { open_id: 'ou_only', union_id: '', user_id: '' },
          name: '',
          key: '',
        }),
      ];
      const result = parseMentions(mentions);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        openId: 'ou_only',
        unionId: '',
        userId: '',
        name: '',
        key: '',
      });
    });
  });
});

describe('isUserMentioned', () => {
  describe('null and undefined input', () => {
    it('should return false for undefined mentions', () => {
      expect(isUserMentioned(undefined, 'ou_abc123')).toBe(false);
    });

    it('should return false for null mentions', () => {
      expect(isUserMentioned(null, 'ou_abc123')).toBe(false);
    });

    it('should return false for empty mentions array', () => {
      expect(isUserMentioned([], 'ou_abc123')).toBe(false);
    });
  });

  describe('matching by open_id', () => {
    it('should return true when open_id matches', () => {
      const mentions: MentionsArray = [
        createMention({ id: { open_id: 'ou_target', union_id: 'on_1', user_id: 'uid_1' } }),
      ];

      expect(isUserMentioned(mentions, 'ou_target')).toBe(true);
    });

    it('should return false when open_id does not match', () => {
      const mentions: MentionsArray = [
        createMention({ id: { open_id: 'ou_other', union_id: 'on_1', user_id: 'uid_1' } }),
      ];

      expect(isUserMentioned(mentions, 'ou_target')).toBe(false);
    });
  });

  describe('matching by union_id', () => {
    it('should return true when union_id matches', () => {
      const mentions: MentionsArray = [
        createMention({ id: { open_id: 'ou_1', union_id: 'on_target', user_id: 'uid_1' } }),
      ];

      expect(isUserMentioned(mentions, 'on_target')).toBe(true);
    });
  });

  describe('matching by user_id', () => {
    it('should return true when user_id matches', () => {
      const mentions: MentionsArray = [
        createMention({ id: { open_id: 'ou_1', union_id: 'on_1', user_id: 'uid_target' } }),
      ];

      expect(isUserMentioned(mentions, 'uid_target')).toBe(true);
    });
  });

  describe('multiple mentions', () => {
    it('should check all mentions for a match', () => {
      const mentions: MentionsArray = [
        createMention({ id: { open_id: 'ou_first', union_id: 'on_first', user_id: 'uid_first' } }),
        createMention({ id: { open_id: 'ou_second', union_id: 'on_second', user_id: 'uid_second' } }),
      ];

      expect(isUserMentioned(mentions, 'ou_second')).toBe(true);
    });
  });

  describe('mentions without id', () => {
    it('should skip mentions with missing id', () => {
      const mentions = [
        { key: '@_user_1', name: 'TestUser', tenant_key: 'tk_1' },
      ] as unknown as MentionsArray;

      expect(isUserMentioned(mentions, 'ou_abc123')).toBe(false);
    });

    it('should skip null entries when checking', () => {
      const mentions = [null] as unknown as MentionsArray;

      expect(isUserMentioned(mentions, 'ou_abc123')).toBe(false);
    });
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

  it('should extract open_ids from valid mentions', () => {
    const mentions: MentionsArray = [
      createMention({ id: { open_id: 'ou_1', union_id: 'on_1', user_id: 'uid_1' } }),
      createMention({ id: { open_id: 'ou_2', union_id: 'on_2', user_id: 'uid_2' } }),
    ];

    expect(extractMentionedOpenIds(mentions)).toEqual(['ou_1', 'ou_2']);
  });

  it('should filter out mentions without open_id', () => {
    const mentions: MentionsArray = [
      createMention({ id: { open_id: 'ou_valid', union_id: 'on_1', user_id: 'uid_1' } }),
      createMention({ id: { open_id: '', union_id: 'on_2', user_id: 'uid_2' } }),
      createMention({ id: { open_id: 'ou_also_valid', union_id: 'on_3', user_id: 'uid_3' } }),
    ];

    expect(extractMentionedOpenIds(mentions)).toEqual(['ou_valid', 'ou_also_valid']);
  });

  it('should return empty array when all mentions lack open_id', () => {
    const mentions: MentionsArray = [
      createMention({ id: { open_id: '', union_id: 'on_1', user_id: 'uid_1' } }),
      createMention({ id: { open_id: '', union_id: 'on_2', user_id: 'uid_2' } }),
    ];

    expect(extractMentionedOpenIds(mentions)).toEqual([]);
  });

  it('should handle mentions with missing id object', () => {
    const mentions = [
      { key: '@_user_1', name: 'TestUser', tenant_key: 'tk_1' },
    ] as unknown as MentionsArray;

    expect(extractMentionedOpenIds(mentions)).toEqual([]);
  });
});

describe('normalizeMentionPlaceholders', () => {
  it('should return original text when mentions is undefined', () => {
    expect(normalizeMentionPlaceholders('hello world', undefined)).toBe('hello world');
  });

  it('should return original text when mentions is null', () => {
    expect(normalizeMentionPlaceholders('hello world', null)).toBe('hello world');
  });

  it('should return original text when mentions is empty', () => {
    expect(normalizeMentionPlaceholders('hello world', [])).toBe('hello world');
  });

  it('should replace ${key} placeholder with @Name', () => {
    const mentions: MentionsArray = [
      createMention({ key: '@_user_1', name: 'Alice' }),
    ];

    expect(normalizeMentionPlaceholders('${@_user_1} hello', mentions)).toBe('@Alice hello');
  });

  it('should replace multiple different ${key} placeholders', () => {
    const mentions: MentionsArray = [
      createMention({ key: '@_user_1', name: 'Alice' }),
      createMention({ key: '@_user_2', name: 'Bob' }),
    ];

    expect(normalizeMentionPlaceholders('${@_user_1} says hi to ${@_user_2}', mentions))
      .toBe('@Alice says hi to @Bob');
  });

  it('should replace all occurrences of the same placeholder', () => {
    const mentions: MentionsArray = [
      createMention({ key: '@_user_1', name: 'Alice' }),
    ];

    expect(normalizeMentionPlaceholders('${@_user_1} and ${@_user_1} again', mentions))
      .toBe('@Alice and @Alice again');
  });

  it('should not replace text that does not match a placeholder pattern', () => {
    const mentions: MentionsArray = [
      createMention({ key: '@_user_1', name: 'Alice' }),
    ];

    expect(normalizeMentionPlaceholders('no placeholders here', mentions)).toBe('no placeholders here');
  });

  it('should handle special characters in keys via regex escaping', () => {
    const mentions: MentionsArray = [
      createMention({ key: '@_user$pecial', name: 'SpecialUser' }),
    ];

    expect(normalizeMentionPlaceholders('${@_user$pecial} hello', mentions)).toBe('@SpecialUser hello');
  });

  it('should skip mentions without key', () => {
    const mentions: MentionsArray = [
      createMention({ key: '', name: 'Alice' }),
    ];

    expect(normalizeMentionPlaceholders('hello world', mentions)).toBe('hello world');
  });

  it('should skip mentions without name', () => {
    const mentions: MentionsArray = [
      createMention({ key: '@_user_1', name: '' }),
    ];

    expect(normalizeMentionPlaceholders('${@_user_1} hello', mentions)).toBe('${@_user_1} hello');
  });

  it('should leave <at> tags unchanged', () => {
    const mentions: MentionsArray = [
      createMention({ key: '@_user_1', name: 'Alice' }),
    ];

    expect(normalizeMentionPlaceholders('<at user_id="ou_1">@Alice</at> hello', mentions))
      .toBe('<at user_id="ou_1">@Alice</at> hello');
  });
});

describe('stripLeadingMentions', () => {
  describe('empty text', () => {
    it('should return empty string for empty text', () => {
      expect(stripLeadingMentions('', [])).toBe('');
    });

    it('should return whitespace-only text as empty', () => {
      expect(stripLeadingMentions('   ', [])).toBe('');
    });
  });

  describe('<at> tag format', () => {
    it('should strip leading <at> tag', () => {
      const text = '<at user_id="ou_1">@Alice</at> /help';
      expect(stripLeadingMentions(text, [])).toBe('/help');
    });

    it('should strip leading <at> tag with extra whitespace', () => {
      const text = '<at user_id="ou_1">@Alice</at>    /help';
      expect(stripLeadingMentions(text, [])).toBe('/help');
    });

    it('should strip multiple leading <at> tags', () => {
      const text = '<at user_id="ou_1">@Alice</at> <at user_id="ou_2">@Bob</at> /help';
      expect(stripLeadingMentions(text, [])).toBe('/help');
    });
  });

  describe('${key} placeholder format', () => {
    it('should strip leading ${key} placeholder', () => {
      const mentions: MentionsArray = [
        createMention({ key: '@_user_1', name: 'Alice' }),
      ];
      const text = '${@_user_1} /help';
      expect(stripLeadingMentions(text, mentions)).toBe('/help');
    });

    it('should strip multiple leading ${key} placeholders', () => {
      const mentions: MentionsArray = [
        createMention({ key: '@_user_1', name: 'Alice' }),
        createMention({ key: '@_user_2', name: 'Bob' }),
      ];
      const text = '${@_user_1} ${@_user_2} /help';
      expect(stripLeadingMentions(text, mentions)).toBe('/help');
    });

    it('should strip ${key} with extra whitespace', () => {
      const mentions: MentionsArray = [
        createMention({ key: '@_user_1', name: 'Alice' }),
      ];
      const text = '${@_user_1}    /help';
      expect(stripLeadingMentions(text, mentions)).toBe('/help');
    });
  });

  describe('@Name format', () => {
    it('should strip leading @Name mention', () => {
      const text = '@Alice /help';
      expect(stripLeadingMentions(text, [])).toBe('/help');
    });

    it('should strip multiple leading @Name mentions', () => {
      const text = '@Alice @Bob /help';
      expect(stripLeadingMentions(text, [])).toBe('/help');
    });

    it('should strip @Name with extra whitespace', () => {
      const text = '@Alice    /help';
      expect(stripLeadingMentions(text, [])).toBe('/help');
    });
  });

  describe('mixed format stripping', () => {
    it('should strip <at> tag followed by @Name', () => {
      const text = '<at user_id="ou_1">@Alice</at> @Bot /help';
      expect(stripLeadingMentions(text, [])).toBe('/help');
    });

    it('should strip ${key} followed by <at> tag', () => {
      const mentions: MentionsArray = [
        createMention({ key: '@_user_1', name: 'Alice' }),
      ];
      const text = '${@_user_1} <at user_id="ou_2">@Bob</at> /help';
      expect(stripLeadingMentions(text, mentions)).toBe('/help');
    });

    it('should strip all three formats in sequence', () => {
      const mentions: MentionsArray = [
        createMention({ key: '@_user_1', name: 'Alice' }),
      ];
      const text = '${@_user_1} <at user_id="ou_2">@Bob</at> @Charlie /help';
      expect(stripLeadingMentions(text, mentions)).toBe('/help');
    });
  });

  describe('text without leading mentions', () => {
    it('should not strip non-leading mentions', () => {
      const text = 'hello @Alice';
      expect(stripLeadingMentions(text, [])).toBe('hello @Alice');
    });

    it('should not strip mentions in the middle of text', () => {
      const text = 'hello <at user_id="ou_1">@Alice</at> world';
      expect(stripLeadingMentions(text, [])).toBe('hello <at user_id="ou_1">@Alice</at> world');
    });

    it('should return plain text without mentions unchanged', () => {
      const text = '/help me please';
      expect(stripLeadingMentions(text, [])).toBe('/help me please');
    });
  });

  describe('edge cases', () => {
    it('should handle text that is entirely a mention', () => {
      const text = '<at user_id="ou_1">@Alice</at>';
      expect(stripLeadingMentions(text, [])).toBe('');
    });

    it('should handle text that is entirely mentions', () => {
      const text = '@Alice @Bob @Charlie';
      expect(stripLeadingMentions(text, [])).toBe('');
    });

    it('should handle null mentions', () => {
      const text = '@Alice /help';
      expect(stripLeadingMentions(text, null)).toBe('/help');
    });

    it('should handle undefined mentions', () => {
      const text = '@Alice /help';
      expect(stripLeadingMentions(text, undefined)).toBe('/help');
    });

    it('should handle special characters in keys for placeholder stripping', () => {
      const mentions: MentionsArray = [
        createMention({ key: '@_user$pecial', name: 'SpecialUser' }),
      ];
      const text = '${@_user$pecial} /help';
      expect(stripLeadingMentions(text, mentions)).toBe('/help');
    });

    it('should handle @Name with complex characters', () => {
      const text = '@user-name_123 /help';
      expect(stripLeadingMentions(text, [])).toBe('/help');
    });
  });
});
