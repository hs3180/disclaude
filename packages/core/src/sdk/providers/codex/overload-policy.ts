import { setTimeout as delay } from 'node:timers/promises';
import { computeBackoffDelay } from '../../../utils/retry.js';

/** Provider-local policy for confirmed failed turns, never transport uncertainty. */
export interface CodexOverloadFailure {
  message: string;
  retryAfterMs?: number;
  /**
   * #5468: true when the failure is the capacity class (native serverOverloaded
   * family, HTTP 503, or explicit at-capacity wording) rather than a 429-style
   * throttle. Only capacity failures are eligible for post-progress
   * same-thread continuation; throttles stay on the pre-work retry path.
   */
  readonly capacity?: boolean;
}
export const CODEX_OVERLOAD_MAX_RETRIES = 2;
const MAX_TOTAL_WAIT_MS = 30_000;
const TIMING = { initialDelayMs: 500, backoffMultiplier: 2, maxDelayMs: 8000, jitter: true };
/** #5408 throttle wording: seconds-scale limits, covered by the pre-work retry. */
const THROTTLE_TEXT = /\b429\b|too many requests|rate.?limit/i;
const OVERLOAD_CODE = /^(?:serverOverloaded|server_overloaded|server_is_overloaded|overloaded_error)$/i;
/** Transient failure wording eligible for the bounded retry: 503/429 statuses (#5269, #5408) plus quota-free throttle phrasing. */
const OVERLOAD_TEXT = /server[_ ](?:is[_ ])?overload(?:ed)?|overloaded_error|(?:selected )?model is at capacity|(?:HTTP|status(?: code)?)\s*[:=]?\s*(?:503|429)\b|too many requests|rate.?limit reached/i;
/** Terminal surfaces never retried. `rate_limit_exceeded` is the ChatGPT-backend quota signature, not a seconds-scale throttle (#5408). */
const NON_TRANSIENT = /\b(?:401|403)\b|unauthori[sz]ed|permission denied|invalid (?:configuration|request)|validation (?:error|failed)|usage limit|quota (?:exceeded|exhausted)|rate_limit_exceeded/i;

export function readCodexOverloadFailure(value: unknown, now = Date.now()): CodexOverloadFailure | undefined {
  if (!value || typeof value !== 'object') { return undefined; }
  const error = value as Record<string, unknown>;
  const message = typeof error.message === 'string' ? error.message : '';
  const details = typeof error.additionalDetails === 'string' ? error.additionalDetails : '';
  const info = error.codexErrorInfo ?? error.code;
  let overloaded = false;
  let capacity = false;
  if (typeof info === 'string' && info !== 'other') {
    // A native non-transient code takes precedence over incidental wording.
    overloaded = OVERLOAD_CODE.test(info);
    capacity = overloaded;
  } else if (info && typeof info === 'object') {
    const statuses = Object.entries(info)
      .filter(([kind, detail]) =>
        ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(kind)
        && !!detail && typeof detail === 'object'
        && (detail as { httpStatusCode?: unknown }).httpStatusCode !== undefined)
      .map(([, detail]) => (detail as { httpStatusCode: number }).httpStatusCode);
    overloaded = statuses.some(code => code === 503 || code === 429);
    capacity = statuses.includes(503);
  } else {
    overloaded = !NON_TRANSIENT.test(message) && OVERLOAD_TEXT.test(message);
    capacity = overloaded && !THROTTLE_TEXT.test(message)
      && /\b503\b|model is at capacity|server[_ ](?:is[_ ])?overload/i.test(message);
  }
  if (!overloaded) { return undefined; }
  const hint = /\bretry-after\s*:\s*([^\r\n]+)/i.exec(`${message}\n${details}`)?.[1]?.trim();
  let retryAfterMs: number | undefined;
  if (hint) {
    if (/^\d+$/.test(hint)) { retryAfterMs = Number(hint) * 1000; }
    else {
      const date = Date.parse(hint);
      if (Number.isFinite(date)) { retryAfterMs = Math.max(0, date - now); }
    }
  }
  return { message: `${typeof info === 'string' ? `${info}: ` : ''}${message}${details ? `\n${details}` : ''}`,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), capacity };
}

