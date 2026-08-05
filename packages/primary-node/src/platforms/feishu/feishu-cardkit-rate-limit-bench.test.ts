/**
 * Tests for the Card Kit rate-limit bench (#4398 part 2).
 *
 * Two layers:
 *  - Pure logic (`runRateLimitBench`, `classifyOutcome`, `parseRetryAfter`,
 *    `formatFindingsTable`): driven by a scripted mock `BenchCaller` + a fake
 *    clock that advances only on `sleep`, so the sweep/probe/burst sequence is
 *    fully deterministic — no live Feishu, no real timers.
 *  - Live caller (`createFeishuBenchCaller`): `fetchImpl` is injected with fake
 *    Responses (incl. a `Retry-After` header), asserting the PUT shape and the
 *    status/code/Retry-After extraction.
 */

import { describe, it, expect } from 'vitest';
import {
  runRateLimitBench,
  formatFindingsTable,
  classifyOutcome,
  parseRetryAfter,
  createFeishuBenchCaller,
  DEFAULT_BENCH_CONFIG,
  type BenchCaller,
  type BenchResponse,
  type BenchConfig,
  type BenchRequest,
} from './feishu-cardkit-rate-limit-bench.js';

const SUCCESS: BenchResponse = { status: 200, code: 0 };
const throttle429 = (retryAfterMs?: number): BenchResponse => ({
  status: 429,
  ...(retryAfterMs === undefined ? {} : { retryAfterMs, retryAfterRaw: String(retryAfterMs / 1000) }),
});
const bizReject = (code: number, msg = `code ${code}`): BenchResponse => ({
  status: 200,
  code,
  msg,
});

/** A scripted caller: returns `script(index, req)` per call and records every request. */
function scriptedCaller(
  script: (index: number, req: BenchRequest) => BenchResponse
): BenchCaller & { calls: BenchRequest[] } {
  const calls: BenchRequest[] = [];
  let i = 0;
  const fn: BenchCaller = (req) => {
    calls.push(req);
    const res = script(i, req);
    i += 1;
    return Promise.resolve(res);
  };
  return Object.assign(fn, { calls });
}

/** Fake clock: `now()` only advances when `sleep()` is awaited. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

/** Tiny config: one cadence, short duration, so sweep call counts are small + predictable. */
function smallConfig(overrides: Partial<BenchConfig> = {}): BenchConfig {
  return {
    cadencesPerSec: [2],
    cadenceDurationMs: 1_000,
    probeIntervalMs: 1_000,
    probeBudgetMs: 5_000,
    burst: { count: 3, windowMs: 20, rounds: 2, idleMs: 1_000 },
    ...overrides,
  };
}

describe('classifyOutcome', () => {
  it('treats 2xx + code 0 as success', () => {
    expect(classifyOutcome({ status: 200, code: 0 })).toBe('success');
  });
  it('treats HTTP 429 as throttled', () => {
    expect(classifyOutcome({ status: 429 })).toBe('throttled');
  });
  it('treats 200 + non-zero business code as rejected', () => {
    expect(classifyOutcome(bizReject(99991663))).toBe('rejected');
    expect(classifyOutcome(bizReject(300317))).toBe('rejected');
  });
  it('treats network failure (0) and 5xx as error', () => {
    expect(classifyOutcome({ status: 0 })).toBe('error');
    expect(classifyOutcome({ status: 503 })).toBe('error');
  });
});

describe('parseRetryAfter', () => {
  it('parses numeric seconds → ms', () => {
    expect(parseRetryAfter('5', 0)).toEqual({ ms: 5_000, raw: '5' });
    expect(parseRetryAfter('0.5', 0)).toEqual({ ms: 500, raw: '0.5' });
  });
  it('parses an HTTP-date relative to now', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const future = new Date(now + 3_000).toUTCString();
    expect(parseRetryAfter(future, now).ms).toBe(3_000);
  });
  it('returns {} for absent / empty / unparseable', () => {
    expect(parseRetryAfter(null, 0)).toEqual({});
    expect(parseRetryAfter('', 0)).toEqual({});
    expect(parseRetryAfter('   ', 0)).toEqual({});
    expect(parseRetryAfter('soon', 0)).toEqual({ raw: 'soon' });
  });
});

