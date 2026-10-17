import { describe, expect, it } from 'vitest';
import { codexOverloadRetryDelay, readCodexOverloadFailure } from './overload-policy.js';

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
    expect(codexOverloadRetryDelay(failure, 0, 0)).toBe(20_000);
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
    expect(codexOverloadRetryDelay(failure, 0, 0)).toBe(5000);
  });
});
