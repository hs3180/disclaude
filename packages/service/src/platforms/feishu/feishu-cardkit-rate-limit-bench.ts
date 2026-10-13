/**
 * Card Kit streaming-update rate-limit characterization bench.
 *
 * This tool runs against a live streaming card; operator preconditions are in
 * `docs/feishu-channel.md`. It measures sustained update pacing, retry/cooldown
 * behavior, and how short bursts are handled.
 *
 * Why a raw-HTTP caller instead of `FeishuCardKitClient`: the client is the right
 * abstraction for production streaming, but it (correctly) throws on non-2xx and
 * does not surface response *headers*. Characterizing 429 backoff needs the
 * `Retry-After` header, and Feishu frequently rate-limits as HTTP 200 + a non-zero
 * business `code` (not 429) — so the bench classifies responses itself. The
 * guide documents why the bench uses a standalone HTTP caller. The caller
 * reuses the verified PUT path + body shape (`{content, sequence, uuid}`); only
 * the header/status handling differs from the production client.
 *
 * Testability: the sweep / capture / burst *logic* is pure and dependency-injected
 * (`caller`, `now`, `sleep`), so it is unit-tested with a mock caller + fake clock
 * — no live Feishu, no real timers. The actual measured numbers need a live tenant
 * (`LARKSUITE_CLI_TENANT_ACCESS_TOKEN` + a streaming card); the CLI in
 * `scripts/feishu-cardkit-rate-limit-bench.mts` is the operator entry point.
 */

import { createLogger } from '@disclaude/core';
import { DEFAULT_CARDKIT_BASE_URL } from './feishu-cardkit-client.js';

const logger = createLogger('FeishuCardKitBench');

/**
 * Card Kit API path prefix. Must match `CARDKIT_PATH` in `feishu-cardkit-client.ts`
 * (kept unexported there to avoid widening the client's surface; duplicated here
 * with a cross-reference rather than editing the churning client file).
 */
const CARDKIT_PATH = '/open-apis/cardkit/v1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One bench request: update element content or settings at `sequence`. */
export interface BenchRequest {
  /** Per-card monotonic sequence, shared across every PUT in the run. */
  sequence: number;
  /** Element content (replace-semantics; old text is a prefix of new). */
  content: string;
}

/** A classified response from one PUT, with the fields the bench needs. */
export interface BenchResponse {
  /** HTTP status (0 when no response was received, e.g. network failure). */
  status: number;
  /** Feishu business `code` from the body (0 = ok). Undefined when absent. */
  code?: number;
  /** Feishu business `msg`. */
  msg?: string;
  /** Parsed `Retry-After` header in ms, when present. */
  retryAfterMs?: number;
  /** Raw `Retry-After` header value, when present (for debugging). */
  retryAfterRaw?: string;
  /** Feishu's documented recovery delay, in seconds on the wire. */
  rateLimitResetMs?: number;
  rateLimitResetRaw?: string;
}

/** Coarse classification of one response. */
export type ResponseOutcome = 'success' | 'throttled' | 'rejected' | 'error';

/**
 * Injectable HTTP caller. Abstracts the real PUT so the sweep logic is pure and
 * unit-testable; the live implementation is {@link createFeishuBenchCaller}.
 */
export type BenchCaller = (req: BenchRequest) => Promise<BenchResponse>;

/** Sustained-sweep + burst configuration. */
export interface BenchConfig {
  /** Cadences (PUT/s) to sweep, ascending. Each is held for `cadenceDurationMs`. */
  cadencesPerSec: number[];
  /** How long to hold each cadence before stepping up (ms). */
  cadenceDurationMs: number;
  /** Probe interval (ms) used to measure the cooldown after a throttle. */
  probeIntervalMs: number;
  /** Upper bound on cooldown probing per cadence (ms); guards a stuck-throttle loop. */
  probeBudgetMs: number;
  /** Burst test parameters. */
  burst: { count: number; windowMs: number; rounds: number; idleMs: number };
}

/** Defaults match the methodology doc's procedure (start 2/s, ramp to 20/s). */
export const DEFAULT_BENCH_CONFIG: BenchConfig = {
  cadencesPerSec: [2, 5, 10, 20],
  cadenceDurationMs: 5_000,
  probeIntervalMs: 1_000,
  probeBudgetMs: 30_000,
  burst: { count: 10, windowMs: 50, rounds: 3, idleMs: 1_000 },
};