describe('runRateLimitBench — clean sweep', () => {
  it('reports every cadence clean and derives maxSustainedPerSec', async () => {
    const caller = scriptedCaller(() => SUCCESS);
    const { now, sleep } = fakeClock();
    const config: BenchConfig = {
      cadencesPerSec: [2, 10],
      cadenceDurationMs: 1_000,
      probeIntervalMs: 1_000,
      probeBudgetMs: 5_000,
      burst: { count: 2, windowMs: 10, rounds: 1, idleMs: 1_000 },
    };
    const result = await runRateLimitBench({ caller, config, now, sleep });

    expect(result.cadences).toHaveLength(2);
    for (const c of result.cadences) {
      expect(c.throttled).toBe(0);
      expect(c.rejected).toBe(0);
      expect(c.errors).toBe(0);
      expect(c.successes).toBe(c.sent);
      expect(c.firstThrottleAtMs).toBeUndefined();
    }
    // 10/s is the highest fully-clean cadence.
    expect(result.maxSustainedPerSec).toBe(10);
    expect(result.suggestedMinIntervalMs).toBe(100); // ceil(1000/10)
    // No throttle observed → no backoff signal.
    expect(result.maxObservedBackoffMs).toBe(0);
    expect(result.suggestedMaxBackoffMs).toBe(0);
    // Burst all applied.
    expect(result.burst.totalApplied).toBe(result.burst.totalSent);
    expect(result.burst.totalThrottled).toBe(0);
  });

  it('shares one monotonic sequence across the whole run (cadences + burst)', async () => {
    const caller = scriptedCaller(() => SUCCESS);
    const { now, sleep } = fakeClock();
    await runRateLimitBench({ caller, config: smallConfig({ cadencesPerSec: [2] }), now, sleep });
    const seqs = caller.calls.map((r) => r.sequence);
    expect(seqs).toEqual(seqs.slice().sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length); // strictly increasing, no reuse
    expect(seqs[0]).toBe(1);
  });
});

describe('runRateLimitBench — 429 throttle + cooldown', () => {
  it('captures first throttle, Retry-After, and the cooldown to the next success', async () => {
    // call 0: success, call 1: 429 (Retry-After 5s), call 2+: success (the probe).
    const caller = scriptedCaller((idx) => (idx === 1 ? throttle429(5_000) : SUCCESS));
    const { now, sleep } = fakeClock();
    const config = smallConfig({
      cadencesPerSec: [2],   // intervalMs = 500
      cadenceDurationMs: 5_000,
      probeIntervalMs: 1_000,
    });
    const result = await runRateLimitBench({ caller, config, now, sleep });

    const c = result.cadences[0]!;
    expect(c.throttled).toBe(1);
    // call#0 at t=0 (success); sleep 500 → t=500; call#1 at t=500 (429).
    expect(c.firstThrottleAtMs).toBe(500);
    expect(c.firstRetryAfterMs).toBe(5_000);
    // Probe: sleep 1000 → t=1500; call#2 success → cooldown = 1500-500 = 1000.
    expect(c.cooldownMs).toBe(1_000);
    expect(result.maxObservedBackoffMs).toBe(5_000); // Retry-After dominates the cooldown.
    // A throttle occurred → this cadence is not clean → maxSustainedPerSec drops to 0.
    expect(result.maxSustainedPerSec).toBe(0);
    expect(result.suggestedMinIntervalMs).toBe(0);
  });

  it('stops the cadence early once the cooldown is measured (does not run the full duration)', async () => {
    const caller = scriptedCaller((idx) => (idx === 1 ? throttle429(1_000) : SUCCESS));
    const { now, sleep } = fakeClock();
    const config = smallConfig({
      cadencesPerSec: [2],
      cadenceDurationMs: 60_000, // very long; must NOT run this long
      probeIntervalMs: 1_000,
      probeBudgetMs: 5_000,
    });
    const before = Date.now();
    const result = await runRateLimitBench({ caller, config, now, sleep });
    // Fake clock + scripted caller → only 3 calls (success, 429, probe-success); no real waiting.
    expect(caller.calls.length).toBeLessThanOrEqual(
      3 + config.burst.count * config.burst.rounds
    );
    expect(Date.now() - before).toBeLessThan(2_000);
    expect(result.cadences[0]!.cooldownMs).toBe(1_000);
  });
});

