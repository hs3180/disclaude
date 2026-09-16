/**
 * Card Kit streaming-update rate-limit characterization bench (#4398 / #4208 P1-c).
 *
 * #4398's deliverable is "bench script + findings note". The findings note (the
 * measurement plan + endpoint corrections) landed in #4416
 * (`docs/feishu-cardkit-rate-limit-methodology.md`); this module is the other
 * half — the **bench tooling** that implements that procedure against a live
 * streaming card.
 *
 * What this measures (per the methodology doc):
 *   1. Sustained updates/s before a throttle — drives `StreamingThrottle.minIntervalMs`.
 *   2. Throttle backoff behavior (HTTP 429 + `Retry-After`, observed cooldown) —
 *      drives `maxBackoffMs` + the backoff multiplier.
 *   3. Leading/trailing (burst) tolerance — whether short bursts are smoothed or
 *      dropped — validates the throttle's window shape (#4414).
 *
 * Why a raw-HTTP caller instead of `FeishuCardKitClient`: the client is the right
 * abstraction for production streaming, but it (correctly) throws on non-2xx and
 * does not surface response *headers*. Characterizing 429 backoff needs the
 * `Retry-After` header, and Feishu frequently rate-limits as HTTP 200 + a non-zero
 * business `code` (not 429) — so the bench classifies responses itself. The
 * methodology doc explicitly sanctions "a standalone fetch loop hitting the PUT
 * endpoint directly" for exactly this reason. The caller reuses the verified PUT
 * path + body shape (`{content, sequence, uuid}`) so there is no fiction — only
 * the header/status handling differs from the production client.
 *
 * Testability: the sweep / capture / burst *logic* is pure and dependency-injected
 * (`caller`, `now`, `sleep`), so it is unit-tested with a mock caller + fake clock
 * — no live Feishu, no real timers. The actual measured numbers need a live tenant
 * (`LARKSUITE_CLI_TENANT_ACCESS_TOKEN` + a streaming card); the CLI in
 * `scripts/feishu-cardkit-rate-limit-bench.mts` is what an operator runs to fill
 * the methodology doc's TBD findings table.
 */
import { createLogger } from "../../../../core/dist/index.js";
import { DEFAULT_CARDKIT_BASE_URL } from './feishu-cardkit-client.js';
const logger = createLogger('FeishuCardKitBench');
/**
 * Card Kit API path prefix. Must match `CARDKIT_PATH` in `feishu-cardkit-client.ts`
 * (kept unexported there to avoid widening the client's surface; duplicated here
 * with a cross-reference rather than editing the churning client file).
 */
const CARDKIT_PATH = '/open-apis/cardkit/v1';
/** Defaults match the methodology doc's procedure (start 2/s, ramp to 20/s). */
export const DEFAULT_BENCH_CONFIG = {
    cadencesPerSec: [2, 5, 10, 20],
    cadenceDurationMs: 5_000,
    probeIntervalMs: 1_000,
    probeBudgetMs: 30_000,
    burst: { count: 10, windowMs: 50, rounds: 3, idleMs: 1_000 },
};
// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
/**
 * Classify one response.
 *
 * - `success`  — 2xx and Feishu business code 0.
 * - `throttled` — HTTP 429 (the unambiguous rate-limit signal; triggers cooldown
 *   probing and `Retry-After` capture).
 * - `rejected` — HTTP 200 but a non-zero business code. Feishu rate-limits this
 *   way often, but so do sequence (300317) / permission errors — the bench
 *   records the first code+msg per cadence (`firstRejectedCode`/`firstRejectedMsg`)
 *   so an operator can tell a repeating rate-limit code from a bench bug.
 *   `rejected` does NOT by itself drive the cooldown probe.
 * - `error` — no response (0) or 5xx.
 */
