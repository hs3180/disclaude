import { describe, expect, it } from 'vitest';
import { codexOverloadRetryDelay, readCodexOverloadFailure,
  alignCodexCapacityWait, clearCodexCapacityCooldowns, recordCodexCapacityCooldown, readCodexCapacityCooldown,
  codexWriterConflictRetryDelay, readCodexWriterConflictPolicy } from './overload-policy.js';

describe('Codex native overload classification', () => {
  it.each(['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'])('recognizes forwarded 503 in %s, excluding 401 and quota', kind => {
    expect(readCodexOverloadFailure({ message: 'Provider unavailable', codexErrorInfo: { [kind]: { httpStatusCode: 503 } } })).toBeDefined();
    expect(readCodexOverloadFailure({ message: 'server_overloaded', codexErrorInfo: { [kind]: { httpStatusCode: 401 } } })).toBeUndefined();
    expect(readCodexOverloadFailure({ message: 'server_overloaded', codexErrorInfo: 'usageLimitExceeded' })).toBeUndefined();
  });

  it('accepts an explicit exec overload or HTTP 503 while excluding authentication and unrelated numbers', () => {
    expect(readCodexOverloadFailure({ message: 'Selected model is at capacity. Please try a different model.' })).toBeDefined();
    expect(readCodexOverloadFailure({ message: 'unexpected HTTP status 503 Service Unavailable' })).toBeDefined();
    expect(readCodexOverloadFailure({ message: '401 Unauthorized; server_overloaded mentioned in documentation' })).toBeUndefined();
    expect(readCodexOverloadFailure({ message: 'Tool returned item 503' })).toBeUndefined();
  });

  it('honors an HTTP-date wait hint and refuses a wait beyond the remaining budget', () => {
    const now = Date.parse('2026-10-10T00:00:00Z');
    const failure = readCodexOverloadFailure({ codexErrorInfo: 'serverOverloaded', message: 'At capacity', additionalDetails: 'Retry-After: Sat, 10 Oct 2026 00:00:20 GMT' }, now)!;
    // The server hint is a floor with bounded positive jitter (#5494 review).
    expect(codexOverloadRetryDelay(failure, 0, 0)).toBeGreaterThanOrEqual(20_000);
    expect(codexOverloadRetryDelay(failure, 0, 0)).toBeLessThanOrEqual(24_000);
    expect(codexOverloadRetryDelay(failure, 1, 20_000)).toBeUndefined();
  });

  it('falls back from invalid hints and never retries past the attempt limit', () => {
    const failure = readCodexOverloadFailure({ message: 'server_overloaded', additionalDetails: 'Retry-After: unknown' })!;
    expect(codexOverloadRetryDelay(failure, 0, 0)).toBeGreaterThanOrEqual(250);
    expect(codexOverloadRetryDelay(failure, 0, 0)).toBeLessThanOrEqual(500);
    expect(codexOverloadRetryDelay(failure, 2, 0)).toBeUndefined();
  });

  it('recognizes transient 429 throttles while keeping quota surfaces terminal (Issue #5408)', () => {
    expect(readCodexOverloadFailure({ message: 'HTTP 429: Too Many Requests' })).toBeDefined();
    expect(readCodexOverloadFailure({ message: 'Rate limit reached for requests. Retry-After: 30' })).toBeDefined();
    expect(readCodexOverloadFailure({ message: 'unexpected HTTP status 429 rate_limit_exceeded' })).toBeUndefined();
    expect(readCodexOverloadFailure({ message: "You've hit your usage limit. Try again at Apr 30th, 2026 11:21 AM" })).toBeUndefined();
  });

  it('honors a Retry-After seconds hint on a transient 429', () => {
    const failure = readCodexOverloadFailure({ message: 'HTTP 429 Too Many Requests', additionalDetails: 'Retry-After: 5' })!;
    expect(codexOverloadRetryDelay(failure, 0, 0)).toBeGreaterThanOrEqual(5000);
    expect(codexOverloadRetryDelay(failure, 0, 0)).toBeLessThanOrEqual(6000);
  });
});