describe('runRateLimitBench — business-code rejection (no cooldown probe)', () => {
  it('counts 200+non-zero-code as rejected but does not trigger cooldown probing', async () => {
    // call 0: success, call 1+: business rejection for the rest of the cadence.
    const caller = scriptedCaller((idx) => (idx === 0 ? SUCCESS : bizReject(99991663)));
    const { now, sleep } = fakeClock();
    const config = smallConfig({
      cadencesPerSec: [2],
      cadenceDurationMs: 1_000,
      probeIntervalMs: 1_000,
    });
    const result = await runRateLimitBench({ caller, config, now, sleep });

    const c = result.cadences[0]!;
    expect(c.rejected).toBeGreaterThan(0);
    expect(c.throttled).toBe(0);
    // Rejected does not set throttle/cooldown fields.
    expect(c.firstThrottleAtMs).toBeUndefined();
    expect(c.cooldownMs).toBeUndefined();
    // Not clean (rejected > 0) → excluded from maxSustained.
    expect(result.maxSustainedPerSec).toBe(0);
  });
});

describe('runRateLimitBench — burst test', () => {
  it('tallies applied / throttled / rejected across burst rounds', async () => {
    // Every 3rd burst PUT is throttled.
    const caller = scriptedCaller((idx) => (idx % 3 === 2 ? throttle429() : SUCCESS));
    const { now, sleep } = fakeClock();
    const config = smallConfig({
      cadencesPerSec: [], // skip the sustained sweep; just exercise burst
      burst: { count: 3, windowMs: 10, rounds: 2, idleMs: 1_000 },
    });
    const result = await runRateLimitBench({ caller, config, now, sleep });

    expect(result.burst.rounds).toBe(2);
    expect(result.burst.totalSent).toBe(6); // 3 × 2
    // Indices 2 and 5 throttle → 2 throttled, 4 applied.
    expect(result.burst.totalThrottled).toBe(2);
    expect(result.burst.totalApplied).toBe(4);
  });
});

describe('formatFindingsTable', () => {
  it('renders cadence rows + the StreamingThrottle suggestions', async () => {
    const caller = scriptedCaller(() => SUCCESS);
    const { now, sleep } = fakeClock();
    const result = await runRateLimitBench({
      caller,
      config: smallConfig({ cadencesPerSec: [2, 10] }),
      now,
      sleep,
    });
    const md = formatFindingsTable(result);

    expect(md).toContain('## Card Kit rate-limit bench — findings (#4398)');
    expect(md).toContain('| cadence (PUT/s) |');
    expect(md).toContain('| 2 |');
    expect(md).toContain('| 10 |');
    expect(md).toContain('`StreamingThrottle.minIntervalMs`');
    expect(md).toContain('`StreamingThrottle.maxBackoffMs`');
    expect(md).toContain('Max sustained'); // derived line present
  });
});

