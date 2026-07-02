/**
 * Tests for the Feishu message filters (Issue #4126).
 *
 * Covers all branches of evaluateMessageFilters: pass, duplicate, bot
 * (both ignored and bot-to-bot @mention allowed), and old. Pure unit
 * tests with no Feishu channel or I/O dependencies.
 */

import { describe, it, expect } from 'vitest';
import { evaluateMessageFilters } from './message-filters.js';

const deps = (opts: { processed?: boolean; maxAge?: number } = {}) => ({
  isProcessed: () => opts.processed ?? false,
  maxMessageAge: opts.maxAge ?? 60_000,
});

describe('evaluateMessageFilters', () => {
  it('passes a normal, fresh, non-duplicate user message', () => {
    const verdict = evaluateMessageFilters(
      { messageId: 'm1', createTime: Date.now() - 1_000, senderType: 'user', botMentionsUs: false },
      deps(),
    );
    expect(verdict).toEqual({ passed: true });
  });

  it('filters a duplicate message', () => {
    const verdict = evaluateMessageFilters(
      { messageId: 'dup', createTime: Date.now(), senderType: 'user', botMentionsUs: false },
      deps({ processed: true }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toBe('duplicate');
  });

  it('filters a bot message that does not mention our bot', () => {
    const verdict = evaluateMessageFilters(
      { messageId: 'm2', createTime: Date.now(), senderType: 'app', botMentionsUs: false },
      deps(),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toBe('bot');
  });

  it('allows through a bot message that @mentions our bot (bot-to-bot, #1742)', () => {
    const verdict = evaluateMessageFilters(
      { messageId: 'm3', createTime: Date.now(), senderType: 'app', botMentionsUs: true },
      deps(),
    );
    expect(verdict).toEqual({ passed: true });
  });

  it('filters a stale message and reports its age', () => {
    const age = 120_000;
    const verdict = evaluateMessageFilters(
      { messageId: 'm4', createTime: Date.now() - age, senderType: 'user', botMentionsUs: false },
      deps({ maxAge: 60_000 }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toBe('old');
    expect(verdict.age).toBe(age);
  });

  it('passes when create_time is absent (age check skipped)', () => {
    const verdict = evaluateMessageFilters(
      { messageId: 'm5', senderType: 'user', botMentionsUs: false },
      deps(),
    );
    expect(verdict).toEqual({ passed: true });
  });

  it('dedup takes precedence over bot and age', () => {
    const verdict = evaluateMessageFilters(
      { messageId: 'dup', createTime: Date.now() - 999_999, senderType: 'app', botMentionsUs: false },
      deps({ processed: true, maxAge: 1 }),
    );
    expect(verdict.reason).toBe('duplicate');
  });

  it('bot filter takes precedence over age', () => {
    const verdict = evaluateMessageFilters(
      { messageId: 'm6', createTime: Date.now() - 999_999, senderType: 'app', botMentionsUs: false },
      deps({ maxAge: 1 }),
    );
    expect(verdict.reason).toBe('bot');
  });
});
