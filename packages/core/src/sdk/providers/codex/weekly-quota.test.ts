/**
 * Unit tests for the codex weekly-quota ledger (#5607).
 *
 * The ledger is the entire estimation/calibration engine; time-dependent
 * behavior is driven through an injectable clock, so every tier transition
 * is asserted deterministically.
 */

import { describe, expect, it } from 'vitest';
import {
  CodexWeeklyQuotaLedger,
  CODEX_WEEKLY_WINDOW_MS,
  parseCodexResetHint,
  classifyCodexLimitWindow,
} from './weekly-quota.js';

function ledgerWithClock(config: ConstructorParameters<typeof CodexWeeklyQuotaLedger>[0] = {}) {
  let now = Date.UTC(2026, 10, 5, 12, 0, 0);
  const clock = (): number => now;
  const ledger = new CodexWeeklyQuotaLedger(config, clock);
  return {
    ledger,
    advance: (ms: number): void => { now += ms; },
    now: (): number => now,
  };
}

describe('parseCodexResetHint', () => {
  it('parses an absolute hint with an ordinal date', () => {
    const now = Date.UTC(2026, 3, 28);
    const deadline = new Date('Apr 30, 2026 11:21 AM').getTime();
    expect(deadline).toBeGreaterThan(now);
    expect(parseCodexResetHint("You've hit your usage limit. Try again at Apr 30th, 2026 11:21 AM.", now))
      .toEqual({ deadline, source: 'parsed' });
  });

  it('parses a relative hint with decimals', () => {
    const now = Date.UTC(2026, 10, 5);
    expect(parseCodexResetHint('usage limit reached — try again in 2.5 hours', now))
      .toEqual({ deadline: now + 2.5 * 3600_000, source: 'parsed' });
  });

  it('parses compound relative durations', () => {
    const now = Date.UTC(2026, 10, 5);
    expect(parseCodexResetHint('try again in 1 day and 2 hours', now))
      .toEqual({ deadline: now + 26 * 3600_000, source: 'parsed' });
  });

  it('returns undefined without a usable hint', () => {
    expect(parseCodexResetHint('usage limit reached. Upgrade to Plus.', 0)).toBeUndefined();
  });
});

describe('classifyCodexLimitWindow', () => {
  it('distinguishes weekly, five-hour, and unknown', () => {
    expect(classifyCodexLimitWindow('Your weekly usage limit resets soon')).toBe('weekly');
    expect(classifyCodexLimitWindow('You hit the 5 hour window limit')).toBe('five-hour');
    expect(classifyCodexLimitWindow('usage limit exceeded')).toBe('unknown');
  });
});

describe('CodexWeeklyQuotaLedger — observe-only mode (default)', () => {
  it('never gates on estimates without a budget', () => {
    const { ledger } = ledgerWithClock();
    ledger.recordUsage({ inputTokens: 10_000_000, outputTokens: 5_000_000 });
    expect(ledger.checkFreshSession({ nonInteractive: true })).toEqual({ decision: 'allow' });
    expect(ledger.checkFreshSession({ nonInteractive: false })).toEqual({ decision: 'allow' });
  });

  it('gates on a REAL weekly limit hit until the parsed reset, then recovers', () => {
    const { ledger, advance, now } = ledgerWithClock({ weeklyLimitCooldownMs: 60_000 });
    const future = new Date(now() + 3 * 3600_000);
    const text = `You've hit your usage limit. Try again at ${future.toUTCString()}.`;
    ledger.recordLimitHit(text);
    const gated = ledger.checkFreshSession({ nonInteractive: false });
    expect(gated.decision).toBe('degrade');
    if (gated.decision === 'degrade') {
      expect(gated.resetAt).toBe(future.getTime());
      expect(gated.reason).toContain('实证');
    }
    advance(3 * 3600_000 + 1);
    expect(ledger.checkFreshSession({ nonInteractive: false })).toEqual({ decision: 'allow' });
  });

  it('uses the conservative cooldown when no hint parses', () => {
    const { ledger, advance } = ledgerWithClock({ weeklyLimitCooldownMs: 60_000 });
    ledger.recordLimitHit('usage limit exceeded — upgrade your plan');
    const snapshot = ledger.snapshot();
    expect(snapshot.limitLatched).toBe(true);
    expect(snapshot.limitSource).toBe('conservative');
    expect(snapshot.limitWindow).toBe('unknown');
    expect(ledger.checkFreshSession({ nonInteractive: false }).decision).toBe('degrade');
    advance(60_001);
    expect(ledger.checkFreshSession({ nonInteractive: false }).decision).toBe('allow');
  });
});