describe('createFeishuBenchCaller', () => {
  const CARD_ID = 'card_xyz';
  const ELEMENT_ID = 'streaming_reply_region';
  const TOKEN = 'tenant-token-abc';

  /** Build a minimal fake Response with status, body, and a Retry-After header. */
  function fakeResponse(opts: {
    status: number;
    body?: unknown;
    retryAfter?: string;
  }): Response {
    const headers = new Headers();
    if (opts.retryAfter !== undefined) {
      headers.set('retry-after', opts.retryAfter);
    }
    const text = JSON.stringify(opts.body ?? {});
    const res = {
      status: opts.status,
      ok: opts.status >= 200 && opts.status < 300,
      headers,
      text: () => Promise.resolve(text),
    };
    return res as unknown as Response;
  }

  it('requires a tenant token', () => {
    expect(() =>
      createFeishuBenchCaller({
        tenantAccessToken: '',
        cardId: CARD_ID,
        elementId: ELEMENT_ID,
        fetchImpl: (() => Promise.resolve(fakeResponse({ status: 200, body: { code: 0 } }))) as typeof fetch,
      })
    ).toThrow(/tenantAccessToken/);
  });

  it('PUTs to the element-content path with Bearer auth + {content, sequence, uuid} body', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return Promise.resolve(fakeResponse({ status: 200, body: { code: 0 } }));
    }) as typeof fetch;
    const caller = createFeishuBenchCaller({
      tenantAccessToken: TOKEN,
      cardId: CARD_ID,
      elementId: ELEMENT_ID,
      fetchImpl,
    });

    const res = await caller({ sequence: 7, content: 'hello' });

    expect(res).toEqual({ status: 200, code: 0 });
    expect(captured!.url).toBe(
      `https://open.feishu.cn/open-apis/cardkit/v1/cards/${CARD_ID}/elements/${ELEMENT_ID}/content`
    );
    expect(captured!.init.method).toBe('PUT');
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(captured!.init.body as string) as {
      content: string;
      sequence: number;
      uuid: string;
    };
    expect(body.content).toBe('hello');
    expect(body.sequence).toBe(7);
    expect(typeof body.uuid).toBe('string');
  });

  it('extracts status + body code/msg + Retry-After (seconds) on a 429', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        fakeResponse({
          status: 429,
          body: { code: 0, msg: 'rate limited' },
          retryAfter: '5',
        })
      )) as typeof fetch;
    const caller = createFeishuBenchCaller({
      tenantAccessToken: TOKEN,
      cardId: CARD_ID,
      elementId: ELEMENT_ID,
      fetchImpl,
    });

    const res = await caller({ sequence: 1, content: 'x' });
    expect(res.status).toBe(429);
    expect(res.retryAfterMs).toBe(5_000);
    expect(res.retryAfterRaw).toBe('5');
  });

  it('surfaces a 200 + non-zero business code as code/msg', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        fakeResponse({ status: 200, body: { code: 99991663, msg: 'frequency limit' } })
      )) as typeof fetch;
    const caller = createFeishuBenchCaller({
      tenantAccessToken: TOKEN,
      cardId: CARD_ID,
      elementId: ELEMENT_ID,
      fetchImpl,
    });
    const res = await caller({ sequence: 1, content: 'x' });
    expect(res.status).toBe(200);
    expect(res.code).toBe(99991663);
    expect(res.msg).toBe('frequency limit');
  });

  it('returns status 0 on a network failure (fetch throws)', async () => {
    const fetchImpl = (() => Promise.reject(new Error('connect ECONNREFUSED'))) as typeof fetch;
    const caller = createFeishuBenchCaller({
      tenantAccessToken: TOKEN,
      cardId: CARD_ID,
      elementId: ELEMENT_ID,
      fetchImpl,
    });
    const res = await caller({ sequence: 1, content: 'x' });
    expect(res).toEqual({ status: 0 });
    expect(classifyOutcome(res)).toBe('error');
  });
});

describe('DEFAULT_BENCH_CONFIG', () => {
  it('matches the methodology doc procedure (2 → 20 PUT/s ramp)', () => {
    expect(DEFAULT_BENCH_CONFIG.cadencesPerSec).toEqual([2, 5, 10, 20]);
    expect(DEFAULT_BENCH_CONFIG.burst.count).toBeGreaterThanOrEqual(5);
  });
});