/** Per-cadence sweep result. */
export interface CadenceResult {
  cadencePerSec: number;
  sent: number;
  successes: number;
  throttled: number;
  /** HTTP 429 responses, separate from documented business-code rate limits. */
  http429: number;
  businessThrottled: number;
  /** HTTP 200 but non-zero business code (may or may not be rate-limit). */
  rejected: number;
  /** Network failure / 5xx. */
  errors: number;
  /**
   * First business rejection's Feishu `code` (set when `rejected > 0`). Feishu
   * often rate-limits as 200 + non-zero code — the code/msg is what lets an
   * operator tell a rate limit from a bench bug (e.g. 300317 sequence misuse).
   */
  firstRejectedCode?: number;
  /** First business rejection's Feishu `msg` (set alongside `firstRejectedCode`). */
  firstRejectedMsg?: string;
  /** ms from the cadence's first PUT to its first throttle. */
  firstThrottleAtMs?: number;
  /** `Retry-After` observed on the first throttle (ms). */
  firstRetryAfterMs?: number;
  firstRateLimitResetMs?: number;
  /** Effective cooldown: ms from first throttle to the next success. */
  cooldownMs?: number;
  /** Wall time including HTTP latency and cooldown probes. */
  elapsedMs: number;
  actualRequestsPerSec: number;
  actualSuccessesPerSec: number;
}

/** Burst test result. */
export interface BurstResult {
  rounds: number;
  totalSent: number;
  totalApplied: number;
  totalThrottled: number;
  totalRejected: number;
  totalErrors: number;
  http429: number;
  businessThrottled: number;
  /** First-to-last request dispatch time for each round, not the nominal window. */
  roundWindowsMs: number[];
  maxBackoffMs: number;
}

