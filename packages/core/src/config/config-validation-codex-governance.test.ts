/**
 * Tests for validateConfig() — agent.codex governance caps (Issue #4634,
 * S7 of #4627). Non-positive caps must fail at config-load time (fail
 * closed) so a typo can never disable the bounds entirely.
 */
import { describe, it, expect } from 'vitest';
import { validateConfig } from './loader.js';
import type { DisclaudeConfig } from './types.js';

describe('validateConfig — agent.codex governance caps (Issue #4634)', () => {
  it('accepts positive caps', () => {
    expect(
      validateConfig({
        agent: { codex: { maxActiveSessions: 5, maxConcurrentRuns: 2 } },
      } as DisclaudeConfig),
    ).toBe(true);
  });

  it('accepts partial or absent caps (defaults apply in the governor)', () => {
    expect(
      validateConfig({ agent: { codex: { maxConcurrentRuns: 1 } } } as DisclaudeConfig),
    ).toBe(true);
    expect(validateConfig({ agent: { codex: {} } } as DisclaudeConfig)).toBe(true);
    expect(validateConfig({} as DisclaudeConfig)).toBe(true);
  });

  it('rejects zero / negative / non-finite caps (fail closed)', () => {
    expect(
      validateConfig({ agent: { codex: { maxActiveSessions: 0 } } } as DisclaudeConfig),
    ).toBe(false);
    expect(
      validateConfig({ agent: { codex: { maxConcurrentRuns: -1 } } } as DisclaudeConfig),
    ).toBe(false);
    expect(
      validateConfig({
        agent: { codex: { maxConcurrentRuns: Number.POSITIVE_INFINITY } },
      } as DisclaudeConfig),
    ).toBe(false);
  });
});