describe('CodexWeeklyQuotaLedger — estimation tiers', () => {
  it('excludes cached input tokens from consumption', () => {
    const { ledger } = ledgerWithClock({ weeklyBudgetTokens: 1000 });
    ledger.recordUsage({ inputTokens: 1000, cachedInputTokens: 600, outputTokens: 100 });
    expect(ledger.snapshot().consumedTokens).toBe(500);
  });

  it('skips non-interactive fresh sessions in the tighten band, allows interactive ones', () => {
    const { ledger } = ledgerWithClock({
      weeklyBudgetTokens: 1000,
      weeklyTightenThreshold: 0.2,
      weeklyBlockThreshold: 0.05,
    });
    ledger.recordUsage({ inputTokens: 900, outputTokens: 0 }); // 10% remaining
    const skipped = ledger.checkFreshSession({ nonInteractive: true });
    expect(skipped.decision).toBe('skip');
    if (skipped.decision === 'skip') {
      expect(skipped.reason).toContain('估计');
      expect(skipped.reason).toContain('跳过');
    }
    // The skip is recorded — never silent.
    expect(ledger.snapshot().lastSkip?.reason).toContain('收紧');
    expect(ledger.checkFreshSession({ nonInteractive: false })).toEqual({ decision: 'allow' });
  });

  it('degrades every fresh session in the block band with labeled estimates', () => {
    const { ledger } = ledgerWithClock({ weeklyBudgetTokens: 1000, weeklyBlockThreshold: 0.05 });
    ledger.recordUsage({ inputTokens: 980, outputTokens: 0 }); // 2% remaining
    const degraded = ledger.checkFreshSession({ nonInteractive: false });
    expect(degraded.decision).toBe('degrade');
    if (degraded.decision === 'degrade') {
      expect(degraded.reason).toContain('估计');
      expect(degraded.reason).toContain('agentBackend');
      expect(degraded.resetAt).toBeGreaterThan(0);
    }
  });

  it('rolls the estimation window after a week', () => {
    const { ledger, advance } = ledgerWithClock({ weeklyBudgetTokens: 1000 });
    ledger.recordUsage({ inputTokens: 900, outputTokens: 0 });
    expect(ledger.snapshot().consumedTokens).toBe(900);
    advance(CODEX_WEEKLY_WINDOW_MS + 1);
    ledger.recordUsage({ inputTokens: 10, outputTokens: 0 });
    expect(ledger.snapshot().consumedTokens).toBe(10);
  });

  it('restarts the estimation window at the deadline on a weekly limit hit', () => {
    const { ledger, advance } = ledgerWithClock({ weeklyBudgetTokens: 1000 });
    ledger.recordUsage({ inputTokens: 900, outputTokens: 0 });
    ledger.recordLimitHit('You\'ve hit your weekly usage limit. Try again in 2 hours.');
    advance(2 * 3600_000 + 1);
    // Window restarted AT the deadline → consumption zeroed, admission back open.
    const snapshot = ledger.snapshot();
    expect(snapshot.limitLatched).toBe(false);
    expect(snapshot.consumedTokens).toBe(0);
    expect(ledger.checkFreshSession({ nonInteractive: true })).toEqual({ decision: 'allow' });
  });

  it('does NOT restart the estimation window on a five-hour limit hit', () => {
    const { ledger } = ledgerWithClock({ weeklyBudgetTokens: 1000 });
    ledger.recordUsage({ inputTokens: 900, outputTokens: 0 });
    ledger.recordLimitHit('usage limit for the 5 hour window — try again in 1 hour');
    const snapshot = ledger.snapshot();
    expect(snapshot.limitWindow).toBe('five-hour');
    expect(snapshot.consumedTokens).toBe(900);
  });
});

describe('CodexWeeklyQuotaLedger — /status lines', () => {
  it('labels estimates in budget mode and observe mode explicitly', () => {
    const budget = ledgerWithClock({ weeklyBudgetTokens: 1000 });
    budget.ledger.recordUsage({ inputTokens: 400, outputTokens: 100 });
    const lines = budget.ledger.formatStatusLines();
    expect(lines[0]).toContain('估计');
    expect(lines[0]).toContain('50%');

    const observe = ledgerWithClock();
    observe.ledger.recordUsage({ inputTokens: 400, outputTokens: 100 });
    const observeLines = observe.ledger.formatStatusLines();
    expect(observeLines[0]).toContain('观测模式');
    expect(observeLines[0]).not.toContain('剩余约');
  });

  it('reports a latched calibration line', () => {
    const { ledger } = ledgerWithClock();
    ledger.recordLimitHit("You've hit your weekly usage limit. Try again in 90 minutes.");
    const lines = ledger.formatStatusLines();
    expect(lines.some(line => line.includes('撞限校准') && line.includes('周'))).toBe(true);
  });
});