/**
 * #5468: bounded same-thread continuation after an explicit capacity failure
 * that already produced output or tool calls. Defaults follow the issue: at
 * most 6 host continuations with nominal 5/10/20/30/30/30s jittered waits and
 * a 180s wall-clock budget measured from the first capacity failure (waits,
 * recovery requests, and other consumed time all count; progress never resets
 * it). The env overrides exist for tests and operational tuning, mirroring
 * readStallPolicy.
 */
export const CODEX_CAPACITY_RECOVERY_MAX_ATTEMPTS = 6;
export const CODEX_CAPACITY_RECOVERY_BUDGET_MS = 180_000;
export interface CodexCapacityRecoveryPolicy {
  maxAttempts: number;
  budgetMs: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
}
export function readCodexCapacityRecoveryPolicy(
  env: Record<string, string | undefined> = process.env,
): CodexCapacityRecoveryPolicy {
  const override = (name: string): number | undefined => {
    const parsed = Number(env[name]);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  return {
    maxAttempts: override('DISCLAUDE_CODEX_CAPACITY_RECOVERY_MAX_ATTEMPTS') ?? CODEX_CAPACITY_RECOVERY_MAX_ATTEMPTS,
    budgetMs: override('DISCLAUDE_CODEX_CAPACITY_RECOVERY_BUDGET_MS') ?? CODEX_CAPACITY_RECOVERY_BUDGET_MS,
    initialDelayMs: override('DISCLAUDE_CODEX_CAPACITY_RECOVERY_INITIAL_DELAY_MS') ?? 5000,
    backoffMultiplier: 2,
    maxDelayMs: override('DISCLAUDE_CODEX_CAPACITY_RECOVERY_MAX_DELAY_MS') ?? 30_000,
  };
}
export function isCodexCapacityFailure(failure: CodexOverloadFailure): boolean {
  return failure.capacity === true;
}
/**
 * Wait before the next same-thread continuation, or undefined when the
 * failure is not capacity-class, the attempt cap is hit, or the wait would
 * exceed the remaining wall-clock budget — never shorten a valid server hint
 * to fit; defer (settle) instead.
 */
export function codexCapacityRecoveryDelay(
  failure: CodexOverloadFailure,
  attempt: number,
  firstFailureAtMs: number,
  policy: CodexCapacityRecoveryPolicy = readCodexCapacityRecoveryPolicy(),
  now: () => number = Date.now,
  random: () => number = Math.random,
): number | undefined {
  if (attempt >= policy.maxAttempts || !isCodexCapacityFailure(failure)) { return undefined; }
  const scheduled = Math.max(serverHintDelay(failure, random), computeBackoffDelay(attempt, {
    initialDelayMs: policy.initialDelayMs, backoffMultiplier: policy.backoffMultiplier, maxDelayMs: policy.maxDelayMs, jitter: true,
  }, random));
  return firstFailureAtMs + policy.budgetMs - now() >= scheduled ? scheduled : undefined;
}

/**
 * #5494 review: sessions sharing one Retry-After would otherwise fire at the
 * same instant (the plain hint wins the max against the jittered backoff).
 * Honor the hint as a floor, then spread it by bounded positive jitter — the
 * spread only ever delays past the hint, never shortens it, and is capped so
 * large hints stay meaningful. The backoff half is independently jittered by
 * computeBackoffDelay.
 */
function serverHintDelay(failure: CodexOverloadFailure, random: () => number): number {
  if (failure.retryAfterMs === undefined) { return 0; }
  const spread = Math.min(failure.retryAfterMs * 0.2, 5_000);
  return failure.retryAfterMs + random() * spread;
}

export function codexOverloadRetryDelay(
  failure: CodexOverloadFailure,
  attempt: number,
  waitedMs: number,
  random: () => number = Math.random,
): number | undefined {
  if (attempt >= CODEX_OVERLOAD_MAX_RETRIES) { return undefined; }
  const delayMs = Math.max(serverHintDelay(failure, random), computeBackoffDelay(attempt, TIMING, random));
  // Never shorten a valid server hint to fit the budget: defer instead.
  return Number.isFinite(delayMs) && waitedMs + delayMs <= MAX_TOTAL_WAIT_MS ? delayMs : undefined;
}

export async function waitForCodexOverloadRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  try { await delay(delayMs, undefined, { signal }); return true; }
  catch (error) { if (signal.aborted) { return false; } throw error; }
}