describe('process-wide capacity cooldown (#5494 review)', () => {
  it('extends a shared deadline across sessions, never shortens it, and lets it lapse', () => {
    clearCodexCapacityCooldowns();
    const t0 = 1_000_000;
    recordCodexCapacityCooldown('gpt-6-luna', 20_000, t0);
    expect(readCodexCapacityCooldown('gpt-6-luna', t0 + 5_000)).toBe(15_000);
    expect(readCodexCapacityCooldown('gpt-6-luna', t0 + 20_000)).toBe(0);
    // A shorter later failure must not shorten an active deadline…
    recordCodexCapacityCooldown('gpt-6-luna', 5_000, t0 + 6_000);
    expect(readCodexCapacityCooldown('gpt-6-luna', t0 + 6_000)).toBe(14_000);
    // …but a longer one extends it. Other models stay independent.
    recordCodexCapacityCooldown('gpt-6-luna', 40_000, t0 + 6_000);
    expect(readCodexCapacityCooldown('gpt-6-luna', t0 + 6_000)).toBe(40_000);
    expect(readCodexCapacityCooldown('gpt-6-minima', t0 + 6_000)).toBe(0);
    clearCodexCapacityCooldowns();
    expect(readCodexCapacityCooldown('gpt-6-luna', t0 + 6_000)).toBe(0);
  });

  it('aligns a session wait past the deadline with bounded spread and never shortens its own wait', () => {
    clearCodexCapacityCooldowns();
    const t0 = 2_000_000;
    recordCodexCapacityCooldown('gpt-6-luna', 30_000, t0);
    // Own wait 5s, 30s remaining: lands in [30s, 35s] — 20% spread capped at 5s.
    expect(alignCodexCapacityWait('gpt-6-luna', 5_000, () => 0, t0)).toBe(30_000);
    expect(alignCodexCapacityWait('gpt-6-luna', 5_000, () => 1, t0)).toBe(35_000);
    // An own wait already past the deadline, and no deadline at all, stay as-is.
    expect(alignCodexCapacityWait('gpt-6-luna', 45_000, () => 1, t0)).toBe(45_000);
    expect(alignCodexCapacityWait('gpt-6-minima', 5_000, () => 1, t0)).toBe(5_000);
    clearCodexCapacityCooldowns();
  });
});

describe('writer-lock conflict wait policy (#5429)', () => {
  it('backoff is jittered within [half, full] of the nominal curve and capped', () => {
    const policy = readCodexWriterConflictPolicy({});
    // attempt 0 → nominal 2s; attempts 3+ cap at the 15s max delay.
    for (const random of [() => 0, () => 1]) {
      expect(codexWriterConflictRetryDelay(0, 0, policy, random)).toBeGreaterThanOrEqual(1000);
      expect(codexWriterConflictRetryDelay(0, 0, policy, random)).toBeLessThanOrEqual(2000);
      expect(codexWriterConflictRetryDelay(3, 0, policy, random)).toBeLessThanOrEqual(15_000);
    }
  });

  it('declines once the attempt cap is hit', () => {
    const policy = readCodexWriterConflictPolicy({});
    expect(codexWriterConflictRetryDelay(policy.maxRetries, 0, policy)).toBeUndefined();
    expect(codexWriterConflictRetryDelay(policy.maxRetries - 1, 0, policy)).toBeDefined();
  });

  it('never waits past the cumulative budget — defer (surface the error) instead', () => {
    const policy = readCodexWriterConflictPolicy({ DISCLAUDE_CODEX_WRITER_CONFLICT_BUDGET_MS: '5000' });
    expect(codexWriterConflictRetryDelay(0, 4900, policy)).toBeUndefined();
    expect(codexWriterConflictRetryDelay(0, 0, policy)).toBeDefined();
  });

  it('reads test/ops overrides like the capacity policy does', () => {
    const policy = readCodexWriterConflictPolicy({
      DISCLAUDE_CODEX_WRITER_CONFLICT_MAX_RETRIES: '1',
      DISCLAUDE_CODEX_WRITER_CONFLICT_INITIAL_DELAY_MS: '40',
      DISCLAUDE_CODEX_WRITER_CONFLICT_MAX_DELAY_MS: '40',
    });
    expect(policy.maxRetries).toBe(1);
    expect(codexWriterConflictRetryDelay(1, 0, policy)).toBeUndefined();
    expect(codexWriterConflictRetryDelay(0, 0, policy)).toBeLessThanOrEqual(40);
  });
});
