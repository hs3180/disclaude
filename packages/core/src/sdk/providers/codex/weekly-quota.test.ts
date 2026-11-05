/**
 * Unit tests for the codex weekly-quota ledger (#5607, rework 1).
 *
 * The ledger records REAL upstream rate-limit readings (used_percent /
 * window_minutes / resets_at) and gates fresh sessions on the
 * usage-progress-vs-time-progress rule. Time-dependent behavior is driven
 * through an injectable clock, so every transition is asserted
 * deterministically.
 */

import { describe, expect, it } from 'vitest';
import {
  CodexWeeklyQuotaLedger,
  type CodexRateLimitReading,
  extractCodexRateLimitReadings,
  parseCodexResetHint,
  classifyCodexLimitWindow,
  weeklyProgress,
} from './weekly-quota.js';

const MIN = 60_000;
const WEEK_MINUTES = 7 * 24 * 60;

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

/** A realistic exec `token_count` event payload (binary-proven field names). */
function tokenCountEvent(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'token_count',
    info: { total_token_usage: { input_tokens: 1000, output_tokens: 200 } },
    rate_limits: {
      primary: { used_percent: 40, window_minutes: WEEK_MINUTES, resets_at: Math.floor(Date.UTC(2026, 10, 9) / 1000) },
      secondary: { used_percent: 10, window_minutes: 300, resets_at: Math.floor(Date.UTC(2026, 10, 5, 14) / 1000) },
    },
    ...overrides,
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

describe('extractCodexRateLimitReadings', () => {
  it('extracts primary/secondary windows from a token_count event (resets_at in epoch seconds)', () => {
    const readings = extractCodexRateLimitReadings(tokenCountEvent(), 'exec token_count', 0);
    expect(readings).toHaveLength(2);
    const weekly = readings.find(r => r.windowMinutes === WEEK_MINUTES);
    expect(weekly).toMatchObject({
      usedPercent: 40,
      windowMinutes: WEEK_MINUTES,
      resetsAt: Date.UTC(2026, 10, 9),
      source: 'exec token_count',
    });
    const short = readings.find(r => r.windowMinutes === 300);
    expect(short).toMatchObject({ usedPercent: 10 });
  });

  it('accepts a bare rate_limits window, ms epochs and ISO reset strings', () => {
    const resetsAt = Date.UTC(2026, 10, 9);
    for (const resets of [resetsAt, String(resetsAt), new Date(resetsAt).toISOString()]) {
      const [reading] = extractCodexRateLimitReadings(
        { rate_limits: { used_percent: 55, window_minutes: WEEK_MINUTES, resets_at: resets } },
        'app-server account/rateLimits/updated',
        0,
      );
      expect(reading).toBeDefined();
      expect(reading?.resetsAt).toBe(resetsAt);
      expect(reading?.usedPercent).toBe(55);
    }
  });

  it('ignores payloads without both used_percent and window_minutes, and clamps >100', () => {
    expect(extractCodexRateLimitReadings({ info: { input_tokens: 5 } }, 's', 0)).toEqual([]);
    expect(extractCodexRateLimitReadings({ used_percent: 50 }, 's', 0)).toEqual([]);
    expect(extractCodexRateLimitReadings({ window_minutes: 300 }, 's', 0)).toEqual([]);
    const [clamped] = extractCodexRateLimitReadings(
      { used_percent: 250, window_minutes: WEEK_MINUTES }, 's', 0,
    );
    expect(clamped?.usedPercent).toBe(100);
  });
});

describe('weeklyProgress', () => {
  it('computes usage vs time progress and is undefined without a reset time', () => {
    const now = 0;
    const windowMs = WEEK_MINUTES * MIN;
    // Reset in 2 of 7 days → 5/7 of the window has elapsed.
    const progress = weeklyProgress(
      { usedPercent: 80, windowMinutes: WEEK_MINUTES, resetsAt: 2 * 24 * 3600_000, observedAt: now, source: 't' },
      now,
    );
    expect(progress?.usageProgress).toBeCloseTo(0.8, 6);
    expect(progress?.timeProgress).toBeCloseTo(1 - (2 * 24 * 3600_000) / windowMs, 6);
    expect(weeklyProgress({ usedPercent: 80, windowMinutes: WEEK_MINUTES, observedAt: now, source: 't' }, now))
      .toBeUndefined();
    // A rolled window (reset in the past) is expired data, not progress 1.
    expect(weeklyProgress(
      { usedPercent: 80, windowMinutes: WEEK_MINUTES, resetsAt: now - 1, observedAt: now, source: 't' },
      now,
    )).toBeUndefined();
  });
});

describe('CodexWeeklyQuotaLedger — observe mode (default)', () => {
  it('never gates on readings without enforce, but reports the would-verdict', () => {
    const { ledger } = ledgerWithClock();
    // 80% used with only 30% of the window elapsed — would block under enforce.
    const resetsAt = Date.UTC(2026, 10, 5, 12, 0, 0) + 0.7 * WEEK_MINUTES * MIN;
    ledger.recordRateLimits(
      { rate_limits: { used_percent: 80, window_minutes: WEEK_MINUTES, resets_at: resetsAt / 1000 } },
      'exec token_count',
    );
    expect(ledger.checkFreshSession()).toEqual({ decision: 'allow' });
    const snapshot = ledger.snapshot();
    expect(snapshot.admission).toBe('observe');
    expect(snapshot.verdict).toBe('block');
    const lines = ledger.formatStatusLines();
    expect(lines.some(l => l.includes('已用 80%'))).toBe(true);
    expect(lines.some(l => l.includes('观测模式') && l.includes('若启用 enforce 将拦截'))).toBe(true);
  });

  it('gates on a REAL weekly limit hit until the parsed reset, then recovers', () => {
    const { ledger, advance, now } = ledgerWithClock({ weeklyLimitCooldownMs: 60_000 });
    const future = new Date(now() + 3 * 3600_000);
    const text = `You've hit your usage limit. Try again at ${future.toUTCString()}.`;
    ledger.recordLimitHit(text);
    const gated = ledger.checkFreshSession();
    expect(gated.decision).toBe('block');
    if (gated.decision === 'block') {
      expect(gated.resetAt).toBe(future.getTime());
      expect(gated.reason).toContain('实证');
    }
    advance(3 * 3600_000 + 1);
    expect(ledger.checkFreshSession()).toEqual({ decision: 'allow' });
  });

  it('uses the conservative cooldown when no hint parses', () => {
    const { ledger, advance } = ledgerWithClock({ weeklyLimitCooldownMs: 60_000 });
    ledger.recordLimitHit('usage limit exceeded — upgrade your plan');
    const snapshot = ledger.snapshot();
    expect(snapshot.limitLatched).toBe(true);
    expect(snapshot.limitSource).toBe('conservative');
    expect(snapshot.limitWindow).toBe('unknown');
    expect(ledger.checkFreshSession().decision).toBe('block');
    advance(60_001);
    expect(ledger.checkFreshSession().decision).toBe('allow');
  });
});

describe('CodexWeeklyQuotaLedger — enforce mode progress rule', () => {
  it('blocks fresh sessions while usage progress exceeds time progress', () => {
    const { ledger, now } = ledgerWithClock({ weeklyQuotaAdmission: 'enforce' });
    const resetsAt = now() + 0.7 * WEEK_MINUTES * MIN; // 30% of the window elapsed
    ledger.recordRateLimits(tokenCountEvent({
      rate_limits: { primary: { used_percent: 80, window_minutes: WEEK_MINUTES, resets_at: resetsAt / 1000 } },
    }), 'exec token_count');
    const blocked = ledger.checkFreshSession();
    expect(blocked.decision).toBe('block');
    if (blocked.decision === 'block') {
      expect(blocked.reason).toContain('80%');
      expect(blocked.reason).toContain('30%');
      expect(blocked.resetAt).toBe(resetsAt);
      expect(blocked.reason).toContain('agentBackend');
    }
    // The block is recorded — never silent.
    expect(ledger.snapshot().lastBlock?.reason).toContain('消耗进度');
  });

  it('admits when quota burns no faster than the window elapses', () => {
    const { ledger, now } = ledgerWithClock({ weeklyQuotaAdmission: 'enforce' });
    const resetsAt = now() + 0.5 * WEEK_MINUTES * MIN; // 50% elapsed
    ledger.recordRateLimits(
      { used_percent: 50, window_minutes: WEEK_MINUTES, resets_at: resetsAt / 1000 },
      'app-server thread/tokenUsage/updated',
    );
    // Exactly at par → allow (strictly-greater rule).
    expect(ledger.checkFreshSession()).toEqual({ decision: 'allow' });
  });

  it('unblocks as time progress catches up — no new upstream event needed', () => {
    const { ledger, advance, now } = ledgerWithClock({ weeklyQuotaAdmission: 'enforce' });
    // 50% used, 30% elapsed → block.
    const resetsAt = now() + 0.7 * WEEK_MINUTES * MIN;
    ledger.recordRateLimits(
      { used_percent: 50, window_minutes: WEEK_MINUTES, resets_at: resetsAt / 1000 },
      'exec token_count',
    );
    expect(ledger.checkFreshSession().decision).toBe('block');
    // Advance past 50% elapsed (51%): time progress overtakes usage.
    advance(Math.round(0.21 * WEEK_MINUTES * MIN));
    expect(ledger.checkFreshSession().decision).toBe('allow');
  });

  it('drops a rolled window reading and requires fresh data; a short window never gates', () => {
    const { ledger, advance, now } = ledgerWithClock({ weeklyQuotaAdmission: 'enforce' });
    // Only the 5h window observed — informative, never admission input.
    ledger.recordRateLimits(tokenCountEvent({
      rate_limits: { primary: { used_percent: 95, window_minutes: 300, resets_at: (now() + 60_000) / 1000 } },
    }), 'exec token_count');
    expect(ledger.checkFreshSession()).toEqual({ decision: 'allow' });
    expect(ledger.snapshot().shortWindowReading?.usedPercent).toBe(95);
    // Weekly reading whose window rolls → data expired, admission reopens.
    // 100% used with 60s of the window left still blocks (barely outpaces
    // ~99.99% time progress); once the window rolls the reading is dead.
    const resetsAt = now() + 60_000;
    ledger.recordRateLimits(
      { used_percent: 100, window_minutes: WEEK_MINUTES, resets_at: resetsAt / 1000 },
      'exec token_count',
    );
    expect(ledger.checkFreshSession().decision).toBe('block');
    advance(61_000);
    expect(ledger.checkFreshSession()).toEqual({ decision: 'allow' });
    expect(ledger.snapshot().weeklyReading).toBeUndefined();
    expect(ledger.snapshot().verdict).toBe('insufficient-data');
  });

  it('a reading without resets_at never gates (insufficient data fails open)', () => {
    const { ledger } = ledgerWithClock({ weeklyQuotaAdmission: 'enforce' });
    ledger.recordRateLimits({ used_percent: 99, window_minutes: WEEK_MINUTES }, 'exec token_count');
    expect(ledger.checkFreshSession()).toEqual({ decision: 'allow' });
    expect(ledger.snapshot().verdict).toBe('insufficient-data');
  });

  it('keeps the larger weekly-class window and refreshes on re-observation', () => {
    const { ledger, now } = ledgerWithClock({ weeklyQuotaAdmission: 'enforce' });
    const resetsAt = now() + 0.9 * WEEK_MINUTES * MIN;
    ledger.recordRateLimits(
      { used_percent: 5, window_minutes: WEEK_MINUTES, resets_at: resetsAt / 1000 },
      'exec token_count',
    );
    // Usage grew within the same window — the latest observation wins.
    ledger.recordRateLimits(
      { used_percent: 60, window_minutes: WEEK_MINUTES, resets_at: resetsAt / 1000 },
      'exec token_count',
    );
    const snapshot = ledger.snapshot();
    expect(snapshot.weeklyReading?.usedPercent).toBe(60);
    expect(snapshot.usageProgress).toBeCloseTo(0.6, 6);
    expect(ledger.checkFreshSession().decision).toBe('block');
  });

  it('a latched real limit still gates in enforce mode alongside readings', () => {
    const { ledger } = ledgerWithClock({ weeklyQuotaAdmission: 'enforce' });
    ledger.recordLimitHit("You've hit your weekly usage limit. Try again in 2 hours.");
    const blocked = ledger.checkFreshSession();
    expect(blocked.decision).toBe('block');
    if (blocked.decision === 'block') {
      expect(blocked.reason).toContain('周');
      expect(blocked.reason).toContain('实证');
    }
  });
});

describe('CodexWeeklyQuotaLedger — /status lines', () => {
  it('reports upstream readings with the progress comparison and verdict', () => {
    const { ledger, now } = ledgerWithClock({ weeklyQuotaAdmission: 'enforce' });
    const resetsAt = now() + 0.8 * WEEK_MINUTES * MIN; // 20% elapsed
    ledger.recordRateLimits(tokenCountEvent({
      rate_limits: { primary: { used_percent: 45, window_minutes: WEEK_MINUTES, resets_at: resetsAt / 1000 } },
    }), 'exec token_count');
    const lines = ledger.formatStatusLines();
    expect(lines[0]).toContain('上游实测');
    expect(lines[0]).toContain('已用 45%');
    expect(lines[0]).toContain('窗口时间已过 20%');
    expect(lines.some(l => l.includes('拦截新会话'))).toBe(true);
  });

  it('states clearly when no reading has been observed yet', () => {
    const { ledger } = ledgerWithClock();
    const lines = ledger.formatStatusLines();
    expect(lines[0]).toContain('尚未观测到上游窗口读数');
    expect(lines.some(l => l.includes('观测模式'))).toBe(true);
  });

  it('reports a latched calibration line and the last block', () => {
    const { ledger } = ledgerWithClock({ weeklyQuotaAdmission: 'enforce' });
    ledger.recordLimitHit("You've hit your weekly usage limit. Try again in 90 minutes.");
    ledger.checkFreshSession();
    const lines = ledger.formatStatusLines();
    expect(lines.some(line => line.includes('撞限实证') && line.includes('周'))).toBe(true);
    expect(lines.some(line => line.includes('最近一次拦截'))).toBe(true);
  });

  it('reports the short window for context without gating semantics', () => {
    const { ledger, now } = ledgerWithClock();
    ledger.recordRateLimits(
      { secondary: { used_percent: 10, window_minutes: 300, resets_at: (now() + 3600_000) / 1000 } },
      'app-server account/rateLimits/updated',
    );
    const lines = ledger.formatStatusLines();
    expect(lines.some(l => l.includes('短窗口') && l.includes('10%') && l.includes('300'))).toBe(true);
  });
});

describe('CodexWeeklyQuotaLedger — typing sanity for exported reading shape', () => {
  it('exposes observedAt/source on extracted readings', () => {
    const now = 12345;
    const [reading] = extractCodexRateLimitReadings(
      { used_percent: 1, window_minutes: WEEK_MINUTES, resets_at: now + 1000 },
      'test',
      now,
    );
    expect(reading).toMatchObject({ observedAt: now, source: 'test' } satisfies Partial<CodexRateLimitReading>);
  });
});