/** Full bench result, feeding the `StreamingThrottle` defaults (#4414). */
export interface BenchResult {
  cadences: CadenceResult[];
  burst: BurstResult;
  /** Highest measured requests/s from a clean serial sweep; not a quota ceiling. */
  maxSustainedPerSec: number;
  /** `StreamingThrottle.minIntervalMs` suggestion = ceil(1000 / maxSustainedPerSec). */
  suggestedMinIntervalMs: number;
  /** Largest backoff signal observed (max of Retry-After + measured cooldowns), ms. */
  maxObservedBackoffMs: number;
  /** `StreamingThrottle.maxBackoffMs` suggestion; 0 means not measured. */
  suggestedMaxBackoffMs: number;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify one response.
 *
 * - `success`  — 2xx and Feishu business code 0.
 * - `throttled` — HTTP 429 or the documented frequency-limit code 99991400;
 *   triggers cooldown probing and `Retry-After` capture.
 * - `rejected` — HTTP 200 but a non-zero business code. Feishu rate-limits this
 *   way often, but so do sequence (300317) / permission errors — the bench
 *   records the first code+msg per cadence (`firstRejectedCode`/`firstRejectedMsg`)
 *   so an operator can tell a repeating rate-limit code from a bench bug.
 *   `rejected` does NOT by itself drive the cooldown probe.
 * - `error` — no response (0) or 5xx.
 */
export function classifyOutcome(res: BenchResponse): ResponseOutcome {
  if (res.status === 429 || res.code === 99991400) {
    return 'throttled';
  }
  if (typeof res.code === 'number' && res.code !== 0) {
    return 'rejected';
  }
  if (res.status === 0 || res.status >= 500) {
    return 'error';
  }
  if (res.status >= 200 && res.status < 300) {
    return 'success';
  }
  return 'error';
}

/**
 * Parse a `Retry-After` header (seconds or HTTP-date) into ms.
 * Returns `{}` when absent or unparseable; always echoes the raw value.
 */
export function parseRetryAfter(
  raw: string | null | undefined,
  nowMs: number
): { ms?: number; raw?: string } {
  if (!raw) {
    return {};
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  // Numeric form = seconds.
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return { ms: Math.round(Number(trimmed) * 1000), raw: trimmed };
  }
  // HTTP-date form.
  const epoch = Date.parse(trimmed);
  if (!Number.isNaN(epoch)) {
    return { ms: Math.max(0, epoch - nowMs), raw: trimmed };
  }
  return { raw: trimmed };
}

// ---------------------------------------------------------------------------
// Sweep + burst
// ---------------------------------------------------------------------------

/** Dependencies injected into {@link runRateLimitBench} for determinism in tests. */
export interface BenchDeps {
  caller: BenchCaller;
  config?: BenchConfig;
  /** Clock; defaults to `Date.now`. */
  now?: () => number;
  /** Sleep; defaults to real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/** Run the full sweep + burst against the injected caller. Pure / side-effect-free apart from caller + sleep. */
export async function runRateLimitBench(deps: BenchDeps): Promise<BenchResult> {
  const config = deps.config ?? DEFAULT_BENCH_CONFIG;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let sequence = 0;
  const nextReq = (content: string): BenchRequest => ({ sequence: ++sequence, content });

  const cadenceResults: CadenceResult[] = [];
  let maxObservedBackoffMs = 0;
  let unrecoveredThrottle = false;

  for (const cadence of config.cadencesPerSec) {
    const intervalMs = Math.max(1, Math.round(1000 / cadence));
    const start = now();
    const deadline = start + config.cadenceDurationMs;

    const result: CadenceResult = {
      cadencePerSec: cadence,
      sent: 0,
      successes: 0,
      throttled: 0,
      http429: 0,
      businessThrottled: 0,
      rejected: 0,
      errors: 0,
      elapsedMs: 0,
      actualRequestsPerSec: 0,
      actualSuccessesPerSec: 0,
    };

    let throttled = false;
    // Sweep at the cadence until the deadline, or until we observe + probe a throttle.
    while (now() < deadline) {
      const requestStartedAt = now();
      const res = await deps.caller(nextReq(contentFor(sequence)));
      tally(result, res);
      const outcome = classifyOutcome(res);

      if (outcome === 'rejected' && result.rejected === 1) {
        // First business rejection of this cadence — record code+msg so the
        // findings table can distinguish a rate-limit code from a bench bug.
        result.firstRejectedCode = res.code;
        result.firstRejectedMsg = res.msg;
      }

      if (outcome === 'throttled' && !throttled) {
        throttled = true;
        result.firstThrottleAtMs = now() - start;
        result.firstRetryAfterMs = res.retryAfterMs;
        result.firstRateLimitResetMs = res.rateLimitResetMs;
        const serverDelayMs = Math.max(res.retryAfterMs ?? 0, res.rateLimitResetMs ?? 0);
        maxObservedBackoffMs = Math.max(maxObservedBackoffMs, serverDelayMs);
        // Probe at a slow cadence until a success to measure the effective cooldown.
        const cooldown = await probeUntilSuccess({
          caller: deps.caller,
          nextReq,
          probeIntervalMs: config.probeIntervalMs,
          budgetMs: config.probeBudgetMs,
          throttleAt: now(),
          retryAfterMs: serverDelayMs,
          now,
          sleep,
          onProbe: (r) => {
            result.sent += 1;
            tallyCountsOnly(result, r);
            maxObservedBackoffMs = Math.max(maxObservedBackoffMs,
              r.retryAfterMs ?? 0, r.rateLimitResetMs ?? 0);
          },
        });
        if (typeof cooldown === 'number') {
          result.cooldownMs = cooldown;
          maxObservedBackoffMs = Math.max(maxObservedBackoffMs, cooldown);
        }
        break; // cadence done — we have its throttle + cooldown data
      }

      if (now() < deadline) {
        // HTTP latency already consumes part (or all) of the start-to-start interval.
        const waitMs = Math.min(deadline - now(), requestStartedAt + intervalMs - now());
        if (waitMs > 0) {
          await sleep(waitMs);
        }
      }
    }

    result.elapsedMs = now() - start;
    if (result.elapsedMs > 0) {
      result.actualRequestsPerSec = result.sent * 1000 / result.elapsedMs;
      result.actualSuccessesPerSec = result.successes * 1000 / result.elapsedMs;
    }

    logger.info({ cadence, ...result }, 'Card Kit bench: cadence step complete');
    cadenceResults.push(result);
    if (throttled && result.cooldownMs === undefined) {
      unrecoveredThrottle = true;
      break;
    }
  }

  const burstConfig = unrecoveredThrottle
    ? { ...config, burst: { ...config.burst, rounds: 0 } } : config;
  const burst = await runBurst({ caller: deps.caller, nextReq, config: burstConfig, now, sleep });
  maxObservedBackoffMs = Math.max(maxObservedBackoffMs, burst.maxBackoffMs);

  // Highest actual throughput with no throttled/rejected/error responses.
  let maxSustainedPerSec = 0;
  for (const r of cadenceResults) {
    const clean = r.sent > 0 && r.throttled === 0 && r.rejected === 0 && r.errors === 0;
    if (clean && r.actualRequestsPerSec > maxSustainedPerSec) {
      maxSustainedPerSec = r.actualRequestsPerSec;
    }
  }

  const suggestedMinIntervalMs = maxSustainedPerSec > 0
    ? Math.ceil(1000 / maxSustainedPerSec)
    : 0; // 0 = even the lowest cadence was throttled; needs a slower sweep floor.
  const suggestedMaxBackoffMs = roundUpBackoff(maxObservedBackoffMs);

  return {
    cadences: cadenceResults,
    burst,
    maxSustainedPerSec,
    suggestedMinIntervalMs,
    maxObservedBackoffMs,
    suggestedMaxBackoffMs,
  };
}

/**
 * Build incremental element content for sequence `n` (typewriter replace-semantics:
 * each chunk is a prefix-extension of the previous). Kept trivial — the bench
 * measures throughput, not rendering.
 */
function contentFor(n: number): string {
  return `bench tick ${n}`;
}

/** Tally a response into a cadence result (sent + outcome-specific counter). */
function tally(result: CadenceResult, res: BenchResponse): void {
  result.sent += 1;
  tallyCountsOnly(result, res);
}

/** Tally outcome counters without bumping `sent` (used for probe calls). */
function tallyCountsOnly(result: CadenceResult, res: BenchResponse): void {
  switch (classifyOutcome(res)) {
    case 'success':
      result.successes += 1;
      break;
    case 'throttled':
      result.throttled += 1;
      if (res.status === 429) {
        result.http429 += 1;
      } else {
        result.businessThrottled += 1;
      }
      break;
    case 'rejected':
      result.rejected += 1;
      break;
    default:
      result.errors += 1;
      break;
  }
}

interface ProbeDeps {
  caller: BenchCaller;
  nextReq: (content: string) => BenchRequest;
  probeIntervalMs: number;
  budgetMs: number;
  throttleAt: number;
  retryAfterMs?: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  onProbe?: (res: BenchResponse) => void;
}

/**
 * After a throttle, probe at `probeIntervalMs` until a success (or budget exhausted).
 * Returns the elapsed ms from `throttleAt` to the first success, or undefined.
 */
async function probeUntilSuccess(deps: ProbeDeps): Promise<number | undefined> {
  const deadline = deps.throttleAt + deps.budgetMs;
  let waitMs = Math.max(deps.probeIntervalMs, deps.retryAfterMs ?? 0);
  while (deps.now() < deadline) {
    if (waitMs > deadline - deps.now()) {
      return undefined;
    }
    await deps.sleep(waitMs);
    const res = await deps.caller(deps.nextReq(contentFor(-1)));
    deps.onProbe?.(res);
    if (classifyOutcome(res) === 'success') {
      return deps.now() - deps.throttleAt;
    }
    waitMs = Math.max(deps.probeIntervalMs, res.retryAfterMs ?? 0, res.rateLimitResetMs ?? 0);
  }
  return undefined;
}

interface BurstDeps {
  caller: BenchCaller;
  nextReq: (content: string) => BenchRequest;
  config: BenchConfig;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** Run the burst test: `rounds` of `count` PUTs spread over `windowMs`, then idle. */
async function runBurst(deps: BurstDeps): Promise<BurstResult> {
  const { count, windowMs, rounds, idleMs } = deps.config.burst;
  const stepMs = count > 1 ? Math.max(1, Math.round(windowMs / (count - 1))) : 0;
  const result: BurstResult = {
    rounds: 0,
    totalSent: 0,
    totalApplied: 0,
    totalThrottled: 0,
    totalRejected: 0,
    totalErrors: 0,
    http429: 0,
    businessThrottled: 0,
    roundWindowsMs: [],
    maxBackoffMs: 0,
  };
  for (let round = 0; round < rounds; round += 1) {
    result.rounds += 1;
    const start = deps.now();
    let lastDispatch = start;
    for (let i = 0; i < count; i += 1) {
      lastDispatch = deps.now();
      const res = await deps.caller(deps.nextReq(contentFor(result.totalSent)));
      result.totalSent += 1;
      switch (classifyOutcome(res)) {
        case 'success':
          result.totalApplied += 1;
          break;
        case 'throttled':
          result.totalThrottled += 1;
          if (res.status === 429) {
            result.http429 += 1;
          } else {
            result.businessThrottled += 1;
          }
          result.maxBackoffMs = Math.max(res.retryAfterMs ?? 0, res.rateLimitResetMs ?? 0);
          result.roundWindowsMs.push(lastDispatch - start);
          return result; // End the burst on its first limit instead of sending more requests.
        case 'rejected':
          result.totalRejected += 1;
          break;
        default:
          result.totalErrors += 1;
          break;
      }
      if (i < count - 1) {
        const waitMs = start + (i + 1) * stepMs - deps.now();
        if (waitMs > 0) {
          await deps.sleep(waitMs);
        }
      }
    }
    result.roundWindowsMs.push(lastDispatch - start);
    if (round < rounds - 1) {
      await deps.sleep(idleMs);
    }
  }
  return result;
}

/** Round an observed backoff up to the StreamingThrottle's nearest sensible bucket. */
function roundUpBackoff(ms: number): number {
  if (ms <= 0) {
    return 0;
  }
  // Round up to the nearest 500 ms.
  return Math.ceil(ms / 500) * 500;
}

// ---------------------------------------------------------------------------
// Findings table
// ---------------------------------------------------------------------------

/**
 * Render a markdown findings table from a bench result, parameterized for the
 * `StreamingThrottle` defaults. Matches the methodology doc's table shape so an
 * operator can paste measured numbers straight in.
 */
export function formatFindingsTable(result: BenchResult, method: 'PUT' | 'PATCH' = 'PUT'): string {
  const rows = result.cadences.map((r) => {
    const clean = r.throttled === 0 && r.rejected === 0 && r.errors === 0 ? '✅ clean' : '⛔ pushed back';
    const rejectDetail =
      r.rejected > 0
        ? typeof r.firstRejectedCode === 'number'
          ? `${r.firstRejectedCode}${r.firstRejectedMsg ? ` (${r.firstRejectedMsg})` : ''}`
          : '(no code)'
        : '—';
    return `| ${r.cadencePerSec} | ${r.actualRequestsPerSec.toFixed(2)} | ${r.elapsedMs} | ${r.sent} | ${r.successes} | ${r.http429} | ${r.businessThrottled} | ${r.rejected} | ${rejectDetail} | ${r.errors} | ${r.firstThrottleAtMs ?? '—'} | ${r.firstRetryAfterMs ?? '—'} | ${r.firstRateLimitResetMs ?? '—'} | ${r.cooldownMs ?? '—'} | ${clean} |`;
  });

  const { burst } = result;
  return [
    '## Card Kit rate-limit bench — findings (#4398)',
    '',
    '> Fill from a live run (`scripts/feishu-cardkit-rate-limit-bench.mts`).',
    '> Numbers below are from this run; defaults feed `StreamingThrottle` (#4414).',
    '> Requests are serial. HTTP latency can prevent reaching the requested cadence.',
    '> Clean measured throughput is a lower bound, not the tenant quota or a universal limit.',
    '',
    '### Sustained sweep',
    '',
    `| cadence (${method}/s) | actual requests/s | elapsed ms | sent | ok | 429 | biz-limit | biz-reject | first reject code | errors | first limit @ms | Retry-After ms | reset ms | cooldown ms | verdict |`,
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `**Max sustained measured without push-back:** ${result.maxSustainedPerSec.toFixed(2)}/s → ` +
      `\`StreamingThrottle.minIntervalMs\` ≈ ${result.suggestedMinIntervalMs || '—'} ms`,
    '',
    '### Burst tolerance',
    '',
    '| rounds | actual dispatch windows ms | sent | applied | 429 | biz-limit | biz-rejected | errors |',
    '|---|---|---|---|---|---|---|---|',
    `| ${burst.rounds} | ${burst.roundWindowsMs.join(', ')} | ${burst.totalSent} | ${burst.totalApplied} | ${burst.http429} | ${burst.businessThrottled} | ${burst.totalRejected} | ${burst.totalErrors} |`,
    '',
    '### Throttle backoff',
    '',
    result.maxObservedBackoffMs > 0
      ? `**Max backoff signal (Retry-After / reset / measured cooldown):** ${result.maxObservedBackoffMs} ms → ` +
        `\`StreamingThrottle.maxBackoffMs\` ≈ ${result.suggestedMaxBackoffMs} ms`
      : '**Backoff:** not observed; retain existing `StreamingThrottle.maxBackoffMs`. Zero is not a recommendation.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Live caller
// ---------------------------------------------------------------------------

/** Options for the live Feishu PUT caller. */
export interface FeishuBenchCallerOptions {
  /** `tenant_access_token` (sent as Bearer). Required. */
  tenantAccessToken: string;
  /** Streaming card id to PUT element content into. */
  cardId: string;
  /** Stable element id to update (e.g. STREAMING_REPLY_ELEMENT_ID from #4396). */
  elementId: string;
  /** Settings PATCH keeps streaming enabled; default is element-content PUT. */
  operation?: 'content' | 'settings';
  /** Base URL (default `https://open.feishu.cn`). */
  baseUrl?: string;
  /** Inject fetch (tests). Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Clock for HTTP-date `Retry-After` parsing; defaults to `Date.now`. */
  now?: () => number;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
}

/**
 * Build the live `BenchCaller` that PUTs element content to a streaming card and
 * classifies the response (status + body code + `Retry-After`). Reuses the
 * verified PUT path + `{content, sequence, uuid}` body shape from
 * `feishu-cardkit-client.ts`; only the header/status handling differs (the bench
 * must see `Retry-After` + tolerate non-zero business codes without throwing).
 */
export function createFeishuBenchCaller(opts: FeishuBenchCallerOptions): BenchCaller {
  if (!opts.tenantAccessToken) {
    throw new Error('createFeishuBenchCaller: tenantAccessToken is required');
  }
  const base = (opts.baseUrl ?? DEFAULT_CARDKIT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('createFeishuBenchCaller: no global fetch available — pass fetchImpl');
  }
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const settings = opts.operation === 'settings';
  const suffix = settings ? '/settings' : `/elements/${encodeURIComponent(opts.elementId)}/content`;
  const url = `${base}${CARDKIT_PATH}/cards/${encodeURIComponent(opts.cardId)}${suffix}`;

  return async (req: BenchRequest): Promise<BenchResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: settings ? 'PATCH' : 'PUT',
        headers: {
          Authorization: `Bearer ${opts.tenantAccessToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          ...(settings ? { settings: JSON.stringify({ config: { streaming_mode: true } }) }
            : { content: req.content }),
          sequence: req.sequence, uuid: randomUuid(),
        }),
        signal: controller.signal,
      });
      const text = await res.text().catch(() => undefined);
      const parsed = safeParseJson(text) as { code?: unknown; msg?: unknown } | undefined;
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'), now());
      const resetRaw = res.headers.get('x-ogw-ratelimit-reset');
      const resetMs = resetRaw && /^\d+(\.\d+)?$/.test(resetRaw.trim())
        ? Math.round(Number(resetRaw) * 1000) : undefined;
      const out: BenchResponse = {
        status: res.status,
        code: typeof parsed?.code === 'number' ? parsed.code : undefined,
        msg: typeof parsed?.msg === 'string' ? parsed.msg : undefined,
      };
      if (typeof retryAfter.ms === 'number') {
        out.retryAfterMs = retryAfter.ms;
      }
      if (typeof retryAfter.raw === 'string') {
        out.retryAfterRaw = retryAfter.raw;
      }
      if (typeof resetMs === 'number' && Number.isFinite(resetMs)) {
        out.rateLimitResetMs = resetMs;
      }
      if (resetRaw) {
        out.rateLimitResetRaw = resetRaw;
      }
      return out;
    } catch (err) {
      // Network/timeout — status 0, no body. The sweep counts these as `error`.
      logger.warn(
        { msg: err instanceof Error ? err.message : String(err) },
        'Card Kit bench: PUT failed (network/timeout)'
      );
      return { status: 0 };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Parse raw response text as JSON, falling back to the raw text / undefined. Mirrors the client. */
function safeParseJson(raw: string | undefined): unknown {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Generate a request uuid (Card Kit echoes it for idempotency debugging). Mirrors the client. */
function randomUuid(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  return c?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
