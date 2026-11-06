import { describe, expect, it } from 'vitest';
import {
  ModerationRecoveryLimiter,
  readContentModerationFailure,
  readModerationRecoveryPolicy,
} from './moderation-recovery.js';
import { readCodexModerationRecoveryPolicy } from './providers/codex/moderation-recovery.js';

describe('readContentModerationFailure (#5463)', () => {
  it('classifies the Z.ai [1301] verdict from a failed-result error string', () => {
    const failure = readContentModerationFailure(
      'API Error: 400 "provider" 系统检测到输入或生成内容可能包含不安全或敏感内容 [1301]'
    );
    expect(failure).toEqual({
      code: '1301',
      message: 'API Error: 400 "provider" 系统检测到输入或生成内容可能包含不安全或敏感内容 [1301]',
    });
  });

  it('classifies the verdict from an error object message or additionalDetails', () => {
    expect(
      readContentModerationFailure({ message: 'upstream content moderation rejected the request [1301]' })
    ).toEqual({ code: '1301', message: 'upstream content moderation rejected the request [1301]' });
    expect(readContentModerationFailure({ message: '', additionalDetails: 'provider [1301] rejected' })).toEqual({
      code: '1301',
      message: '\nprovider [1301] rejected',
    });
  });

  it('keeps capacity, overload and output-cap failures out of the moderation class', () => {
    expect(readContentModerationFailure('API Error: 429 "provider" capacity [1300]')).toBeUndefined();
    expect(readContentModerationFailure('API Error: 529 overloaded')).toBeUndefined();
    expect(readContentModerationFailure('Prompt is too long: 210000 tokens > 200000 maximum')).toBeUndefined();
    expect(readContentModerationFailure(undefined)).toBeUndefined();
    expect(readContentModerationFailure(42)).toBeUndefined();
    expect(readContentModerationFailure({ message: 'ECONNRESET' })).toBeUndefined();
  });
});

describe('readModerationRecoveryPolicy', () => {
  it('defaults to an empty fallback chain and a two-per-hour cap', () => {
    expect(readModerationRecoveryPolicy({})).toEqual({ fallbackModels: [], maxPerChatPerHour: 2 });
  });

  it('parses, trims, dedupes and orders the generic env chain', () => {
    const policy = readModerationRecoveryPolicy({
      DISCLAUDE_MODERATION_FALLBACK_MODELS: ' glm-4.7-flash , glm-4.7-flash,glm-5.2-air ',
      DISCLAUDE_MODERATION_MAX_PER_CHAT_PER_HOUR: '5',
    });
    expect(policy).toEqual({ fallbackModels: ['glm-4.7-flash', 'glm-5.2-air'], maxPerChatPerHour: 5 });
  });

  it('rejects malformed caps instead of guessing', () => {
    for (const malformed of ['-1', '2.5', 'NaN', 'three']) {
      expect(
        readModerationRecoveryPolicy({ DISCLAUDE_MODERATION_MAX_PER_CHAT_PER_HOUR: malformed })
          .maxPerChatPerHour
      ).toBe(2);
    }
    expect(
      readModerationRecoveryPolicy({ DISCLAUDE_MODERATION_MAX_PER_CHAT_PER_HOUR: '0' }).maxPerChatPerHour
    ).toBe(0);
    // Round-1 semantics: Number('') === 0, i.e. an empty value disables
    // recoveries rather than falling back to the default.
    expect(
      readModerationRecoveryPolicy({ DISCLAUDE_MODERATION_MAX_PER_CHAT_PER_HOUR: '' })
        .maxPerChatPerHour
    ).toBe(0);
  });

  it('keeps the codex env contract on its own names (round-1 compatibility)', () => {
    // Codex must keep reading DISCLAUDE_CODEX_MODERATION_* and must NOT pick up
    // the generic names — otherwise a codex deployment silently changes policy.
    const policy = readCodexModerationRecoveryPolicy({
      DISCLAUDE_MODERATION_FALLBACK_MODELS: 'glm-4.7-flash',
      DISCLAUDE_CODEX_MODERATION_FALLBACK_MODELS: 'gpt-5.6-luna,gpt-5.6-luna',
      DISCLAUDE_CODEX_MODERATION_MAX_PER_CHAT_PER_HOUR: '3',
    });
    expect(policy).toEqual({ fallbackModels: ['gpt-5.6-luna'], maxPerChatPerHour: 3 });
    expect(readCodexModerationRecoveryPolicy({ DISCLAUDE_MODERATION_MAX_PER_CHAT_PER_HOUR: '9' })).toEqual({
      fallbackModels: [],
      maxPerChatPerHour: 2,
    });
  });
});

describe('ModerationRecoveryLimiter', () => {
  it('admits up to the cap per chat in a rolling hour and forgets stale entries', () => {
    const limiter = new ModerationRecoveryLimiter();
    const policy = { fallbackModels: [], maxPerChatPerHour: 2 };
    const t0 = 1_700_000_000_000;
    expect(limiter.tryAcquire('chat-a', policy, t0)).toBe(true);
    expect(limiter.tryAcquire('chat-a', policy, t0 + 1)).toBe(true);
    expect(limiter.tryAcquire('chat-a', policy, t0 + 2)).toBe(false);
    // A different chat has its own budget; the first chat's entry ages out.
    expect(limiter.tryAcquire('chat-b', policy, t0 + 2)).toBe(true);
    expect(limiter.tryAcquire('chat-a', policy, t0 + 3_600_001)).toBe(true);
  });

  it('zero disables automatic recoveries entirely', () => {
    const limiter = new ModerationRecoveryLimiter();
    expect(limiter.tryAcquire('chat-a', { fallbackModels: [], maxPerChatPerHour: 0 })).toBe(false);
  });
});
