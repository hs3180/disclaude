import { describe, expect, it } from 'vitest';
import {
  readContentModerationFailure,
  readTerminalContentModerationFailure,
} from './moderation-recovery.js';

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

describe('readTerminalContentModerationFailure (#5463 rework 2)', () => {
  it('finds the verdict in whichever text channel carried it to the host', () => {
    // Incident shape: the claude adapter maps the is_error result text into
    // `content` while `terminationDetail` may stay generic.
    expect(
      readTerminalContentModerationFailure({
        content: 'API Error: 400 "provider" 敏感内容 [1301]',
        terminationDetail: 'claude sdk turn failed',
      })?.code
    ).toBe('1301');
    // Codex shape: the verdict survives only inside the termination detail.
    expect(
      readTerminalContentModerationFailure({
        content: '❌ Codex turn failed',
        terminationDetail: 'codex app-server turn failed: rejected [1301]',
      })?.code
    ).toBe('1301');
    // Stderr-derived upstream evidence (claude provider #4322 capture).
    expect(
      readTerminalContentModerationFailure({
        content: '',
        upstreamApiErrorStderr: 'provider rejected request [1301]',
      })?.code
    ).toBe('1301');
  });

  it('returns undefined for ordinary failures and empty channels', () => {
    expect(
      readTerminalContentModerationFailure({
        content: '❌ Codex turn failed: HTTP 429 rate limited',
        terminationDetail: 'codex app-server turn failed: HTTP 429',
        upstreamApiErrorStderr: 'API Error: 529 overloaded',
      })
    ).toBeUndefined();
    expect(readTerminalContentModerationFailure({})).toBeUndefined();
  });
});
