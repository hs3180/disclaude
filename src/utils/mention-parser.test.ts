/**
 * Tests for Mention Parser.
 *
 * Issue #689: 正确处理消息中的 mention
 */

import { describe, it, expect } from 'vitest';
import {
  parseMentions,
  isUserMentioned,
  extractMentionedOpenIds,
  normalizeMentionPlaceholders,
} from './mention-parser.js';
import type { FeishuMessageEvent } from '../types/platform.js';

// Helper to create mock mentions
function createMockMention(
  key: string,
  openId: string,
  name?: string
): NonNullable<FeishuMessageEvent['message']['mentions']>[0] {
  return {
    key,
    id: {
      open_id: openId,
      union_id: `union_${openId}`,
      user_id: `user_${openId}`,
    },
    name: name || `User_${openId.slice(0, 8)}`,
    tenant_key: 'tenant_123',
  };
}

describe('parseMentions', () => {
  it('should return empty array for undefined mentions', () => {
    const result = parseMentions(undefined);
    expect(result).toEqual([]);
  });

  it('should return empty array for null mentions', () => {
    const result = parseMentions(null as any);
    expect(result).toEqual([]);
  });

  it('should return empty array for empty mentions', () => {
    const result = parseMentions([]);
    expect(result).toEqual([]);
  });

  it('should parse single mention correctly', () => {
    const mentions = [createMockMention('@_user', 'ou_abc123', 'Alice')];
    const result = parseMentions(mentions);

    expect(result).toHaveLength(1);
    expect(result[0].openId).toBe('ou_abc123');
    expect(result[0].name).toBe('Alice');
  });

  it('should parse multiple mentions correctly', () => {
    const mentions = [
      createMockMention('@_user1', 'ou_abc123', 'Alice'),
      createMockMention('@_user2', 'ou_def456', 'Bob'),
      createMockMention('@_user3', 'ou_ghi789', 'Charlie'),
    ];
    const result = parseMentions(mentions);

    expect(result).toHaveLength(3);
    expect(result[0].openId).toBe('ou_abc123');
    expect(result[1].openId).toBe('ou_def456');
    expect(result[2].openId).toBe('ou_ghi789');
  });

  it('should handle mention with missing fields', () => {
    const mentions = [
      {
        key: '@_user',
        id: {
          open_id: 'ou_abc123',
          union_id: '',
          user_id: '',
        },
        name: '',
        tenant_key: 'tenant_123',
      },
    ];
    const result = parseMentions(mentions);

    expect(result).toHaveLength(1);
    expect(result[0].openId).toBe('ou_abc123');
  });
});

describe('isUserMentioned', () => {
  it('should return false for undefined mentions', () => {
    expect(isUserMentioned(undefined, 'ou_abc123')).toBe(false);
  });

  it('should return false when user is not mentioned', () => {
    const mentions = [createMockMention('@_user', 'ou_other', 'Bob')];
    expect(isUserMentioned(mentions, 'ou_abc123')).toBe(false);
  });

  it('should return true when user is mentioned by open_id', () => {
    const mentions = [createMockMention('@_user', 'ou_abc123', 'Alice')];
    expect(isUserMentioned(mentions, 'ou_abc123')).toBe(true);
  });

  it('should return true when user is mentioned by union_id', () => {
    const mentions = [createMockMention('@_user', 'ou_abc123', 'Alice')];
    expect(isUserMentioned(mentions, 'union_ou_abc123')).toBe(true);
  });

  it('should return true when user is mentioned by user_id', () => {
    const mentions = [createMockMention('@_user', 'ou_abc123', 'Alice')];
    expect(isUserMentioned(mentions, 'user_ou_abc123')).toBe(true);
  });

  it('should handle multiple mentions', () => {
    const mentions = [
      createMockMention('@_user1', 'ou_abc123', 'Alice'),
      createMockMention('@_user2', 'ou_def456', 'Bob'),
    ];
    expect(isUserMentioned(mentions, 'ou_abc123')).toBe(true);
    expect(isUserMentioned(mentions, 'ou_def456')).toBe(true);
    expect(isUserMentioned(mentions, 'ou_other')).toBe(false);
  });
});

describe('extractMentionedOpenIds', () => {
  it('should return empty array for undefined mentions', () => {
    expect(extractMentionedOpenIds(undefined)).toEqual([]);
  });

  it('should extract single open_id', () => {
    const mentions = [createMockMention('@_user', 'ou_abc123', 'Alice')];
    expect(extractMentionedOpenIds(mentions)).toEqual(['ou_abc123']);
  });

  it('should extract multiple open_ids', () => {
    const mentions = [
      createMockMention('@_user1', 'ou_abc123', 'Alice'),
      createMockMention('@_user2', 'ou_def456', 'Bob'),
      createMockMention('@_user3', 'ou_ghi789', 'Charlie'),
    ];
    expect(extractMentionedOpenIds(mentions)).toEqual(['ou_abc123', 'ou_def456', 'ou_ghi789']);
  });

  it('should filter out empty open_ids', () => {
    const mentions = [
      createMockMention('@_user1', 'ou_abc123', 'Alice'),
      {
        key: '@_user2',
        id: {
          open_id: '',
          union_id: '',
          user_id: '',
        },
        name: '',
        tenant_key: '',
      },
    ];
    expect(extractMentionedOpenIds(mentions)).toEqual(['ou_abc123']);
  });
});

describe('normalizeMentionPlaceholders', () => {
  it('should return original text for undefined mentions', () => {
    const text = 'Hello world';
    expect(normalizeMentionPlaceholders(text, undefined)).toBe(text);
  });

  it('should return original text when no mentions', () => {
    const text = 'Hello world';
    expect(normalizeMentionPlaceholders(text, [])).toBe(text);
  });

  it('should replace placeholder with @mention', () => {
    const text = 'Hello ${@_user} how are you?';
    const mentions = [createMockMention('@_user', 'ou_abc123', 'Alice')];
    const result = normalizeMentionPlaceholders(text, mentions);
    expect(result).toBe('Hello @Alice how are you?');
  });

  it('should handle multiple placeholders', () => {
    const text = 'Hello ${@_user1} and ${@_user2}';
    const mentions = [
      createMockMention('@_user1', 'ou_abc123', 'Alice'),
      createMockMention('@_user2', 'ou_def456', 'Bob'),
    ];
    const result = normalizeMentionPlaceholders(text, mentions);
    expect(result).toBe('Hello @Alice and @Bob');
  });

  it('should preserve already normalized mentions', () => {
    const text = 'Hello <at user_id="ou_abc123">@Alice</at> how are you?';
    const mentions = [createMockMention('@_user', 'ou_abc123', 'Alice')];
    const result = normalizeMentionPlaceholders(text, mentions);
    // Should keep the original format
    expect(result).toContain('@Alice');
  });

  it('should handle special regex characters in key', () => {
    const text = 'Hello ${@_user.test} how are you?';
    const mentions = [createMockMention('@_user.test', 'ou_abc123', 'Alice')];
    const result = normalizeMentionPlaceholders(text, mentions);
    expect(result).toBe('Hello @Alice how are you?');
  });
});