export function classifyOutcome(res) {
    if (res.status === 429) {
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
export function parseRetryAfter(raw, nowMs) {
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
/** Run the full sweep + burst against the injected caller. Pure / side-effect-free apart from caller + sleep. */
export async function runRateLimitBench(deps) {
    const config = deps.config ?? DEFAULT_BENCH_CONFIG;
    const now = deps.now ?? (() => Date.now());
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    let sequence = 0;
    const nextReq = (content) => ({ sequence: ++sequence, content });
    const cadenceResults = [];
    let maxObservedBackoffMs = 0;
    for (const cadence of config.cadencesPerSec) {
        const intervalMs = Math.max(1, Math.round(1000 / cadence));
        const start = now();
        const deadline = start + config.cadenceDurationMs;
        const result = {
            cadencePerSec: cadence,
            sent: 0,
            successes: 0,
            throttled: 0,
            rejected: 0,
            errors: 0,
        };
        let throttled = false;
        // Sweep at the cadence until the deadline, or until we observe + probe a throttle.
        while (now() < deadline) {
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
                if (typeof res.retryAfterMs === 'number') {
                    maxObservedBackoffMs = Math.max(maxObservedBackoffMs, res.retryAfterMs);
                }
                // Probe at a slow cadence until a success to measure the effective cooldown.
                const cooldown = await probeUntilSuccess({
                    caller: deps.caller,
                    nextReq,
                    probeIntervalMs: config.probeIntervalMs,
                    budgetMs: config.probeBudgetMs,
                    throttleAt: now(),
                    now,
                    sleep,
                    onProbe: (r) => {
                        result.sent += 1;
                        tallyCountsOnly(result, r);
                    },
                });
                if (typeof cooldown === 'number') {
                    result.cooldownMs = cooldown;
                    maxObservedBackoffMs = Math.max(maxObservedBackoffMs, cooldown);
                }
                break; // cadence done — we have its throttle + cooldown data
            }
            if (now() < deadline) {
                await sleep(intervalMs);
            }
        }
        logger.info({ cadence, ...result }, 'Card Kit bench: cadence step complete');
        cadenceResults.push(result);
    }
    const burst = await runBurst({ caller: deps.caller, nextReq, config, now, sleep });
    // Highest cadence at which every PUT succeeded (zero throttled/rejected/error).
    let maxSustainedPerSec = 0;
    for (const r of cadenceResults) {
        const clean = r.sent > 0 && r.throttled === 0 && r.rejected === 0 && r.errors === 0;
        if (clean && r.cadencePerSec > maxSustainedPerSec) {
            maxSustainedPerSec = r.cadencePerSec;
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
function contentFor(n) {
    return `bench tick ${n}`;
}
/** Tally a response into a cadence result (sent + outcome-specific counter). */
function tally(result, res) {
    result.sent += 1;
    tallyCountsOnly(result, res);
}
/** Tally outcome counters without bumping `sent` (used for probe calls). */
function tallyCountsOnly(result, res) {
    switch (classifyOutcome(res)) {
        case 'success':
            result.successes += 1;
            break;
        case 'throttled':
            result.throttled += 1;
            break;
        case 'rejected':
            result.rejected += 1;
            break;
        default:
            result.errors += 1;
            break;
    }
}
/**
 * After a throttle, probe at `probeIntervalMs` until a success (or budget exhausted).
 * Returns the elapsed ms from `throttleAt` to the first success, or undefined.
 */
async function probeUntilSuccess(deps) {
    const deadline = deps.throttleAt + deps.budgetMs;
    while (deps.now() < deadline) {
        await deps.sleep(deps.probeIntervalMs);
        const res = await deps.caller(deps.nextReq(contentFor(-1)));
        deps.onProbe?.(res);
        if (classifyOutcome(res) === 'success') {
            return deps.now() - deps.throttleAt;
        }
    }
    return undefined;
}
/** Run the burst test: `rounds` of `count` PUTs spread over `windowMs`, then idle. */
async function runBurst(deps) {
    const { count, windowMs, rounds, idleMs } = deps.config.burst;
    const stepMs = count > 1 ? Math.max(1, Math.round(windowMs / (count - 1))) : 0;
    const result = {
        rounds,
        totalSent: 0,
        totalApplied: 0,
        totalThrottled: 0,
        totalRejected: 0,
    };
    for (let round = 0; round < rounds; round += 1) {
        for (let i = 0; i < count; i += 1) {
            const res = await deps.caller(deps.nextReq(contentFor(result.totalSent)));
            result.totalSent += 1;
            switch (classifyOutcome(res)) {
                case 'success':
                    result.totalApplied += 1;
                    break;
                case 'throttled':
                    result.totalThrottled += 1;
                    break;
                case 'rejected':
                    result.totalRejected += 1;
                    break;
                default:
                    break;
            }
            if (i < count - 1) {
                await deps.sleep(stepMs);
            }
        }
        if (round < rounds - 1) {
            await deps.sleep(idleMs);
        }
    }
    return result;
}
/** Round an observed backoff up to the StreamingThrottle's nearest sensible bucket. */
function roundUpBackoff(ms) {
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
export function formatFindingsTable(result) {
    const rows = result.cadences.map((r) => {
        const clean = r.throttled === 0 && r.rejected === 0 && r.errors === 0 ? '✅ clean' : '⛔ pushed back';
        const rejectDetail = r.rejected > 0
            ? typeof r.firstRejectedCode === 'number'
                ? `${r.firstRejectedCode}${r.firstRejectedMsg ? ` (${r.firstRejectedMsg})` : ''}`
                : '(no code)'
            : '—';
        return `| ${r.cadencePerSec} | ${r.sent} | ${r.successes} | ${r.throttled} | ${r.rejected} | ${rejectDetail} | ${r.errors} | ${r.firstThrottleAtMs ?? '—'} | ${r.firstRetryAfterMs ?? '—'} | ${r.cooldownMs ?? '—'} | ${clean} |`;
    });
    const { burst } = result;
    return [
        '## Card Kit rate-limit bench — findings (#4398)',
        '',
        '> Fill from a live run (`scripts/feishu-cardkit-rate-limit-bench.mts`).',
        '> Numbers below are from this run; defaults feed `StreamingThrottle` (#4414).',
        '',
        '### Sustained sweep',
        '',
        '| cadence (PUT/s) | sent | ok | 429 | biz-reject | first reject code | errors | first 429 @ms | Retry-After ms | cooldown ms | verdict |',
        '|---|---|---|---|---|---|---|---|---|---|---|',
        ...rows,
        '',
        `**Max sustained without push-back:** ${result.maxSustainedPerSec}/s → ` +
            `\`StreamingThrottle.minIntervalMs\` ≈ ${result.suggestedMinIntervalMs || '—'} ms`,
        '',
        '### Burst tolerance',
        '',
        '| rounds | sent | applied | throttled | biz-rejected |',
        '|---|---|---|---|---|',
        `| ${burst.rounds} | ${burst.totalSent} | ${burst.totalApplied} | ${burst.totalThrottled} | ${burst.totalRejected} |`,
        '',
        '### Throttle backoff',
        '',
        `**Max observed backoff (Retry-After / cooldown):** ${result.maxObservedBackoffMs} ms → ` +
            `\`StreamingThrottle.maxBackoffMs\` ≈ ${result.suggestedMaxBackoffMs} ms`,
        '',
    ].join('\n');
}
/**
 * Build the live `BenchCaller` that PUTs element content to a streaming card and
 * classifies the response (status + body code + `Retry-After`). Reuses the
 * verified PUT path + `{content, sequence, uuid}` body shape from
 * `feishu-cardkit-client.ts`; only the header/status handling differs (the bench
 * must see `Retry-After` + tolerate non-zero business codes without throwing).
 */
export function createFeishuBenchCaller(opts) {
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
    const url = `${base}${CARDKIT_PATH}/cards/${encodeURIComponent(opts.cardId)}` +
        `/elements/${encodeURIComponent(opts.elementId)}/content`;
    return async (req) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetchImpl(url, {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${opts.tenantAccessToken}`,
                    'Content-Type': 'application/json; charset=utf-8',
                },
                body: JSON.stringify({ content: req.content, sequence: req.sequence, uuid: randomUuid() }),
                signal: controller.signal,
            });
            const text = await res.text().catch(() => undefined);
            const parsed = safeParseJson(text);
            const retryAfter = parseRetryAfter(res.headers.get('retry-after'), now());
            const out = {
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
            return out;
        }
        catch (err) {
            // Network/timeout — status 0, no body. The sweep counts these as `error`.
            logger.warn({ msg: err instanceof Error ? err.message : String(err) }, 'Card Kit bench: PUT failed (network/timeout)');
            return { status: 0 };
        }
        finally {
            clearTimeout(timer);
        }
    };
}
/** Parse raw response text as JSON, falling back to the raw text / undefined. Mirrors the client. */
function safeParseJson(raw) {
    if (!raw) {
        return undefined;
    }
    try {
        return JSON.parse(raw);
    }
    catch {
        return raw;
    }
}
/** Generate a request uuid (Card Kit echoes it for idempotency debugging). Mirrors the client. */
function randomUuid() {
    const c = globalThis.crypto;
    return c?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
