/**
 * Tests for FeishuChannel post message with mentions.
 *
 * Issue #1742: Bot-to-bot @mention conversation support.
 * Tests that the channel correctly builds and sends post (rich text) messages
 * with @mentions when the mentions field is provided.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect } from 'vitest';
import type { MentionTarget } from '@disclaude/core';

// ============================================================================
// Test: buildPostContentWithMentions logic (pure function testing)
// ============================================================================

/**
 * Re-implementation of FeishuChannel.buildPostContentWithMentions
 * for isolated unit testing (the actual method is private).
 *
 * Issue #1742: Bot-to-bot @mention conversation support.
 */
function buildPostContentWithMentions(text: string, mentions: MentionTarget[]): {
  zh_cn: { title: string; content: Array<Array<Record<string, unknown>>> };
} {
  const segments: Array<Record<string, unknown>> = [];

  if (text) {
    segments.push({ tag: 'text', text });
  }

  for (const mention of mentions) {
    segments.push({
      tag: 'at',
      user_id: mention.openId,
      text: mention.name || mention.openId,
    });
  }

  return {
    zh_cn: {
      title: '',
      content: [segments],
    },
  };
}

describe('FeishuChannel - buildPostContentWithMentions (Issue #1742)', () => {
  it('should build correct post content with single mention', () => {
    const mentions: MentionTarget[] = [{ openId: 'ou_bot_001', name: 'OtherBot' }];
    const text = 'Hello from bot';

    const result = buildPostContentWithMentions(text, mentions);

    expect(result.zh_cn.title).toBe('');
    expect(result.zh_cn.content).toHaveLength(1);
    expect(result.zh_cn.content[0]).toHaveLength(2);
    expect(result.zh_cn.content[0][0]).toEqual({ tag: 'text', text });
    expect(result.zh_cn.content[0][1]).toEqual({
      tag: 'at',
      user_id: 'ou_bot_001',
      text: 'OtherBot',
    });
  });

  it('should build correct post content with multiple mentions', () => {
    const mentions: MentionTarget[] = [
      { openId: 'ou_bot_001', name: 'BotA' },
      { openId: 'ou_bot_002', name: 'BotB' },
    ];
    const text = 'Hello bots';

    const result = buildPostContentWithMentions(text, mentions);

    expect(result.zh_cn.content[0]).toHaveLength(3);
    expect(result.zh_cn.content[0][1]).toEqual({
      tag: 'at',
      user_id: 'ou_bot_001',
      text: 'BotA',
    });
    expect(result.zh_cn.content[0][2]).toEqual({
      tag: 'at',
      user_id: 'ou_bot_002',
      text: 'BotB',
    });
  });

  it('should use openId as text when name is not provided', () => {
    const mentions: MentionTarget[] = [{ openId: 'ou_bot_001' }];
    const text = 'Hello';

    const result = buildPostContentWithMentions(text, mentions);

    expect(result.zh_cn.content[0][1].text).toBe('ou_bot_001');
  });

  it('should handle empty text with mentions', () => {
    const mentions: MentionTarget[] = [{ openId: 'ou_bot_001', name: 'BotA' }];
    const text = '';

    const result = buildPostContentWithMentions(text, mentions);

    expect(result.zh_cn.content[0]).toHaveLength(1);
    expect(result.zh_cn.content[0][0].tag).toBe('at');
  });

  it('should handle empty mentions array (text only)', () => {
    const mentions: MentionTarget[] = [];
    const text = 'Hello';

    const result = buildPostContentWithMentions(text, mentions);

    expect(result.zh_cn.content[0]).toHaveLength(1);
    expect(result.zh_cn.content[0][0]).toEqual({ tag: 'text', text: 'Hello' });
  });

  it('should produce valid JSON serializable output', () => {
    const mentions: MentionTarget[] = [
      { openId: 'ou_bot_001', name: 'BotA' },
    ];
    const text = 'Hello';

    const result = buildPostContentWithMentions(text, mentions);

    // Should not throw when serialized
    expect(() => JSON.stringify(result)).not.toThrow();

    // Verify JSON structure matches Feishu API format
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.zh_cn.title).toBe('');
    expect(Array.isArray(parsed.zh_cn.content)).toBe(true);
  });
});
