import { setTimeout as delay } from 'node:timers/promises';
import { computeBackoffDelay } from '../../../utils/retry.js';

/** Provider-local policy for confirmed failed turns, never transport uncertainty. */
export interface CodexOverloadFailure {
  message: string;
  retryAfterMs?: number;
}
export const CODEX_OVERLOAD_MAX_RETRIES = 2;
const MAX_TOTAL_WAIT_MS = 30_000;
const TIMING = { initialDelayMs: 500, backoffMultiplier: 2, maxDelayMs: 8000, jitter: true };
const OVERLOAD_CODE = /^(?:serverOverloaded|server_overloaded|server_is_overloaded|overloaded_error)$/i;
const OVERLOAD_TEXT = /server[_ ](?:is[_ ])?overload(?:ed)?|overloaded_error|(?:selected )?model is at capacity|(?:HTTP|status(?: code)?)\s*[:=]?\s*503\b/i;
const NON_TRANSIENT = /\b(?:401|403)\b|unauthori[sz]ed|permission denied|invalid (?:configuration|request)|validation (?:error|failed)|usage limit|quota (?:exceeded|exhausted)/i;

export function readCodexOverloadFailure(value: unknown, now = Date.now()): CodexOverloadFailure | undefined {
  if (!value || typeof value !== 'object') { return undefined; }
  const error = value as Record<string, unknown>;
  const message = typeof error.message === 'string' ? error.message : '';
  const details = typeof error.additionalDetails === 'string' ? error.additionalDetails : '';
  const info = error.codexErrorInfo ?? error.code;
  let overloaded = false;
  if (typeof info === 'string' && info !== 'other') {
    // A native non-transient code takes precedence over incidental wording.
    overloaded = OVERLOAD_CODE.test(info);
  } else if (info && typeof info === 'object') {
    overloaded = Object.entries(info).some(([kind, detail]) =>
      ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(kind)
      && !!detail && typeof detail === 'object' && (detail as { httpStatusCode?: unknown }).httpStatusCode === 503);
  } else {
    overloaded = !NON_TRANSIENT.test(message) && OVERLOAD_TEXT.test(message);
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
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

export function codexOverloadRetryDelay(failure: CodexOverloadFailure, attempt: number, waitedMs: number): number | undefined {
  if (attempt >= CODEX_OVERLOAD_MAX_RETRIES) { return undefined; }
  const delayMs = Math.max(failure.retryAfterMs ?? 0, computeBackoffDelay(attempt, TIMING));
  // Never shorten a valid server hint to fit the budget: defer instead.
  return Number.isFinite(delayMs) && waitedMs + delayMs <= MAX_TOTAL_WAIT_MS ? delayMs : undefined;
}

export async function waitForCodexOverloadRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  try { await delay(delayMs, undefined, { signal }); return true; }
  catch (error) { if (signal.aborted) { return false; } throw error; }
}
